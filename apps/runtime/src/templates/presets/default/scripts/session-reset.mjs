#!/usr/bin/env node
/**
 * SessionStart hook — reset per-session state files.
 * Ensures skill reminders fire fresh each session.
 */
import { unlinkSync } from 'fs';

const FILES_TO_RESET = [
  '/workspace/.codeck/state/loaded-skills.json',
  '/workspace/.codeck/state/review-marker.json',
  '/workspace/.codeck/state/edit-tracker.json',
];

for (const f of FILES_TO_RESET) {
  try { unlinkSync(f); } catch { /* doesn't exist — fine */ }
}
