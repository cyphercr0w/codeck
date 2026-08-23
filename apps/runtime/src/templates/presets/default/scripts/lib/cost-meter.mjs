/**
 * cost-meter — real spend from transcripts, not self-reported.
 *
 * The harness used to track `spentUsd` by having the loop update it by hand, so
 * the cost cap only engaged if the run remembered to. This reads the actual
 * token usage the CLI already writes to disk instead.
 *
 * Two facts this relies on, both verified empirically on 2026-07-21 (CLI 2.1.211):
 *   1. Each assistant entry carries `message.model` + `message.usage`.
 *   2. Subagents do NOT write into the main transcript — `isSidechain` is always
 *      false there. They get their own files under `<session-id>/subagents/
 *      agent-*.jsonl`. Summing only the main transcript therefore misses every
 *      delegated token, which is precisely the spend an orchestrator generates.
 *
 * Pricing is per MILLION tokens and is a moving target — override it with
 * `<CODECK>/pricing.json` rather than editing this file.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';

// USD per 1M tokens, {input, output}. Verified 2026-07-15; treat as approximate.
const DEFAULT_PRICING = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Coarse fallbacks so an unrecognised snapshot id still bills something.
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  fable: { input: 10, output: 50 },
};

// Cache reads bill ~0.1x input; 5-minute cache writes ~1.25x; 1-hour ~2x.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

function loadPricing(codeckDir) {
  if (!codeckDir) return DEFAULT_PRICING;
  const p = join(codeckDir, 'pricing.json');
  if (!existsSync(p)) return DEFAULT_PRICING;
  try {
    const custom = JSON.parse(readFileSync(p, 'utf-8'));
    return custom && typeof custom === 'object' ? { ...DEFAULT_PRICING, ...custom } : DEFAULT_PRICING;
  } catch {
    return DEFAULT_PRICING;
  }
}

function rateFor(model, pricing) {
  if (!model || model === '<synthetic>') return null;
  if (pricing[model]) return pricing[model];
  // Longest key first so `claude-opus-4-8` wins over the bare `opus` fallback.
  const key = Object.keys(pricing)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.includes(k));
  return key ? pricing[key] : null;
}

function costOf(usage, rate) {
  if (!usage || !rate) return 0;
  const inp = Number(usage.input_tokens) || 0;
  const out = Number(usage.output_tokens) || 0;
  const cRead = Number(usage.cache_read_input_tokens) || 0;
  const c1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0;
  const c5m = Number(usage.cache_creation?.ephemeral_5m_input_tokens) || 0;
  // Fall back to the flat field when the breakdown is absent, billed as 5m.
  const cWriteFlat = c1h + c5m > 0 ? 0 : Number(usage.cache_creation_input_tokens) || 0;

  const inputUnits =
    inp +
    cRead * CACHE_READ_MULT +
    (c5m + cWriteFlat) * CACHE_WRITE_5M_MULT +
    c1h * CACHE_WRITE_1H_MULT;

  return (inputUnits * rate.input + out * rate.output) / 1_000_000;
}

function scanFile(path, pricing, acc, bucket) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    const model = entry?.message?.model;
    if (!usage || !model) continue;
    const rate = rateFor(model, pricing);
    if (!rate) continue;
    const usd = costOf(usage, rate);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    acc.totalUsd += usd;
    acc.byModel[model] = (acc.byModel[model] || 0) + usd;
    acc[bucket] += usd;
  }
}

/**
 * Aggregate real spend for a session.
 * @param {string} transcriptPath - the hook's `transcript_path` (always the MAIN
 *   session transcript, even when the hook fires inside a subagent).
 * @param {string} [codeckDir] - root holding an optional pricing.json override.
 * @returns {{totalUsd:number, orchestratorUsd:number, subagentUsd:number,
 *            byModel:Object, delegationShare:number, subagentCount:number}}
 */
export function computeSpend(transcriptPath, codeckDir) {
  const acc = { totalUsd: 0, orchestratorUsd: 0, subagentUsd: 0, byModel: {} };
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { ...acc, delegationShare: 0, subagentCount: 0 };
  }
  const pricing = loadPricing(codeckDir);

  scanFile(transcriptPath, pricing, acc, 'orchestratorUsd');

  // Subagent transcripts live in <dir>/<session-id>/subagents/agent-*.jsonl
  const sessionId = basename(transcriptPath).replace(/\.jsonl$/, '');
  const subDir = join(dirname(transcriptPath), sessionId, 'subagents');
  let subagentCount = 0;
  if (existsSync(subDir)) {
    let files = [];
    try {
      files = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      files = [];
    }
    subagentCount = files.length;
    for (const f of files) scanFile(join(subDir, f), pricing, acc, 'subagentUsd');
  }

  return {
    ...acc,
    subagentCount,
    // Share of spend that was actually delegated. A low value on an autonomous
    // run means the orchestrator is doing the work itself.
    delegationShare: acc.totalUsd > 0 ? acc.subagentUsd / acc.totalUsd : 0,
  };
}
