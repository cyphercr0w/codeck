import mdns from 'multicast-dns';
import type { Answer } from 'dns-packet';
import { networkInterfaces } from 'os';

const DOMAIN = 'codeck.local';
let responder: ReturnType<typeof mdns> | null = null;

/**
 * Get the first non-internal, non-Docker IPv4 address (LAN IP).
 * With network_mode: host, this returns the host's actual LAN IP.
 * Falls back to 127.0.0.1 if none found.
 */
function getHostIP(): string {
  const ifaces = networkInterfaces();
  // Prefer non-Docker interfaces (skip 172.x.x.x)
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('172.')) {
        return iface.address;
      }
    }
  }
  // Fallback: any non-internal IPv4
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Start the mDNS responder.
 * Responds to A queries for codeck.local and *.codeck.local
 * with the host's LAN IP address.
 *
 * With network_mode: host (Linux), mDNS packets reach the LAN directly.
 * Without it (bridge mode), packets stay inside Docker — harmless, just ineffective.
 */
export function startMdns(): void {
  if (responder) return;

  try {
    responder = mdns({ reuseAddr: true });

    responder.on('query', (query) => {
      const ip = getHostIP();
      const answers: Answer[] = [];

      for (const q of query.questions) {
        if (q.type === 'A' && (q.name === DOMAIN || q.name.endsWith('.' + DOMAIN))) {
          answers.push({
            name: q.name,
            type: 'A',
            ttl: 120,
            data: ip,
          });
        }
      }

      if (answers.length > 0) {
        responder!.respond({ answers });
      }
    });

    responder.on('error', (err) => {
      // Don't crash on socket errors — log and continue
      console.error(`[mDNS] Socket error: ${(err as Error).message}`);
    });

    const ip = getHostIP();
    console.log(`[mDNS] Responding to *.${DOMAIN} → ${ip}`);
  } catch (err) {
    console.error('[mDNS] Failed to start:', err);
  }
}

export function stopMdns(): void {
  if (responder) {
    responder.destroy();
    responder = null;
  }
}

export function getLanIP(): string {
  return getHostIP();
}
