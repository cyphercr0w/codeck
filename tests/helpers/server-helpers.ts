/**
 * Test helpers for server and API testing
 */
import express, { Express } from 'express';
import request from 'supertest';

/**
 * Create a minimal Express app for testing
 */
export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  return app;
}

/**
 * Make an authenticated request with Bearer token
 */
export function authenticatedRequest(
  app: Express,
  token: string
): request.SuperTest<request.Test> {
  const agent = request(app);
  // Wrap to add Authorization header
  const originalGet = agent.get.bind(agent);
  const originalPost = agent.post.bind(agent);
  const originalPut = agent.put.bind(agent);
  const originalDelete = agent.delete.bind(agent);

  agent.get = (url: string) => originalGet(url).set('Authorization', `Bearer ${token}`);
  agent.post = (url: string) => originalPost(url).set('Authorization', `Bearer ${token}`);
  agent.put = (url: string) => originalPut(url).set('Authorization', `Bearer ${token}`);
  agent.delete = (url: string) => originalDelete(url).set('Authorization', `Bearer ${token}`);

  return agent as any;
}

/**
 * Wait for a condition to be true (polling)
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}
