/**
 * localStoryBuilder.js — DOMESTIC thread builder, per country.
 *
 * Runs daily on Render. For every country whose cadence tier is due
 * (see country_threading_cadence.last_ran_at + tier interval), samples
 * up to MAX_ARTICLES_PER_COUNTRY recent articles published BY that
 * country's press corps and asks Claude to produce 2–5 DOMESTIC
 * threads — single-country stories about internal politics, economics,
 * finance, legal proceedings, etc.
 *
 * DOMESTIC ≠ GLOBAL: bilateral / cross-border stories stay in the
 * global thread builder's scope. A thread from this builder has
 * scope='local' in the story_threads table so the two don't conflict.
 *
 * Reuse protection (belt + suspenders):
 *   1. Each call receives the country's existing ACTIVE global threads
 *      as negative examples — Claude is told NOT to re-create those.
 *   2. Output is persisted with scope='local' so the global dedup pass
 *      never touches these rows.
 *
 * Scope/cadence logic:
 *   daily   — run every 24h
 *   2day    — run every 48h
 *   weekly  — run every 7d
 *   monthly — run every 30d
 *   skip    — never run
 *
 * Cost: ~150 calls/day × ~$0.01/call (with prompt caching) ≈ $1.50/day
 *       ≈ $45/month.
 *
 * Usage:
 *   node localStoryBuilder.js                     — process all due countries
 *   node localStoryBuilder.js --iso=MX            — force run one country
 *   node localStoryBuilder.js --dry-run           — skip Claude + DB writes
 *   node localStoryBuilder.js --max=20            — cap countries per run
 */

'use strict';
require('dotenv').config({ override: true });

const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const DRY_RUN  = !!ARGV.get('dry-run');
const FORCE_ISO = ARGV.get('iso') ? String(ARGV.get('iso')).toUpperCase() : null;
const MAX_COUNTRIES = parseInt(ARGV.get('max') || '0', 10); // 0 = no cap

const MAX_ARTICLES_PER_COUNTRY = 30;
const MAX_EXISTING_GLOBAL_THREADS = 25; // shown to Claude as negative examples
const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_MAX_TOKENS = 2048;

const CADENCE_INTERVAL_HOURS = {
  daily:   24,
  '2day':  48,
  weekly:  168,
  monthly: 720,
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getDueCountries() {
  // Single country forced via --iso
  if (FORCE_ISO) {
    const { rows } = await pool.query(`
      SELECT ctc.country_id, ctc.iso_code, co.name, ctc.tier
        FROM country_threading_cadence ctc
        JOIN countries co ON co.id = ctc.country_id
       WHERE ctc.iso_code = $1
    `, [FORCE_ISO]);
    return rows;
  }

  // Pick everyone whose tier interval has elapsed since last run.
  // NULL last_ran_at = never ran → always eligible.
  const { rows } = await pool.query(`
    SELECT ctc.country_id, ctc.iso_code, co.name, ctc.tier,
           ctc.last_ran_at, ctc.avg_articles_per_day
      FROM country_threading_cadence ctc
      JOIN countries co ON co.id = ctc.country_id
     WHERE ctc.tier != 'skip'
       AND (
         ctc.last_ran_at IS NULL
         OR ctc.last_ran_at < NOW() - (
              CASE ctc.tier
                WHEN 'daily'   THEN INTERVAL '24 hours'
                WHEN '2day'    THEN INTERVAL '48 hours'
                WHEN 'weekly'  THEN INTERVAL '7 days'
                WHEN 'monthly' THEN INTERVAL '30 days'
              END
            )
       )
     ORDER BY
       -- Prioritise never-ran first, then highest-volume hubs.
       ctc.last_ran_at NULLS FIRST,
       ctc.avg_articles_per_day DESC
  `);
  if (MAX_COUNTRIES > 0) return rows.slice(0, MAX_COUNTRIES);
  return rows;
}

async function getLocalArticles(countryId) {
  // Recent articles FROM this country's press corps. We're looking for
  // "what this country's journalists wrote about today" — so filter on
  // news_articles.country_id (publisher), bound by a window that
  // matches the cadence: a daily-tier country looks at ~24h; a weekly-
  // tier country looks at ~7d. For simplicity we use 48h across the
  // board — plenty of signal for high-volume hubs, enough runway for
  // slower hubs without needing per-tier windows.
  // Keywords live in article_keywords (per-row), not on news_articles —
  // aggregate the top 10 via a correlated subquery so the callsite gets
  // the same shape it would have had from a denormalised column.
  const { rows } = await pool.query(`
    SELECT a.id,
           a.title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           a.published_at,
           COALESCE((
             SELECT array_agg(kw ORDER BY kw)
             FROM (
               SELECT DISTINCT COALESCE(ak.normalized_keyword, ak.keyword) AS kw
                 FROM article_keywords ak
                WHERE ak.article_id = a.id
                LIMIT 10
             ) s
           ), ARRAY[]::text[]) AS keywords,
           COALESCE(ns.name, ys.name) AS source_name,
           ci.name AS city_name
      FROM news_articles a
      LEFT JOIN news_sources ns    ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN cities ci          ON ci.id = a.city_id
     WHERE a.country_id = $1
       AND a.published_at > NOW() - INTERVAL '48 hours'
       AND a.title IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM story_thread_articles sta
          WHERE sta.article_id = a.id
       )
     ORDER BY a.published_at DESC, a.base_priority DESC NULLS LAST
     LIMIT $2
  `, [countryId, MAX_ARTICLES_PER_COUNTRY]);
  return rows;
}

async function getExistingGlobalThreadsForCountry(isoCode) {
  // Passed to Claude as NEGATIVE examples so it doesn't create a local
  // thread that overlaps with an already-tracked global one. Limited to
  // recent active globals that mention this country in primary or
  // secondary nations.
  const { rows } = await pool.query(`
    SELECT id, title
      FROM story_threads
     WHERE COALESCE(scope, 'global') = 'global'
       AND status = 'active'
       AND last_updated_at > NOW() - INTERVAL '30 days'
       AND (
         primary_nations @> ARRAY[$1]::text[]
         OR secondary_nations @> ARRAY[$1]::text[]
       )
     ORDER BY importance DESC, last_updated_at DESC
     LIMIT $2
  `, [isoCode, MAX_EXISTING_GLOBAL_THREADS]);
  return rows;
}

function buildPrompt(countryName, isoCode, articles, existingGlobal) {
  // The cacheable system portion (rules + schema) is identical for every
  // country call — split into system[] so Anthropic caches it across the
  // 150+ calls we'll make per run. Big win on input cost.
  const rulesBlock =
    `You are the DOMESTIC news editor for a geopolitical monitoring platform.
Your job is to surface 2–5 PURELY DOMESTIC meta-stories from this country's press corps — stories that:
  • Are primarily about the country's INTERNAL politics, economics, finance, legal affairs, regulation, labor, or corporate/market events with national significance
  • Would run on the country's national evening news AS DOMESTIC news — not foreign affairs
  • Have multi-source coverage from within the last 48 hours

═══ DOMESTIC vs GLOBAL — HARD LINE ═══
A LOCAL thread MUST be:
  ✓ Indictment of a domestic politician / court ruling against a minister
  ✓ National election / referendum / cabinet reshuffle
  ✓ Central bank rate decision / budget announcement / currency crisis
  ✓ Major domestic scandal, corruption case, major crime with political weight
  ✓ Large-scale domestic protest / strike / labor action
  ✓ Regulatory action against a major domestic company
  ✓ Industrial disaster, mass casualty event with domestic response
  ✓ National policy shift with local impact (healthcare reform, pension law, etc.)

A LOCAL thread MUST NOT BE:
  ✗ The country's bilateral relations with any other country
  ✗ The country's reaction to a foreign leader / conflict / treaty
  ✗ Cross-border trade disputes, sanctions, tariffs
  ✗ The country's role in an international summit / alliance / UN vote
  ✗ Foreign peace talks, war coverage, foreign elections
  ✗ International sports / entertainment / cultural exchange

If a story is fundamentally about {COUNTRY}'s relationship with another country — SKIP it. Those are handled elsewhere.

═══ TITLE FORMAT ═══
A valid LOCAL thread title MUST contain at least ONE of:
  • A named domestic actor (prime minister, president, opposition leader, CEO, judge, etc.)
  • A named domestic place beyond the country (state, province, city, region)
  • A specific action verb (indicts, resigns, raises, cuts, rules, arrests, etc.)
  • A specific event noun (scandal, ruling, verdict, election, strike, protest, etc.)
  • A number (casualty count, vote tally, inflation rate, rate decision bp, etc.)

═══ HARD REJECT (topic-bucket filter) ═══
Don't emit titles that are just "[Country] [Abstract] and [Abstract]" — e.g. "Brazil Political Accountability and Legislative Debates". Those are labels, not stories.

═══ OUTPUT ═══
Return ONLY a valid JSON array. Each object:
{
  "title":               "< 8 words, story-centric",
  "description":         "2 sentences on the domestic significance",
  "article_ids":         [ids of articles from the batch that belong to this thread],
  "anchor_article_id":   id of the most representative article,
  "primary_category":    "politics|economy|military|diplomacy|environment|technology",
  "importance":          1-10,
  "keywords":            ["5-10", "core", "domestic", "keywords"]
}

Empty array [] is valid — if none of the articles qualify, return []. Do NOT fabricate.`;

  // The dynamic portion — per-country, per-run. NOT cached.
  const articleData = articles.map(a => ({
    id:       a.id,
    title:    a.title,
    summary:  String(a.summary || '').slice(0, 250),
    keywords: (a.keywords || []).slice(0, 10),
    source:   a.source_name || null,
    city:     a.city_name || null,
    published_at: a.published_at,
  }));

  const globalHints = existingGlobal.map(t => `  • "${t.title}" (thread #${t.id})`).join('\n');

  const userBlock =
    `COUNTRY: ${countryName} (${isoCode})

${globalHints ? `EXISTING GLOBAL THREADS INVOLVING ${countryName} — DO NOT duplicate these as local threads (they are already tracked as cross-border stories):
${globalHints}

` : ''}RECENT DOMESTIC ARTICLES (last 48h, from ${countryName}'s press):
${JSON.stringify(articleData, null, 2)}

Emit 2–5 DOMESTIC threads per the rules above. Empty [] is acceptable.`;

  return { rulesBlock, userBlock };
}

function parseClaudeJsonArray(text) {
  // Mirror of storyThreadBuilder.js parser, minus the import plumbing.
  const raw = String(text || '').trim();
  if (!raw) return [];
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(unfenced);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  const startIdx = unfenced.indexOf('[');
  if (startIdx < 0) return [];
  // Empty-array short-circuit so trailing prose doesn't mask an empty result.
  if (/^\[\s*\]/.test(unfenced.slice(startIdx))) return [];
  const out = [];
  let depth = 0, objStart = -1, inString = false, escape = false;
  for (let i = startIdx; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"')  { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') { depth++; continue; }
    if (ch === '{') { if (depth === 1 && objStart < 0) objStart = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 1 && objStart >= 0) {
        try { out.push(JSON.parse(unfenced.slice(objStart, i + 1))); } catch (_) {}
        objStart = -1;
      }
      continue;
    }
    if (ch === ']') { depth--; if (depth === 0) break; }
  }
  return out;
}

async function askClaude(rulesBlock, userBlock) {
  // system[] with cache_control enables prompt caching. All 150+ per-run
  // calls read from the same cached rules block → ~90% discount on
  // those 2k tokens from the 2nd call onward.
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: [
      { type: 'text', text: rulesBlock, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{ role: 'user', content: userBlock }],
  });
  const text = response.content[0].text.trim();
  return parseClaudeJsonArray(text);
}

async function persistLocalThread(def, isoCode, validIdSet) {
  // Only accept article_ids that were in the batch — guards against
  // Claude hallucinating random ids.
  const ids = (def.article_ids || [])
    .map(Number)
    .filter(id => validIdSet.has(id));
  if (ids.length < 2) return null; // need at least 2 sources for convergence

  // Insert with scope='local' and primary_nations = [isoCode]. Local
  // threads are single-country by definition.
  const { rows: tr } = await pool.query(`
    INSERT INTO story_threads
      (title, description, primary_category, geographic_scope,
       importance, keywords, article_count,
       primary_nations, secondary_nations, scope)
    VALUES ($1, $2, $3, 'local', $4, $5, $6, $7::text[], ARRAY[]::text[], 'local')
    RETURNING id
  `, [
    def.title,
    def.description || '',
    def.primary_category || 'politics',
    def.importance || 5,
    def.keywords || [],
    ids.length,
    [isoCode],
  ]);
  const threadId = Number(tr[0].id);
  const anchorId = Number(def.anchor_article_id);
  for (const articleId of ids) {
    await pool.query(`
      INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
      VALUES ($1, $2, 1.0, $3)
      ON CONFLICT DO NOTHING
    `, [threadId, articleId, articleId === anchorId]);
  }
  return threadId;
}

async function processCountry(country) {
  const isoCode = country.iso_code;
  const countryName = country.name;
  console.log(`\n🏴 ${isoCode} ${countryName} [tier=${country.tier}]`);

  const articles = await getLocalArticles(country.country_id);
  if (articles.length < 5) {
    console.log(`   ℹ only ${articles.length} unthreaded articles — skipping`);
    // Still bump last_ran_at so we don't retry every cron tick.
    if (!DRY_RUN) {
      await pool.query(
        `UPDATE country_threading_cadence SET last_ran_at = NOW() WHERE country_id = $1`,
        [country.country_id]
      );
    }
    return { created: 0, skipped: true };
  }

  const existingGlobal = await getExistingGlobalThreadsForCountry(isoCode);
  console.log(`   ${articles.length} articles, ${existingGlobal.length} existing global thread(s) shown as negative examples`);

  const { rulesBlock, userBlock } = buildPrompt(countryName, isoCode, articles, existingGlobal);

  if (DRY_RUN) {
    console.log(`   [DRY-RUN] would call Claude with ~${Math.round((rulesBlock.length + userBlock.length) / 4)} tokens of input`);
    return { created: 0, skipped: false };
  }

  let defs;
  try {
    defs = await askClaude(rulesBlock, userBlock);
  } catch (err) {
    console.warn(`   ⚠ Claude call failed: ${err.message}`);
    return { created: 0, skipped: false, error: err.message };
  }

  const validIdSet = new Set(articles.map(a => Number(a.id)));
  let created = 0;
  for (const def of defs) {
    try {
      const threadId = await persistLocalThread(def, isoCode, validIdSet);
      if (threadId) {
        created++;
        console.log(`   ✓ local thread #${threadId}: "${def.title}"`);
      } else {
        console.log(`   ✗ skipped (too few valid articles): "${def.title}"`);
      }
    } catch (err) {
      console.warn(`   ⚠ persist failed for "${def.title}": ${err.message}`);
    }
  }

  await pool.query(
    `UPDATE country_threading_cadence SET last_ran_at = NOW() WHERE country_id = $1`,
    [country.country_id]
  );
  return { created, skipped: false };
}

async function main() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  console.log(`\n🏛  Local Story Builder — ${new Date().toISOString()}`);
  console.log(`   mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}${FORCE_ISO ? `  iso=${FORCE_ISO}` : ''}${MAX_COUNTRIES ? `  max=${MAX_COUNTRIES}` : ''}\n`);

  if (!process.env.ANTHROPIC_API_KEY && !DRY_RUN) {
    throw new Error('ANTHROPIC_API_KEY not set — refusing to run without it.');
  }

  const due = await getDueCountries();
  console.log(`   [${elapsed()}] ${due.length} country/countries due for local threading`);
  if (!due.length) {
    console.log(`   Nothing to do.\n`);
    await pool.end();
    return;
  }

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalErrors  = 0;
  for (let i = 0; i < due.length; i++) {
    const c = due[i];
    try {
      const res = await processCountry(c);
      totalCreated += res.created;
      if (res.skipped) totalSkipped++;
      if (res.error) totalErrors++;
    } catch (err) {
      console.warn(`   ⚠ ${c.iso_code} top-level error: ${err.message}`);
      totalErrors++;
    }
    // Be polite to both DB + Claude.
    if (!DRY_RUN) await sleep(350);
  }

  console.log(`\n✅ Done in ${elapsed()}`);
  console.log(`   Countries processed: ${due.length}`);
  console.log(`   Local threads created: ${totalCreated}`);
  console.log(`   Skipped (too few articles): ${totalSkipped}`);
  if (totalErrors) console.log(`   Errors: ${totalErrors}`);
  await pool.end();
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
