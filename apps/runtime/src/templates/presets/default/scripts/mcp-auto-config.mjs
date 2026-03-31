#!/usr/bin/env node

/**
 * Elicitation Hook — Auto-fill MCP server configuration from stored env vars.
 *
 * When an MCP server requests configuration, tries to satisfy all fields
 * from /workspace/.codeck/.env. Only responds if ALL fields can be filled.
 * Never blocks — always exit 0.
 */

import fs from 'fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let parsed;
try { parsed = JSON.parse(input); } catch { process.exit(0); }

const serverName = parsed.mcp_server_name;
const requestedSchema = parsed.requested_schema;

if (!serverName || !requestedSchema?.properties) process.exit(0);

try {
  // Parse .env file
  let envVars = {};
  try {
    const envContent = fs.readFileSync('/workspace/.codeck/.env', 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) envVars[key] = value;
    }
  } catch {
    process.exit(0);
  }

  // MCP server name → env var prefix mapping
  const SERVER_PREFIXES = {
    supabase: 'SUPABASE_',
    github: 'GITHUB_',
    stripe: 'STRIPE_',
    vercel: 'VERCEL_',
    aws: 'AWS_',
    slack: 'SLACK_',
    openai: 'OPENAI_',
  };

  const lowerServerName = serverName.toLowerCase();
  const prefix = Object.entries(SERVER_PREFIXES).find(([k]) => lowerServerName.includes(k))?.[1] || '';

  // Try to match each schema field to an env var
  const schemaFields = Object.keys(requestedSchema.properties);
  const filled = {};

  for (const field of schemaFields) {
    const fieldUpper = field.toUpperCase();

    // Try exact match first
    if (envVars[fieldUpper] !== undefined) {
      filled[field] = envVars[fieldUpper];
      continue;
    }

    // Try with server prefix
    if (prefix) {
      const prefixed = prefix + fieldUpper;
      if (envVars[prefixed] !== undefined) {
        filled[field] = envVars[prefixed];
        continue;
      }
    }

    // Try case-insensitive scan over all env vars
    const envKeyLower = Object.keys(envVars).find(k => k.toLowerCase() === fieldUpper.toLowerCase());
    if (envKeyLower) {
      filled[field] = envVars[envKeyLower];
      continue;
    }

    // Try prefix + field partial match
    if (prefix) {
      const envKeyPrefixed = Object.keys(envVars).find(
        k => k.startsWith(prefix) && k.toLowerCase().endsWith(fieldUpper.toLowerCase())
      );
      if (envKeyPrefixed) {
        filled[field] = envVars[envKeyPrefixed];
        continue;
      }
    }

    // Could not fill this field — bail out (pass through to user)
    process.exit(0);
  }

  // All fields filled
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Elicitation',
      action: 'accept',
      content: filled,
    },
  }));
} catch {
  // Never block on error
}

process.exit(0);
