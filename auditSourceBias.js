'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('./db');

const args = process.argv.slice(2);

function intArg(flag, fallback) {
  const raw = args.find((arg) => arg.startsWith(`${flag}=`));
  if (!raw) return fallback;
  const value = parseInt(raw.slice(flag.length + 1), 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolFlag(flag) {
  return args.includes(flag);
}

const BATCH_SIZE = Math.max(5, Math.min(40, intArg('--batch', 25)));
const LIMIT = Math.max(1, intArg('--limit', 12258));
const OFFSET = Math.max(0, intArg('--offset', 0));
const MODEL = process.env.SOURCE_BIAS_MODEL || 'claude-haiku-4-5';
const DRY_RUN = boolFlag('--dry-run');
const ONLY_NULL = boolFlag('--only-null');
const ALLOW_DIRECTIONAL_FLIPS = boolFlag('--allow-directional-flips');
const OUTPUT_DIR = path.join(process.cwd(), 'tmp');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `source-bias-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const ALLOWED_BIAS = ['left', 'center_left', 'center', 'center_right', 'right', 'state', 'unknown'];

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`\n🧭 Source Bias Audit`);
  console.log(`   Model:     ${MODEL}`);
  console.log(`   Batch:     ${BATCH_SIZE}`);
  console.log(`   Limit:     ${LIMIT}`);
  console.log(`   Offset:    ${OFFSET}`);
  console.log(`   Null only: ${ONLY_NULL ? 'yes' : 'no'}`);
  console.log(`   Dry run:   ${DRY_RUN ? 'yes' : 'no'}`);
  console.log(`   Dir flips: ${ALLOW_DIRECTIONAL_FLIPS ? 'yes' : 'no'}`);
  console.log(`   Output:    ${OUTPUT_FILE}`);

  const rows = await loadSources();
  console.log(`   Sources loaded: ${rows.length}`);
  if (!rows.length) {
    await pool.end();
    return;
  }

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    console.log(`\n   Batch ${batchNum}: rows ${start + 1}-${start + batch.length}`);
    try {
      const decisions = await classifyBatch(batch);
      const applied = await applyDecisions(batch, decisions);
      updated += applied.updated;
      unchanged += applied.unchanged;
      failed += applied.failed;
      console.log(`   Result: ${applied.updated} updated, ${applied.unchanged} unchanged, ${applied.failed} failed`);
    } catch (err) {
      failed += batch.length;
      console.error(`   Batch failed: ${err.message}`);
      for (const row of batch) {
        appendAudit({
          id: row.id,
          name: row.name,
          site_url: row.site_url,
          previous_bias: row.bias,
          status: 'batch_failed',
          error: err.message
        });
      }
    }
  }

  console.log(`\n✅ Audit complete`);
  console.log(`   Updated:   ${updated}`);
  console.log(`   Unchanged: ${unchanged}`);
  console.log(`   Failed:    ${failed}`);

  await pool.end();
}

async function loadSources() {
  const clauses = [];
  const params = [];

  if (ONLY_NULL) clauses.push('bias IS NULL');

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(LIMIT, OFFSET);

  const { rows } = await pool.query(`
    SELECT
      id,
      name,
      site_url,
      rss_url,
      slug,
      source_type,
      bias
    FROM news_sources
    ${whereSql}
    ORDER BY id ASC
    LIMIT $1
    OFFSET $2
  `, params);

  return rows;
}

async function classifyBatch(batch) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 3200,
    temperature: 0,
    messages: [{
      role: 'user',
      content: buildPrompt(batch)
    }]
  });

  const text = extractText(response);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('Model did not return a JSON array.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Invalid JSON from model: ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Model payload was not an array.');
  }

  return parsed;
}

function buildPrompt(batch) {
  return `You are auditing media-source bias labels in a news database.

Task:
- For each source, assign exactly one label from:
  left, center_left, center, center_right, right, state, unknown

Definitions:
- state: official government ministry, municipal/provincial/national government source, parliament, embassy, military ministry, state information office, or clearly state-controlled/state-owned broadcaster/news agency.
- left / center_left / center / center_right / right: use only for actual news publishers or commentary outlets where a political/media bias label is reasonably inferable from the organization identity.
- unknown: use for non-news institutions, NGOs, museums, event sites, companies, foundations, weather offices, universities, trade bodies, or when political bias cannot be inferred safely.

Rules:
- Be conservative. If uncertain, choose unknown rather than inventing a political lean.
- Do not overuse center for ambiguous local outlets.
- Use state only when the source itself is an official/state outlet, not merely mainstream.
- Judge the source organization, not any one article.
- Return ONLY valid JSON array. No prose.

Output format:
[
  {
    "id": 123,
    "bias": "unknown",
    "confidence": 0.91,
    "reason": "Government ministry site"
  }
]

Sources:
${JSON.stringify(batch.map((row) => ({
  id: row.id,
  name: row.name,
  site_url: row.site_url,
  rss_url: row.rss_url,
  slug: row.slug,
  source_type: row.source_type,
  current_bias: row.bias
})), null, 2)}`;
}

function extractText(response) {
  if (!response || !Array.isArray(response.content)) return '';
  return response.content
    .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
    .join('\n')
    .trim();
}

async function applyDecisions(batch, decisions) {
  const sourceMap = new Map(batch.map((row) => [row.id, row]));
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const decision of decisions) {
    const id = Number(decision && decision.id);
    const row = sourceMap.get(id);
    const bias = typeof decision?.bias === 'string' ? decision.bias.trim().toLowerCase() : '';
    const confidence = Number(decision?.confidence);
    const reason = String(decision?.reason || '').trim().slice(0, 500);
    const minConfidence = requiredConfidence(row.bias, bias);

    if (!row || !ALLOWED_BIAS.includes(bias)) {
      failed += 1;
      appendAudit({
        id,
        status: 'invalid_decision',
        decision
      });
      continue;
    }

    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      unchanged += 1;
      appendAudit({
        id: row.id,
        name: row.name,
        site_url: row.site_url,
        previous_bias: row.bias,
        proposed_bias: bias,
        confidence,
        min_confidence: minConfidence,
        reason,
        status: 'skipped_low_confidence'
      });
      continue;
    }

    if ((row.bias || null) === bias) {
      unchanged += 1;
      appendAudit({
        id: row.id,
        name: row.name,
        site_url: row.site_url,
        previous_bias: row.bias,
        proposed_bias: bias,
        confidence,
        reason,
        status: 'unchanged'
      });
      continue;
    }

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE news_sources SET bias = $1 WHERE id = $2`,
        [bias, row.id]
      );
    }

    updated += 1;
    appendAudit({
      id: row.id,
      name: row.name,
      site_url: row.site_url,
      previous_bias: row.bias,
      new_bias: bias,
      confidence,
      reason,
      status: DRY_RUN ? 'would_update' : 'updated'
    });
  }

  const decidedIds = new Set(decisions.map((decision) => Number(decision?.id)).filter(Number.isFinite));
  for (const row of batch) {
    if (decidedIds.has(row.id)) continue;
    failed += 1;
    appendAudit({
      id: row.id,
      name: row.name,
      site_url: row.site_url,
      previous_bias: row.bias,
      status: 'missing_from_model_output'
    });
  }

  return { updated, unchanged, failed };
}

function requiredConfidence(previousBias, nextBias) {
  if (!nextBias) return 1;
  if (!previousBias) {
    return nextBias === 'state' ? 0.72 : 0.8;
  }
  if (previousBias === nextBias) return 0;

  if (previousBias === 'state' || nextBias === 'state') {
    return 0.88;
  }

  const ideological = new Set(['left', 'center_left', 'center', 'center_right', 'right']);
  if (ideological.has(previousBias) && ideological.has(nextBias)) {
    if (ALLOW_DIRECTIONAL_FLIPS) {
      if (previousBias === 'center' && nextBias !== 'center') {
        return 0.82;
      }
      if ((previousBias === 'center_left' || previousBias === 'center_right') && (nextBias === 'left' || nextBias === 'right' || nextBias === 'center')) {
        return 0.84;
      }
      if ((previousBias === 'left' || previousBias === 'right') && ideological.has(nextBias)) {
        return 0.86;
      }
    }
    if ((previousBias === 'center_left' || previousBias === 'center_right' || previousBias === 'left' || previousBias === 'right') && nextBias === 'center') {
      return 0.94;
    }
    if (previousBias === 'center' && nextBias !== 'center') {
      return 0.92;
    }
    return 0.9;
  }

  return 0.88;
}

function appendAudit(record) {
  fs.appendFileSync(OUTPUT_FILE, `${JSON.stringify(record)}\n`);
}

main().catch(async (err) => {
  console.error(`\n❌ Source bias audit failed: ${err.stack || err.message}`);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
