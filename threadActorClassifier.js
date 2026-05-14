/**
 * threadActorClassifier.js — LLM-powered actor classification for story_threads.
 *
 * Why this exists: the prior signal-only path (nationDesignations.js) populated
 * primary_nations / secondary_nations purely from article_locations mention
 * counts with a noise floor. That captured only countries explicitly NAMED in
 * the article corpus and missed every latent geopolitical actor — i.e. the
 * stakes a human reader brings to the story from world knowledge.
 *
 * Concrete failure modes the signal path produced:
 *   • "Beijing condemns Paraguay Taiwan visit"   → [CN]            (no PY, no TW, no US)
 *   • "Iran calls US war conduct principal..."    → [IR]            (no US, no IL, no SA/AE/TR/FR/GB/RU/DE)
 *   • "Trump says US no longer needs NATO"        → [RU, US]        (no NATO members, no UA)
 *
 * This module replaces that path. It loads a focused per-thread evidence pack
 * (title + top N articles) and asks Claude to enumerate every country with a
 * material stake — including inferred actors via alliance, treaty obligation,
 * regional rivalry, or economic exposure. Inference is the entire point: this
 * is the layer that supplies the world knowledge the article corpus alone
 * can't.
 *
 * Output is written back to the existing primary_nations / secondary_nations
 * columns. No schema change. last_audited_at is bumped so we can find stale
 * classifications.
 *
 * Usage as a library:
 *   const { classifyAndPersist } = require('./threadActorClassifier');
 *   await classifyAndPersist({ pool, anthropic, threadId });
 *
 * Usage as a CLI:
 *   node threadActorClassifier.js --thread=10744          # one thread
 *   node threadActorClassifier.js --ids=10744,10774,10761 # specific list
 *   node threadActorClassifier.js --active                # all active+cooling
 *   node threadActorClassifier.js --stale=24              # active+cooling not audited in 24h
 *   node threadActorClassifier.js --dry-run --thread=10744  # log but don't write
 *
 * Failure handling: on Claude error, JSON parse failure, or empty result the
 * existing primary_nations / secondary_nations stay untouched. The caller
 * (storyThreadBuilder) treats classification as best-effort.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { normalizeIso } = require('./isoCountryCodes');

// ─── Constants ───────────────────────────────────────────────────────────
const MODEL          = process.env.ACTOR_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001';
const MAX_ARTICLES   = parseInt(process.env.ACTOR_CLASSIFIER_MAX_ARTICLES || '8', 10);
const SUMMARY_CHARS  = 280;
const MAX_TOKENS_OUT = 2048;

// Looser caps than nationDesignations.js (4/12). The signal pipeline capped
// aggressively because mention counts are noisy — Claude is more deliberate,
// so we permit fuller actor sets. The UI is unaffected by these caps (it
// renders whatever is in the array).
const PRIMARY_CAP    = 10;
const SECONDARY_CAP  = 32;

// ─── System prompt ──────────────────────────────────────────────────────
// IMPORTANT: When iterating, keep this prompt stable across deployment to
// reuse Anthropic prompt caching (5-minute TTL on system block).
const SYSTEM_PROMPT = `You are a geopolitical-affairs classifier embedded in a news-intelligence pipeline.

For a given news story, you must list every country with a MATERIAL STAKE in the story, drawing on BOTH:
  (a) the evidence pack of article titles and summaries we provide, AND
  (b) your pretrained geopolitical knowledge (alliances, rivalries, economic exposure, regional power dynamics, treaty obligations).

You are EXPECTED to include countries that are not named in the articles when the geopolitics of the story unambiguously implicate them. Examples:
  • A story about a US-Iran negotiation has Israel as a material stakeholder even if Israel is not named — the US-Israel alliance is the central reason the US is even at the table.
  • A story about NATO's future has every NATO member as a material stakeholder, plus Russia, plus Ukraine — even if the article only quotes a US politician.
  • A story about a Latin American president visiting Taiwan implicates Paraguay, Taiwan, China (the offended party), and the US (Paraguay's diplomatic recognition of Taiwan is part of the US-China proxy struggle in the region).

Output buckets:
  PRIMARY actors:    countries directly involved — named in the story, OR unambiguously the subject/object of the action even if a synecdoche is used (e.g. "Beijing" → CN, "Washington" → US, "the Élysée" → FR). 1-6 entries.
  SECONDARY actors:  countries with a clear material stake via alliance, economic exposure, regional rivalry, treaty obligation, or geographic proximity that makes them an unavoidable party to the outcome. INCLUDES inferred actors. Be liberal here — capturing latent stakeholders is the whole point of this classifier. 0-20 entries.
  MENTIONED:         countries referenced in the articles but with no material stake (e.g. a country quoted as a comparison, or appearing in a list of historical analogues). 0-10 entries.

Each SECONDARY actor MUST have a one-sentence rationale grounded in geopolitical reality, NOT a restatement of what the articles say.

Confidence: report a 0.0-1.0 score reflecting how confident you are that this is a complete and accurate classification. Lower confidence is appropriate when:
  • The story involves obscure non-state actors you don't recognize
  • The articles describe a post-2026 geopolitical realignment you may not be fully aware of
  • The story is highly local and you can't tell who else has stake

Return STRICTLY this JSON, no surrounding text:
{
  "primary":    ["ISO2", ...],
  "secondary":  ["ISO2", ...],
  "mentioned":  ["ISO2", ...],
  "rationale":  { "ISO2": "one sentence", ... },
  "confidence": 0.0
}

ISO2 codes only (alpha-2). Use GB not UK. Sort each array alphabetically.`;

// ─── Internal helpers ────────────────────────────────────────────────────

function sanitizeIsoList(raw, cap) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const v of raw) {
    const code = normalizeIso(v);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= cap) break;
  }
  return out;
}

function enforceDisjoint(primary, secondary) {
  const p = sanitizeIsoList(primary, PRIMARY_CAP);
  const pSet = new Set(p);
  const s = sanitizeIsoList(secondary, SECONDARY_CAP).filter(c => !pSet.has(c));
  return { primary: p, secondary: s };
}

function buildUserMessage(thread, articles) {
  const lines = [];
  lines.push(`Thread title: ${thread.title}`);
  if (thread.description) lines.push(`Thread description: ${thread.description}`);
  if (thread.primary_category) lines.push(`Category: ${thread.primary_category}`);
  if (thread.geographic_scope) lines.push(`Geographic scope: ${thread.geographic_scope}`);
  lines.push(`Article count: ${thread.article_count}`);
  lines.push('');
  lines.push(`Top ${articles.length} articles (title + summary excerpt):`);
  lines.push('');
  articles.forEach((a, i) => {
    const t = a.translated_title || a.title;
    const s = (a.translated_summary || a.summary || '').slice(0, SUMMARY_CHARS);
    lines.push(`${i + 1}. ${t}`);
    if (s) lines.push(`   ${s}${s.length >= SUMMARY_CHARS ? '…' : ''}`);
    lines.push('');
  });
  lines.push('Now classify actors per the system prompt. Return JSON only.');
  return lines.join('\n');
}

async function loadEvidence(pool, threadId) {
  const { rows: tr } = await pool.query(
    `SELECT id, title, description, status, primary_category, article_count,
            primary_nations, secondary_nations, geographic_scope
       FROM story_threads WHERE id = $1`,
    [threadId],
  );
  if (!tr.length) return null;
  const thread = tr[0];
  const { rows: arts } = await pool.query(
    `SELECT a.id, a.title, a.summary, a.translated_title, a.translated_summary,
            sta.relevance_score, sta.is_anchor
       FROM story_thread_articles sta
       JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC, sta.relevance_score DESC, a.published_at DESC
      LIMIT $2`,
    [threadId, MAX_ARTICLES],
  );
  return { thread, articles: arts };
}

function parseJsonResponse(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Pure classifier: returns the parsed Claude response (plus normalized
 * primary/secondary arrays). Does not write to the DB.
 *
 * @param {object}   opts
 * @param {Pool}     opts.pool       pg pool
 * @param {Anthropic} opts.anthropic  Anthropic SDK client (reused for caching)
 * @param {number}   opts.threadId
 * @returns {Promise<null | {
 *   primary: string[], secondary: string[], mentioned: string[],
 *   rationale: Record<string,string>, confidence: number,
 *   model: string, usage: any
 * }>}
 *   Returns null on any failure (missing thread, no articles, API error,
 *   JSON parse failure). Caller should leave existing tags alone in that
 *   case.
 */
async function classifyThreadActors({ pool, anthropic, threadId }) {
  const ev = await loadEvidence(pool, threadId);
  if (!ev || !ev.thread || !ev.articles.length) return null;

  const userMsg = buildUserMessage(ev.thread, ev.articles);

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_OUT,
      // Temperature 0: this is a classification task, not a creative one.
      // At default temp we observed runs where Claude wrote "SL" for
      // Slovenia (valid ISO2 = SI; SL is Sierra Leone) and "GB" with a
      // factually wrong "former NATO member" rationale. Determinism here
      // also makes the cache_control prompt-cache strictly cheaper since
      // the input distribution is identical across calls.
      temperature: 0,
      // System block in array form + cache_control hits Anthropic's
      // 5-minute prompt cache. After the first call in a cron run,
      // subsequent calls pay ~10% of system-prompt input cost.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    });
  } catch (err) {
    console.warn(`[actorClassifier ${threadId}] Anthropic call failed: ${err.message}`);
    return null;
  }

  const text = (resp.content || [])
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const parsed = parseJsonResponse(text);
  if (!parsed) {
    console.warn(`[actorClassifier ${threadId}] JSON parse failed; raw=${text.slice(0, 200)}`);
    return null;
  }

  const { primary, secondary } = enforceDisjoint(parsed.primary, parsed.secondary);
  if (!primary.length && !secondary.length) {
    console.warn(`[actorClassifier ${threadId}] empty result; keeping existing tags`);
    return null;
  }

  return {
    primary,
    secondary,
    mentioned:  sanitizeIsoList(parsed.mentioned, 16),
    rationale:  (parsed.rationale && typeof parsed.rationale === 'object') ? parsed.rationale : {},
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    model:      MODEL,
    usage:      resp.usage || null,
  };
}

/**
 * Classify + persist. Updates primary_nations, secondary_nations, and
 * last_audited_at. Returns the classification result or null on failure.
 */
async function classifyAndPersist({ pool, anthropic, threadId, dryRun = false }) {
  const result = await classifyThreadActors({ pool, anthropic, threadId });
  if (!result) return null;
  if (!dryRun) {
    await pool.query(
      `UPDATE story_threads
          SET primary_nations   = $2::text[],
              secondary_nations = $3::text[],
              last_audited_at   = NOW()
        WHERE id = $1`,
      [threadId, result.primary, result.secondary],
    );
  }
  return result;
}

module.exports = {
  classifyThreadActors,
  classifyAndPersist,
  MODEL,
  PRIMARY_CAP,
  SECONDARY_CAP,
};

// ─── CLI mode ────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '2';
    require('dotenv').config({ override: true });
    const pool = require('./db');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const args = process.argv.slice(2);
    const flag = (name) => {
      const m = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
      if (!m) return undefined;
      if (m === `--${name}`) return true;
      return m.split('=').slice(1).join('=');
    };

    const dryRun = !!flag('dry-run');
    let ids = [];

    const single = flag('thread');
    const list   = flag('ids');
    const wantActive = !!flag('active');
    const staleHours = flag('stale');

    try {
      if (typeof single === 'string') {
        ids = [parseInt(single, 10)].filter(Number.isFinite);
      } else if (typeof list === 'string') {
        ids = list.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
      } else if (wantActive) {
        const { rows } = await pool.query(
          `SELECT id FROM story_threads
            WHERE status IN ('active','cooling')
            ORDER BY last_updated_at DESC`,
        );
        ids = rows.map(r => r.id);
      } else if (typeof staleHours === 'string') {
        const h = parseInt(staleHours, 10);
        if (!Number.isFinite(h)) throw new Error('--stale requires hours');
        const { rows } = await pool.query(
          `SELECT id FROM story_threads
            WHERE status IN ('active','cooling')
              AND (last_audited_at IS NULL OR last_audited_at < now() - ($1::int * interval '1 hour'))
            ORDER BY last_updated_at DESC`,
          [h],
        );
        ids = rows.map(r => r.id);
      } else {
        console.error('Usage: node threadActorClassifier.js [--thread=ID | --ids=A,B,C | --active | --stale=HOURS] [--dry-run]');
        process.exit(1);
      }

      if (!ids.length) { console.log('no threads to classify'); process.exit(0); }
      console.log(`Classifying ${ids.length} thread(s)${dryRun ? ' (dry-run)' : ''}…`);

      let ok = 0, fail = 0, tIn = 0, tOut = 0, tCache = 0;
      for (let i = 0; i < ids.length; i++) {
        const tid = ids[i];
        const t0 = Date.now();
        const result = await classifyAndPersist({ pool, anthropic, threadId: tid, dryRun });
        const dt = Date.now() - t0;
        if (!result) {
          fail++;
          console.log(`  [${i+1}/${ids.length}] thread ${tid}: FAILED (${dt}ms)`);
          continue;
        }
        ok++;
        if (result.usage) {
          tIn    += result.usage.input_tokens || 0;
          tOut   += result.usage.output_tokens || 0;
          tCache += result.usage.cache_read_input_tokens || 0;
        }
        console.log(
          `  [${i+1}/${ids.length}] thread ${tid}: ` +
          `P=[${result.primary.join(',')}] S=[${result.secondary.join(',')}] ` +
          `conf=${result.confidence} (${dt}ms)`,
        );
      }
      console.log(
        `\nDone. ok=${ok} fail=${fail}  tokens in=${tIn} out=${tOut} cached=${tCache}  ` +
        `est cost (Haiku 4.5): $${((tIn * 1 + tOut * 5) / 1_000_000).toFixed(4)}`,
      );
    } catch (e) {
      console.error('CLI failed:', e);
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}
