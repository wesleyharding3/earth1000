// ═══════════════════════════════════════════════════════════════════════════
// editorialRuleMiner — Layer 3 of the editor-preferences stack.
//
// Reads editor_events, extracts repeatable patterns via SQL aggregation,
// then hands the top patterns to Claude Haiku for natural-language
// synthesis. Upserts into editorial_rules by stable rule_key so re-mining
// updates confidence without duplicating.
//
// Runs as a standalone script (node editorialRuleMiner.js) and is also
// importable for a cron trigger.
//
// Pattern families extracted (pass 1, deterministic):
//   A. importance shifts grouped by primary_category
//      "When thread.primary_category = 'sports', editor demotes
//       importance by avg -2.3 (n=8, 90% consistent)"
//   B. category remaps
//      "thread.primary_category is frequently changed from 'politics'
//       to 'geopolitics' (12/15 = 80%)"
//   C. keyword removals / additions
//      "keywords often stripped from threads: {regime, breaking, exclusive}
//       (≥4 removals each)"
//   D. status demotions (active → dormant)
//   E. delete-by-signature  (category + low article_count + single source)
//   F. merge co-occurrence (which categories tend to merge together)
//
// Pass 2 (synthesis, one Haiku call) takes the winning patterns and
// writes concise rule_text lines for each.
// ═══════════════════════════════════════════════════════════════════════════

// Cap this cron's share of Postgres connections BEFORE db.js loads.
// Without this it defaults to DB_POOL_MAX=60. Mining work is mostly
// Anthropic Haiku calls with sequential SQL upserts; 3 is plenty.
process.env.DB_POOL_MAX = "3";

require('dotenv').config();
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const pool = require('./db');

// ──────────────────────────────────────────────────────────────────────────
// Tunables
// ──────────────────────────────────────────────────────────────────────────
const LOOKBACK_DAYS   = parseInt(process.env.RULE_MINER_LOOKBACK_DAYS || '60', 10);
const MIN_SAMPLES     = parseInt(process.env.RULE_MINER_MIN_SAMPLES   || '3', 10);
const MIN_CONFIDENCE  = parseFloat(process.env.RULE_MINER_MIN_CONFIDENCE || '0.6');
const MAX_RULES_OUT   = parseInt(process.env.RULE_MINER_MAX_RULES     || '40', 10);
const HAIKU_MODEL     = process.env.RULE_MINER_MODEL                  || 'claude-haiku-4-5';
const DRY_RUN         = process.env.RULE_MINER_DRY_RUN === '1';

// Stable rule_key so re-mining upserts instead of duplicates.
function ruleKey(parts) {
  const s = parts.map(p => String(p ?? '')).join('|');
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function pct(n, d) { return d ? n / d : 0; }

// ──────────────────────────────────────────────────────────────────────────
// Pattern extractors
// Each returns an array of { rule_key, entity_type, scope, pattern,
// confidence, sample_count, last_seen_at, summary } — `summary` is fed
// to Haiku for natural-language rewriting.
// ──────────────────────────────────────────────────────────────────────────

// A. Importance shifts by category
async function mineImportanceShifts(db) {
  const { rows } = await db.query(`
    SELECT
      entity_type,
      before_state->>'primary_category' AS category,
      COUNT(*)                                                  AS samples,
      AVG((after_state->>'importance')::float -
          (before_state->>'importance')::float)                 AS avg_delta,
      STDDEV_POP((after_state->>'importance')::float -
                 (before_state->>'importance')::float)          AS stdev_delta,
      MAX(created_at)                                           AS last_seen
    FROM editor_events
    WHERE event_type IN ('thread.update','timeline.update')
      AND diff ? 'importance'
      AND before_state->>'primary_category' IS NOT NULL
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, category
    HAVING COUNT(*) >= $2
  `, [LOOKBACK_DAYS, MIN_SAMPLES]);

  const out = [];
  for (const r of rows) {
    const delta = parseFloat(r.avg_delta);
    if (Math.abs(delta) < 0.5) continue; // too small to matter
    // Confidence = 1 - (stdev / |delta|), clamped; tight distribution → high conf
    const sd = parseFloat(r.stdev_delta || 0);
    const conf = Math.max(0, Math.min(1, 1 - sd / (Math.abs(delta) + 0.01)));
    if (conf < MIN_CONFIDENCE) continue;
    const direction = delta < 0 ? 'demote' : 'promote';
    out.push({
      rule_key: ruleKey(['importance', r.entity_type, r.category, direction]),
      entity_type: r.entity_type,
      scope: r.category,
      pattern: {
        kind: 'importance_shift',
        field: 'importance',
        scope_field: 'primary_category',
        scope_value: r.category,
        direction,
        avg_delta: Number(delta.toFixed(2)),
      },
      confidence: Number(conf.toFixed(3)),
      sample_count: parseInt(r.samples, 10),
      last_seen_at: r.last_seen,
      summary: `${r.entity_type} with primary_category="${r.category}" → editor ${direction}s importance by avg ${delta.toFixed(1)} (n=${r.samples}, conf=${conf.toFixed(2)})`,
    });
  }
  return out;
}

// B. Category remaps (X → Y consistently)
async function mineCategoryRemaps(db) {
  const { rows } = await db.query(`
    SELECT
      entity_type,
      before_state->>'primary_category' AS before_cat,
      after_state->>'primary_category'  AS after_cat,
      COUNT(*) AS samples,
      MAX(created_at) AS last_seen
    FROM editor_events
    WHERE event_type IN ('thread.update','timeline.update')
      AND diff ? 'primary_category'
      AND before_state->>'primary_category' IS NOT NULL
      AND after_state->>'primary_category'  IS NOT NULL
      AND before_state->>'primary_category' <> after_state->>'primary_category'
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, before_cat, after_cat
    HAVING COUNT(*) >= $2
  `, [LOOKBACK_DAYS, MIN_SAMPLES]);

  // Per-source totals for confidence denominator
  const { rows: totals } = await db.query(`
    SELECT entity_type,
           before_state->>'primary_category' AS before_cat,
           COUNT(*) AS n
    FROM editor_events
    WHERE event_type IN ('thread.update','timeline.update')
      AND diff ? 'primary_category'
      AND before_state->>'primary_category' IS NOT NULL
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, before_cat
  `, [LOOKBACK_DAYS]);
  const totMap = new Map(totals.map(t => [`${t.entity_type}|${t.before_cat}`, parseInt(t.n, 10)]));

  const out = [];
  for (const r of rows) {
    const total = totMap.get(`${r.entity_type}|${r.before_cat}`) || r.samples;
    const conf = pct(parseInt(r.samples, 10), total);
    if (conf < MIN_CONFIDENCE) continue;
    out.push({
      rule_key: ruleKey(['category_remap', r.entity_type, r.before_cat, r.after_cat]),
      entity_type: r.entity_type,
      scope: r.before_cat,
      pattern: {
        kind: 'category_remap',
        field: 'primary_category',
        from: r.before_cat,
        to: r.after_cat,
      },
      confidence: Number(conf.toFixed(3)),
      sample_count: parseInt(r.samples, 10),
      last_seen_at: r.last_seen,
      summary: `${r.entity_type} primary_category: "${r.before_cat}" → "${r.after_cat}" (${r.samples}/${total} = ${(conf*100).toFixed(0)}%)`,
    });
  }
  return out;
}

// C. Keyword removals & additions — per token across all keyword diffs
async function mineKeywordChanges(db) {
  const { rows } = await db.query(`
    SELECT entity_type, diff->'keywords' AS kw_diff, created_at
    FROM editor_events
    WHERE event_type IN ('thread.update','timeline.update')
      AND diff ? 'keywords'
      AND created_at > NOW() - ($1 || ' days')::interval
  `, [LOOKBACK_DAYS]);

  const removed = new Map();  // key: `${entity_type}|${token}` → {count, last_seen}
  const added   = new Map();

  for (const r of rows) {
    const d = r.kw_diff;
    if (!Array.isArray(d) || d.length !== 2) continue;
    const before = new Set((d[0] || []).map(s => String(s).toLowerCase()));
    const after  = new Set((d[1] || []).map(s => String(s).toLowerCase()));
    for (const b of before) {
      if (!after.has(b)) {
        const k = `${r.entity_type}|${b}`;
        const cur = removed.get(k) || { count: 0, last_seen: r.created_at };
        cur.count++; cur.last_seen = r.created_at;
        removed.set(k, cur);
      }
    }
    for (const a of after) {
      if (!before.has(a)) {
        const k = `${r.entity_type}|${a}`;
        const cur = added.get(k) || { count: 0, last_seen: r.created_at };
        cur.count++; cur.last_seen = r.created_at;
        added.set(k, cur);
      }
    }
  }

  const out = [];
  for (const [k, v] of removed) {
    if (v.count < MIN_SAMPLES) continue;
    const [entity_type, token] = k.split('|');
    out.push({
      rule_key: ruleKey(['kw_remove', entity_type, token]),
      entity_type,
      scope: token,
      pattern: { kind: 'keyword_remove', token },
      confidence: 1.0, // strength is in count, not split
      sample_count: v.count,
      last_seen_at: v.last_seen,
      summary: `${entity_type}: keyword "${token}" removed ${v.count}x — editor dislikes this word`,
    });
  }
  for (const [k, v] of added) {
    if (v.count < MIN_SAMPLES) continue;
    const [entity_type, token] = k.split('|');
    out.push({
      rule_key: ruleKey(['kw_add', entity_type, token]),
      entity_type,
      scope: token,
      pattern: { kind: 'keyword_add', token },
      confidence: 1.0,
      sample_count: v.count,
      last_seen_at: v.last_seen,
      summary: `${entity_type}: keyword "${token}" added ${v.count}x — editor wants this word present`,
    });
  }
  return out;
}

// D. Status transitions (active → dormant, etc.)
async function mineStatusTransitions(db) {
  const { rows } = await db.query(`
    SELECT entity_type,
           before_state->>'primary_category' AS category,
           before_state->>'status' AS from_status,
           after_state->>'status'  AS to_status,
           COUNT(*) AS samples,
           MAX(created_at) AS last_seen
    FROM editor_events
    WHERE event_type IN ('thread.update','timeline.update')
      AND diff ? 'status'
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, category, from_status, to_status
    HAVING COUNT(*) >= $2
  `, [LOOKBACK_DAYS, MIN_SAMPLES]);

  return rows.map(r => ({
    rule_key: ruleKey(['status', r.entity_type, r.category || '_any', r.from_status, r.to_status]),
    entity_type: r.entity_type,
    scope: r.category || null,
    pattern: {
      kind: 'status_transition',
      from: r.from_status,
      to: r.to_status,
      scope_field: 'primary_category',
      scope_value: r.category,
    },
    confidence: 1.0,
    sample_count: parseInt(r.samples, 10),
    last_seen_at: r.last_seen,
    summary: `${r.entity_type}${r.category ? ` (${r.category})` : ''}: editor moves status "${r.from_status}" → "${r.to_status}" (n=${r.samples})`,
  }));
}

// E. Deletion signatures — what kind of entities get deleted?
async function mineDeletionPatterns(db) {
  const { rows } = await db.query(`
    SELECT entity_type,
           before_state->>'primary_category' AS category,
           COUNT(*) AS samples,
           AVG((before_state->>'article_count')::float) AS avg_articles,
           MAX(created_at) AS last_seen
    FROM editor_events
    WHERE event_type IN ('thread.delete','timeline.delete')
      AND before_state IS NOT NULL
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, category
    HAVING COUNT(*) >= $2
  `, [LOOKBACK_DAYS, MIN_SAMPLES]);

  return rows.map(r => ({
    rule_key: ruleKey(['delete', r.entity_type, r.category || '_any']),
    entity_type: r.entity_type,
    scope: r.category || null,
    pattern: {
      kind: 'deletion_pattern',
      scope_field: 'primary_category',
      scope_value: r.category,
      avg_articles: Number(parseFloat(r.avg_articles || 0).toFixed(1)),
    },
    confidence: 1.0,
    sample_count: parseInt(r.samples, 10),
    last_seen_at: r.last_seen,
    summary: `${r.entity_type}: editor deletes ${r.category || 'uncategorized'} entities (avg ${parseFloat(r.avg_articles||0).toFixed(1)} articles, n=${r.samples})`,
  }));
}

// F. Merge co-occurrence — which categories get merged together?
async function mineMergePatterns(db) {
  const { rows } = await db.query(`
    SELECT entity_type,
           before_state->>'primary_category' AS target_cat,
           COUNT(*) AS samples,
           AVG(jsonb_array_length(COALESCE(context->'source_ids','[]'::jsonb)))::float AS avg_sources,
           MAX(created_at) AS last_seen
    FROM editor_events
    WHERE event_type IN ('thread.merge','timeline.merge')
      AND before_state->>'primary_category' IS NOT NULL
      AND created_at > NOW() - ($1 || ' days')::interval
    GROUP BY entity_type, target_cat
    HAVING COUNT(*) >= $2
  `, [LOOKBACK_DAYS, MIN_SAMPLES]);

  return rows.map(r => ({
    rule_key: ruleKey(['merge', r.entity_type, r.target_cat]),
    entity_type: r.entity_type,
    scope: r.target_cat,
    pattern: {
      kind: 'merge_pattern',
      scope_field: 'primary_category',
      scope_value: r.target_cat,
      avg_sources: Number((r.avg_sources || 0).toFixed(1)),
    },
    confidence: 1.0,
    sample_count: parseInt(r.samples, 10),
    last_seen_at: r.last_seen,
    summary: `${r.entity_type} (${r.target_cat}): editor merges duplicates aggressively (${r.samples} merges, ~${(r.avg_sources||0).toFixed(1)} sources each)`,
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// Pass 2: Haiku synthesis — rewrite raw pattern summaries as concise
// editorial rules ready for prompt injection.
// ──────────────────────────────────────────────────────────────────────────
async function synthesizeRuleTexts(patterns) {
  if (!patterns.length) return [];
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[ruleMiner] ANTHROPIC_API_KEY missing — using raw summaries as rule_text');
    return patterns.map(p => ({ ...p, rule_text: p.summary }));
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are distilling a newsroom editor's observed behavior into short editorial rules that another AI will follow when classifying news threads and timelines.

For each observation below, rewrite it as ONE concise rule in the imperative voice (15 words max). The rule should tell a downstream classifier what to do, not describe what the editor did.

GOOD: "Classify threads about regulatory agencies as 'policy' not 'politics'."
GOOD: "Do not include 'breaking' or 'exclusive' in keyword arrays."
BAD:  "The editor tends to change politics to policy 12 times."

Return ONLY valid JSON: an array of objects [{ "index": N, "rule_text": "..." }, ...], one per observation. Keep the same order.

OBSERVATIONS:
${patterns.map((p, i) => `${i}. ${p.summary}`).join('\n')}`;

  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content[0].text;
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');
    const arr = JSON.parse(match[0]);
    const byIdx = new Map(arr.map(x => [x.index, x.rule_text]));
    return patterns.map((p, i) => ({ ...p, rule_text: byIdx.get(i) || p.summary }));
  } catch (err) {
    console.warn('[ruleMiner] Haiku synthesis failed, falling back to raw summaries:', err.message);
    return patterns.map(p => ({ ...p, rule_text: p.summary }));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Upsert into editorial_rules
// ──────────────────────────────────────────────────────────────────────────
async function upsertRules(db, rules) {
  if (DRY_RUN) {
    console.log('[ruleMiner] DRY_RUN=1 — not persisting. Rules that would be written:');
    for (const r of rules) {
      console.log(`  [${r.entity_type}] ${r.rule_text}  (conf=${r.confidence}, n=${r.sample_count})`);
    }
    return { upserted: 0, dry_run: true };
  }
  let upserted = 0;
  for (const r of rules) {
    await db.query(`
      INSERT INTO editorial_rules
        (rule_key, entity_type, scope, rule_text, pattern, confidence,
         sample_count, last_seen_at, last_mined_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (rule_key) DO UPDATE SET
        rule_text     = EXCLUDED.rule_text,
        pattern       = EXCLUDED.pattern,
        confidence    = EXCLUDED.confidence,
        sample_count  = EXCLUDED.sample_count,
        last_seen_at  = EXCLUDED.last_seen_at,
        last_mined_at = NOW()
    `, [
      r.rule_key, r.entity_type, r.scope || null, r.rule_text,
      JSON.stringify(r.pattern), r.confidence, r.sample_count, r.last_seen_at,
    ]);
    upserted++;
  }
  return { upserted, dry_run: false };
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────────
async function run({ db = pool } = {}) {
  console.log(`[ruleMiner] start · lookback=${LOOKBACK_DAYS}d min_samples=${MIN_SAMPLES} min_conf=${MIN_CONFIDENCE}`);

  // Check event pool size — bail early if nothing to mine
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*) AS n FROM editor_events WHERE created_at > NOW() - ($1 || ' days')::interval`,
    [LOOKBACK_DAYS]);
  const eventCount = parseInt(countRows[0].n, 10);
  console.log(`[ruleMiner] ${eventCount} events in lookback window`);
  if (eventCount < MIN_SAMPLES) {
    console.log(`[ruleMiner] below MIN_SAMPLES=${MIN_SAMPLES}; skipping mine`);
    return { event_count: eventCount, rules_written: 0, skipped: true };
  }

  // Pass 1: extract raw patterns
  const extractors = [
    mineImportanceShifts, mineCategoryRemaps, mineKeywordChanges,
    mineStatusTransitions, mineDeletionPatterns, mineMergePatterns,
  ];
  let patterns = [];
  for (const fn of extractors) {
    try {
      const found = await fn(db);
      console.log(`[ruleMiner] ${fn.name}: ${found.length} patterns`);
      patterns = patterns.concat(found);
    } catch (err) {
      console.error(`[ruleMiner] ${fn.name} failed:`, err.message);
    }
  }

  // Rank by (confidence * log(samples)) and cap
  patterns.sort((a, b) =>
    (b.confidence * Math.log(b.sample_count + 1)) -
    (a.confidence * Math.log(a.sample_count + 1)));
  patterns = patterns.slice(0, MAX_RULES_OUT);

  if (!patterns.length) {
    console.log('[ruleMiner] no patterns met thresholds');
    return { event_count: eventCount, rules_written: 0 };
  }

  // Pass 2: synthesize natural-language rule_text
  const rules = await synthesizeRuleTexts(patterns);

  // Persist
  const { upserted, dry_run } = await upsertRules(db, rules);
  console.log(`[ruleMiner] done · ${upserted} rule(s) upserted${dry_run ? ' (dry run)' : ''}`);
  return { event_count: eventCount, rules_written: upserted, dry_run };
}

// Expose rule-loading helper for Layer 4
async function loadActiveRules(db, { entityType, limit = 20 } = {}) {
  const { rows } = await db.query(`
    SELECT rule_key, entity_type, scope,
           COALESCE(override_text, rule_text) AS rule_text,
           confidence, sample_count
    FROM editorial_rules
    WHERE enabled = TRUE
      AND (entity_type = $1 OR entity_type = 'both')
    ORDER BY confidence DESC, sample_count DESC
    LIMIT $2
  `, [entityType, limit]);
  return rows;
}

module.exports = { run, loadActiveRules };

// CLI
if (require.main === module) {
  run()
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(err => { console.error('[ruleMiner] fatal:', err); process.exit(1); });
}
