#!/usr/bin/env node
/**
 * PostToolUse hook — Suggest /compact when tool call count is high.
 * Tracks tool calls in a counter file. After 50 calls, adds a reminder.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";

const COUNTER_FILE = "/workspace/.codeck/state/tool-call-counter.json";
const THRESHOLD = 50;
const REMINDER_INTERVAL = 20; // remind every 20 calls after threshold

let input = "";
for await (const chunk of process.stdin) input += chunk;

try {
  let count = 0;
  if (existsSync(COUNTER_FILE)) {
    try {
      count = JSON.parse(readFileSync(COUNTER_FILE, "utf-8")).count || 0;
    } catch { count = 0; }
  }

  count++;
  writeFileSync(COUNTER_FILE, JSON.stringify({ count, ts: Date.now() }));

  if (count >= THRESHOLD && (count - THRESHOLD) % REMINDER_INTERVAL === 0) {
    console.log(JSON.stringify({
      message: `Context optimization: ${count} tool calls this session. Consider running /compact to free up context space.`,
    }));
  }
} catch {
  process.exit(0);
}
