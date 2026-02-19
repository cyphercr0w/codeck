#!/usr/bin/env node
// Codeck mDNS Advertiser — Host-side (Windows/macOS)
//
// Uses multicast-dns with reuseAddr: true to coexist with other mDNS listeners
// (Brave, Steam, svchost, avahi, etc.) — unlike @homebridge/ciao which needs
// exclusive access to port 5353.
//
// This makes codeck.local and *.codeck.local resolvable from any device
// on the LAN. Also manages the local hosts file so port subdomains work
// on the host machine itself.
//
// Only needed on Windows/macOS where Docker can't broadcast mDNS.
// On Linux, use docker-compose.lan.yml instead (network_mode: host).
//
// Usage: node scripts/mdns-advertiser.cjs

const mdns = require('multicast-dns');
const dnsPacket = require('dns-packet');
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const os = require('os');

const path = require('path');

const DOMAIN = 'codeck.local';
const PORT_POLL_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 30000;
const HOSTS_MARKER_START = '# codeck-ports-start';
const HOSTS_MARKER_END = '# codeck-ports-end';

// Daemon port for API polling — CLI passes as argv[2] (for Windows elevation)
// or via env var, defaults to 80
const CODECK_PORT = process.argv[2] || process.env.CODECK_DAEMON_PORT || process.env.CODECK_PORT || '80';

const HEARTBEAT_PATH = path.join(os.tmpdir(), 'codeck-mdns.heartbeat');

const HOSTS_PATH = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
  : '/etc/hosts';

function getLanIP() {
  const ifaces = os.networkInterfaces();
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

function fetchPorts() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${CODECK_PORT}/api/ports`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

// --- Hosts file management ---
let lastHostsError = false;

function updateHostsFile(ports) {
  try {
    const content = fs.readFileSync(HOSTS_PATH, 'utf-8');
    // Always include codeck.local itself + any port subdomains
    const lines = [`127.0.0.1 ${DOMAIN}`];
    for (const p of ports) {
      lines.push(`127.0.0.1 ${p}.${DOMAIN}`);
    }
    const newBlock = `${HOSTS_MARKER_START}\n${lines.join('\n')}\n${HOSTS_MARKER_END}`;

    let newContent;
    const startIdx = content.indexOf(HOSTS_MARKER_START);
    const endIdx = content.indexOf(HOSTS_MARKER_END);

    if (startIdx !== -1 && endIdx !== -1) {
      newContent = content.substring(0, startIdx) + newBlock + content.substring(endIdx + HOSTS_MARKER_END.length);
    } else {
      newContent = content.trimEnd() + '\n' + newBlock + '\n';
    }

    if (newContent !== content) {
      fs.writeFileSync(HOSTS_PATH, newContent, 'utf-8');
      const all = [DOMAIN, ...ports.map(p => `${p}.${DOMAIN}`)];
      console.log(`[hosts] Updated: ${all.join(', ')}`);
    }
    lastHostsError = false;
  } catch (err) {
    if (!lastHostsError) {
      console.error(`[hosts] Cannot update: ${err.message} (run as admin for hosts file management)`);
      lastHostsError = true;
    }
  }
}

function cleanupHostsFile() {
  try {
    const content = fs.readFileSync(HOSTS_PATH, 'utf-8');
    const startIdx = content.indexOf(HOSTS_MARKER_START);
    const endIdx = content.indexOf(HOSTS_MARKER_END);
    if (startIdx !== -1 && endIdx !== -1) {
      const newContent = content.substring(0, startIdx) + content.substring(endIdx + HOSTS_MARKER_END.length);
      fs.writeFileSync(HOSTS_PATH, newContent.replace(/\n{3,}/g, '\n\n'), 'utf-8');
      console.log('[hosts] Cleaned up port entries');
    }
  } catch (_) {}
}

// --- mDNS responder (raw multicast-dns with reuseAddr) ---
let lanIP = getLanIP();
const responder = mdns({ reuseAddr: true, interface: lanIP });

responder.on('query', (query, rinfo) => {
  const ip = getLanIP();
  const answers = [];

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
    const isUnicast = rinfo.port !== 5353;
    // Always send multicast mDNS response
    responder.respond({ answers });
    // For unicast queries (Android sends DNS-style queries to port 5353),
    // craft a proper DNS response with matching query ID + question section
    if (isUnicast) {
      const buf = dnsPacket.encode({
        id: query.id,
        type: 'response',
        flags: dnsPacket.AUTHORITATIVE_ANSWER,
        questions: query.questions,
        answers: answers,
      });
      unicastSocket.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    }
  }
});

responder.on('error', (err) => {
  // Don't crash on socket errors — log and continue
  console.error(`[mDNS] Socket error: ${err.message}`);
});

// Separate UDP socket for unicast DNS responses (not through multicast-dns lib)
const unicastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

console.log(`[Codeck mDNS] ${DOMAIN} → ${lanIP} (${process.platform}, port ${CODECK_PORT})`);
console.log(`[Codeck mDNS] Press Ctrl+C to stop`);

// Write codeck.local to hosts file immediately on startup
updateHostsFile([]);

// --- Proactive mDNS announcements ---
// Send unsolicited mDNS responses so LAN devices cache the record
// without needing their queries to reach us (works around routers
// that don't forward multicast symmetrically).
function announce() {
  const ip = getLanIP();
  responder.respond({
    answers: [{
      name: DOMAIN,
      type: 'A',
      ttl: 120,
      data: ip,
      flush: true,
    }],
  });
}

// Announce on startup (3 times rapidly per mDNS spec), then every 60s
setTimeout(announce, 500);
setTimeout(announce, 1500);
setTimeout(announce, 3000);
const announceInterval = setInterval(announce, 60000);

// --- Port polling (for hosts file + logging) ---
let lastPortsJson = '[]';

async function syncPorts() {
  try {
    const ports = await fetchPorts();
    const portsJson = JSON.stringify(ports.sort());
    if (portsJson === lastPortsJson) return;
    lastPortsJson = portsJson;

    for (const port of ports) {
      console.log(`[mDNS] + ${port}.${DOMAIN}`);
    }

    updateHostsFile(ports);
  } catch {}
}

setInterval(syncPorts, PORT_POLL_INTERVAL);
setTimeout(syncPorts, 2000);

// --- IP change detection ---
// Re-check the host IP every 30s; if it changes (e.g., WiFi switch),
// update lanIP and re-announce. The multicast socket stays bound to the
// original interface — a full restart is needed for interface rebinding.
setInterval(() => {
  const currentIP = getLanIP();
  if (currentIP !== lanIP) {
    const oldIP = lanIP;
    lanIP = currentIP;
    console.log(`[mDNS] IP changed: ${oldIP} → ${lanIP}`);
    announce();
  }
}, 30000);

// --- Heartbeat (so CLI can detect if advertiser has crashed) ---
function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_PATH, String(Date.now()), 'utf-8');
  } catch {}
}
writeHeartbeat();
const heartbeatInterval = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);

// --- Shutdown ---
function shutdown() {
  clearInterval(announceInterval);
  clearInterval(heartbeatInterval);
  cleanupHostsFile();
  try { fs.unlinkSync(HEARTBEAT_PATH); } catch {}
  unicastSocket.close();
  responder.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
