/**
 * Test helpers for WebSocket testing
 */
import WebSocket from 'ws';

export interface MockWebSocketClient {
  ws: WebSocket;
  messages: any[];
  close: () => void;
  send: (data: any) => void;
  waitForMessage: (timeout?: number) => Promise<any>;
}

/**
 * Create a mock WebSocket client for testing
 */
export async function createMockWebSocketClient(
  url: string,
  token?: string
): Promise<MockWebSocketClient> {
  const wsUrl = token ? `${url}?token=${token}` : url;
  const ws = new WebSocket(wsUrl);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (data) => {
    try {
      messages.push(JSON.parse(data.toString()));
    } catch {
      messages.push(data.toString());
    }
  });

  return {
    ws,
    messages,
    close: () => ws.close(),
    send: (data: any) => ws.send(JSON.stringify(data)),
    waitForMessage: (timeout = 1000) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timeout waiting for WebSocket message'));
        }, timeout);

        const checkMessages = () => {
          if (messages.length > 0) {
            clearTimeout(timer);
            resolve(messages.shift());
          } else {
            setTimeout(checkMessages, 10);
          }
        };
        checkMessages();
      });
    },
  };
}

/**
 * Simulate a series of WebSocket messages
 */
export async function simulateWebSocketMessages(
  client: MockWebSocketClient,
  messages: any[],
  delay = 100
): Promise<void> {
  for (const msg of messages) {
    client.send(msg);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
