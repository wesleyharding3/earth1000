/**
 * entityExtractor.js
 *
 * Claude-powered entity + referenced-date extraction for the Timelines
 * knowledge graph. Used by:
 *   - articleListener.js   (per-article at ingest time, future)
 *   - backfillEntities.js  (one-time historical pass, future)
 *
 * Returns structured entities (people, orgs, places, ideologies, events,
 * works) with disambiguating context AND any historical dates the article
 * reaches back to. Does NOT write to the DB by itself — that's the job of
 * entityResolver.js (next file). This module is pure: article in, JSON out.
 *
 * CLI test mode:
 *   node entityExtractor.js <article_id>
 *   node entityExtractor.js --random
 *   node entityExtractor.js --recent=5
 *
 * Prints extracted entities + dates as pretty JSON. Does not touch the
 * graph tables. Safe to run repeatedly.
 */

'use strict';

require('dotenv').config({ override: true });
const pool      = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Config ──────────────────────────────────────────────────────────────────

const MODEL              = 'claude-haiku-4-5';
const MAX_TOKENS         = 2048;
const CONFIDENCE_FLOOR   = 0.4;   // Drop anything Claude isn't reasonably sure of
const MAX_BODY_CHARS     = 6000;  // Truncate very long articles before send
const VALID_ENTITY_TYPES = new Set([
  'person', 'organization', 'location', 'ideology', 'event', 'work', 'other'
]);
const VALID_ROLES = new Set([
  'subject', 'actor', 'location', 'referenced',
  'referenced_historical', 'source'
]);
const VALID_DATE_PRECISION = new Set([
  'day', 'month', 'year', 'decade', 'century'
]);

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildPrompt(article) {
  const title = article.title || '';
  const body  = (article.translated_summary || article.summary || '').slice(0, MAX_BODY_CHARS);
  const pubDate = article.published_at
    ? new Date(article.published_at).toISOString().slice(0, 10)
    : 'unknown';

  return `You are extracting structured entities from a news article for a knowledge graph that connects present-day stories to historical events. Be precise, conservative, and never invent. DO NOT generate Wikidata QIDs — they will be looked up later by a separate resolver.

ARTICLE PUBLISHED: ${pubDate}
TITLE: ${title}
BODY: ${body}

═══ YOUR TASK ═══

Extract two things:

1. ENTITIES — every concrete person, organization, location, ideology, event, or work mentioned in the article.

2. REFERENCED DATES — any specific date or date range, OR any era/period the article invokes that is NOT today's news. Includes both numeric ("the 1953 coup") and named ("the Cold War", "the colonial era") references. Skip the article's own publication date.

═══ RULES ═══

ENTITY TYPES (use exactly one):
  - person        — a named individual
  - organization  — government bodies, parties, militaries, corporations, militant groups, NGOs
  - location      — countries, cities, regions, named geographic features
  - ideology      — named movements, doctrines, religions, political schools
  - event         — named past or present events (wars, coups, summits, treaties, attacks)
  - work          — named books, films, reports, treaties as documents
  - other         — only if none of the above truly fit

ROLE (use exactly one per mention):
  - subject               — the article is primarily ABOUT this entity
  - actor                 — active participant in the present-day story
  - location              — where the present-day story is happening
  - referenced            — mentioned in passing, present-tense
  - referenced_historical — past entity invoked for context (CRITICAL — see "HISTORICAL REACH" below)
  - source                — entity is the speaker/source of a quote or claim

═══ HISTORICAL REACH (read carefully) ═══

A core purpose of this system is to connect present-day stories to events going back decades or centuries. Be ALERT for any signal that the article is reaching into the past, even subtly.

TRIGGER PHRASES — when you see any of these, you should be looking for entities to mark referenced_historical AND for a referenced_date to emit:
  - "has long" / "long-standing" / "longtime"
  - "for decades" / "for years" / "going back to"
  - "historically" / "in the past" / "in the wake of"
  - "the legacy of" / "rooted in" / "stems from" / "dates back to"
  - "since the [year]s" / "ever since" / "before the [event]"
  - "founded in" / "established after"
  - "post-[event]" (e.g. "post-9/11", "post-Cold-War")
  - any specific year, decade, or century earlier than the publication year

WHEN A TRIGGER APPEARS:
  - Mark the relevant entities (the IRGC, the cartel, the regime, etc.) with role='referenced_historical' if they are being discussed in the historical sense.
  - Emit a referenced_date for the implied era. If the article says "since the revolution" and you can identify which revolution from context, emit a referenced_date for it (decade or year precision is fine).
  - If a phrase like "the Cold War" or "the colonial era" appears, emit a referenced_date with the start of that era and appropriate date_precision (decade/century).

IMPORTANT: An entity that is OLD but is being discussed in present tense (e.g. "the CIA arrested someone today") is NOT referenced_historical — it's an actor. The role refers to whether the article is reaching into the PAST, not whether the entity itself is old.

═══ OTHER RULES ═══

CONFIDENCE (0.0–1.0):
  - 1.0  = explicitly named, unambiguous
  - 0.8  = clearly identifiable from context
  - 0.6  = probably this entity but some ambiguity
  - 0.4  = guessing — only include if the entity matters
  - <0.4 = DO NOT include

DISAMBIGUATION:
  - For common names ("John Smith", "Ali Khan"), include enough description to identify which one (job title, country, era).
  - For organizations with shared acronyms (PJD, SPD, BJP), spell out which one and where.
  - If you cannot disambiguate, lower confidence accordingly. Don't guess on identity.
  - The 'description' field is REQUIRED for non-trivial entities. Make it specific enough that a human or downstream resolver could pick the right Wikidata entry.

DATES:
  - Use ISO format YYYY-MM-DD. For imprecise dates, pick the start of the period and set date_precision accordingly:
      "1953"             → 1953-01-01, precision "year"
      "August 1953"      → 1953-08-01, precision "month"
      "the 1980s"        → 1980-01-01, precision "decade"
      "the 19th century" → 1801-01-01, precision "century"
      "the Cold War"     → 1947-01-01, precision "decade"
      "the colonial era" (Latin America) → 1500-01-01, precision "century"
  - context_snippet should be the short phrase or sentence the date appeared in.

═══ OUTPUT ═══

Return ONLY valid JSON, no prose, no markdown fences:

{
  "entities": [
    {
      "canonical_name": "Mohammad Mosaddegh",
      "entity_type": "person",
      "aliases": ["Mossadegh", "Mossadeq"],
      "description": "Iranian prime minister 1951–1953, overthrown in 1953 CIA-backed coup",
      "country_code": "IR",
      "role": "referenced_historical",
      "confidence": 0.95
    }
  ],
  "referenced_dates": [
    {
      "referenced_date": "1953-08-19",
      "date_precision": "day",
      "context_snippet": "the 1953 CIA-backed coup against Mosaddegh",
      "confidence": 0.9
    }
  ]
}

═══ WORKED EXAMPLES ═══

EXAMPLE A — explicit historical date
Title: "Iranian protesters mark 70 years since CIA coup"
Body: "Demonstrators in Tehran on Saturday marked the anniversary of the August 1953 coup that toppled prime minister Mohammad Mosaddegh, an operation later acknowledged by the CIA. Speakers linked today's economic grievances to decades of foreign interference."
Output:
{
  "entities": [
    {"canonical_name":"Iran","entity_type":"location","aliases":[],"description":"country in Western Asia","country_code":"IR","role":"location","confidence":1.0},
    {"canonical_name":"Tehran","entity_type":"location","aliases":[],"description":"capital of Iran","country_code":"IR","role":"location","confidence":1.0},
    {"canonical_name":"Mohammad Mosaddegh","entity_type":"person","aliases":["Mossadegh"],"description":"Iranian Prime Minister 1951–1953, overthrown in CIA-backed coup","country_code":"IR","role":"referenced_historical","confidence":1.0},
    {"canonical_name":"Central Intelligence Agency","entity_type":"organization","aliases":["CIA"],"description":"United States foreign intelligence agency","country_code":"US","role":"referenced_historical","confidence":1.0},
    {"canonical_name":"1953 Iranian coup d'état","entity_type":"event","aliases":["Operation Ajax","TPAJAX"],"description":"CIA/MI6-backed overthrow of Mosaddegh in August 1953","country_code":"IR","role":"referenced_historical","confidence":1.0}
  ],
  "referenced_dates": [
    {"referenced_date":"1953-08-01","date_precision":"month","context_snippet":"the August 1953 coup","confidence":0.95}
  ]
}

EXAMPLE B — soft historical reach (no explicit date)
Title: "Why the IRGC would fight to the end"
Body: "The Islamic Revolutionary Guard Corps has long wielded outsized power in Iran, going back to its founding after the revolution. For decades it has controlled parts of the economy and projected influence across the region through proxies. Analysts say its institutional identity is rooted in the existential struggle against the United States that began with the embassy crisis."
Output:
{
  "entities": [
    {"canonical_name":"Islamic Revolutionary Guard Corps","entity_type":"organization","aliases":["IRGC","Sepah"],"description":"Iranian military and paramilitary force founded after the 1979 revolution","country_code":"IR","role":"referenced_historical","confidence":1.0},
    {"canonical_name":"Iran","entity_type":"location","aliases":[],"description":"country in Western Asia","country_code":"IR","role":"location","confidence":1.0},
    {"canonical_name":"United States","entity_type":"location","aliases":["US","USA"],"description":"country in North America","country_code":"US","role":"referenced_historical","confidence":0.9},
    {"canonical_name":"Iranian Revolution","entity_type":"event","aliases":["1979 revolution","Islamic Revolution"],"description":"1979 overthrow of the Pahlavi monarchy and founding of the Islamic Republic","country_code":"IR","role":"referenced_historical","confidence":0.95},
    {"canonical_name":"Iran hostage crisis","entity_type":"event","aliases":["embassy crisis","US embassy hostage crisis"],"description":"1979–1981 seizure of US embassy in Tehran","country_code":"IR","role":"referenced_historical","confidence":0.9}
  ],
  "referenced_dates": [
    {"referenced_date":"1979-01-01","date_precision":"year","context_snippet":"founding after the revolution","confidence":0.9},
    {"referenced_date":"1979-11-01","date_precision":"month","context_snippet":"the embassy crisis","confidence":0.85}
  ]
}

EXAMPLE C — present-tense, no historical reach
Title: "Mexico extradites cartel leader to United States"
Body: "Mexican authorities transferred Rafael Caro Quintero to US custody on Friday, ending a decades-long extradition fight. Caro Quintero, founder of the Guadalajara Cartel, was convicted in absentia for the 1985 murder of DEA agent Enrique Camarena."
Output:
{
  "entities": [
    {"canonical_name":"Mexico","entity_type":"location","aliases":[],"description":"country in North America","country_code":"MX","role":"actor","confidence":1.0},
    {"canonical_name":"United States","entity_type":"location","aliases":["US"],"description":"country in North America","country_code":"US","role":"actor","confidence":1.0},
    {"canonical_name":"Rafael Caro Quintero","entity_type":"person","aliases":[],"description":"Mexican drug trafficker, founder of Guadalajara Cartel","country_code":"MX","role":"subject","confidence":1.0},
    {"canonical_name":"Guadalajara Cartel","entity_type":"organization","aliases":[],"description":"defunct Mexican drug trafficking organization active in 1980s","country_code":"MX","role":"referenced_historical","confidence":0.95},
    {"canonical_name":"Drug Enforcement Administration","entity_type":"organization","aliases":["DEA"],"description":"US federal anti-narcotics agency","country_code":"US","role":"referenced_historical","confidence":1.0},
    {"canonical_name":"Enrique Camarena","entity_type":"person","aliases":["Kiki Camarena"],"description":"DEA agent murdered in 1985 in Mexico","country_code":"US","role":"referenced_historical","confidence":0.95}
  ],
  "referenced_dates": [
    {"referenced_date":"1985-01-01","date_precision":"year","context_snippet":"the 1985 murder of DEA agent Enrique Camarena","confidence":0.95}
  ]
}

Now extract entities and referenced dates from the article above. Return only the JSON object.`;
}

// ─── Validation / sanitisation ───────────────────────────────────────────────

function sanitizeEntities(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.canonical_name !== 'string' || !e.canonical_name.trim()) continue;
    if (!VALID_ENTITY_TYPES.has(e.entity_type)) continue;
    if (!VALID_ROLES.has(e.role)) continue;
    const conf = Number(e.confidence);
    if (!Number.isFinite(conf) || conf < CONFIDENCE_FLOOR) continue;

    out.push({
      canonical_name: e.canonical_name.trim(),
      entity_type:    e.entity_type,
      // wikidata_qid is intentionally NOT taken from Claude — too unreliable.
      // The resolver looks it up via the Wikidata search API after extraction.
      wikidata_qid:   null,
      aliases:        Array.isArray(e.aliases) ? e.aliases.filter(a => typeof a === 'string' && a.trim()).slice(0, 20) : [],
      description:    typeof e.description === 'string' ? e.description.trim().slice(0, 500) : null,
      country_code:   typeof e.country_code === 'string' && /^[A-Z]{2}$/.test(e.country_code) ? e.country_code : null,
      role:           e.role,
      confidence:     Math.min(1, Math.max(0, conf))
    });
  }
  return out;
}

function sanitizeDates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    if (typeof d.referenced_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.referenced_date)) continue;
    if (!VALID_DATE_PRECISION.has(d.date_precision)) continue;
    const conf = Number(d.confidence);
    if (!Number.isFinite(conf) || conf < CONFIDENCE_FLOOR) continue;

    out.push({
      referenced_date: d.referenced_date,
      date_precision:  d.date_precision,
      context_snippet: typeof d.context_snippet === 'string' ? d.context_snippet.trim().slice(0, 500) : null,
      confidence:      Math.min(1, Math.max(0, conf))
    });
  }
  return out;
}

// ─── JSON parser (tolerates code fences / leading prose) ─────────────────────

function parseClaudeJSON(text) {
  if (!text) throw new Error('empty Claude response');
  // Strip markdown fences if Claude wrapped them despite instructions
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  }
  // Find the first {...} block
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON object in response: ${s.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

// ─── Main extraction function ────────────────────────────────────────────────

/**
 * extractEntities(article)
 *
 * @param {object} article  - { id, title, summary, translated_summary, published_at }
 * @returns {Promise<{ entities: Array, referenced_dates: Array, raw: object, usage: object }>}
 */
async function extractEntities(article) {
  if (!article || (!article.title && !article.summary && !article.translated_summary)) {
    return { entities: [], referenced_dates: [], raw: null, usage: null };
  }

  const prompt = buildPrompt(article);

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    messages:   [{ role: 'user', content: prompt }]
  });

  const text = response.content[0]?.text || '';
  let parsed;
  try {
    parsed = parseClaudeJSON(text);
  } catch (err) {
    const e = new Error(`entityExtractor: failed to parse Claude response: ${err.message}`);
    e.raw = text;
    throw e;
  }

  const entities         = sanitizeEntities(parsed.entities);
  const referenced_dates = sanitizeDates(parsed.referenced_dates);

  return {
    entities,
    referenced_dates,
    raw: parsed,
    usage: response.usage || null
  };
}

// ─── CLI test mode ───────────────────────────────────────────────────────────

async function fetchArticleById(id) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function fetchRandomArticle() {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles
      WHERE summary IS NOT NULL AND length(summary) > 200
      ORDER BY random()
      LIMIT 1`
  );
  return rows[0] || null;
}

async function fetchRecentArticles(n) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles
      WHERE summary IS NOT NULL AND length(summary) > 200
      ORDER BY published_at DESC
      LIMIT $1`,
    [n]
  );
  return rows;
}

async function runCLI() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Usage:');
    console.log('  node entityExtractor.js <article_id>');
    console.log('  node entityExtractor.js --random');
    console.log('  node entityExtractor.js --recent=5');
    await pool.end();
    return;
  }

  let articles = [];
  if (args[0] === '--random') {
    const a = await fetchRandomArticle();
    if (a) articles = [a];
  } else if (args[0].startsWith('--recent=')) {
    const n = parseInt(args[0].split('=')[1] || '5', 10);
    articles = await fetchRecentArticles(n);
  } else {
    const id = parseInt(args[0], 10);
    if (!Number.isFinite(id)) {
      console.error('Invalid article id');
      await pool.end();
      process.exit(1);
    }
    const a = await fetchArticleById(id);
    if (a) articles = [a];
  }

  if (!articles.length) {
    console.log('No articles found.');
    await pool.end();
    return;
  }

  for (const article of articles) {
    console.log('\n' + '═'.repeat(72));
    console.log(`Article #${article.id} — ${article.published_at ? new Date(article.published_at).toISOString().slice(0,10) : 'undated'}`);
    console.log(`TITLE: ${article.title}`);
    const body = (article.translated_summary || article.summary || '').slice(0, 300);
    console.log(`BODY:  ${body}${body.length >= 300 ? '…' : ''}`);
    console.log('─'.repeat(72));

    try {
      const t0 = Date.now();
      const result = await extractEntities(article);
      const ms = Date.now() - t0;

      console.log(`\n✓ Extracted in ${ms}ms`);
      if (result.usage) {
        console.log(`  tokens: in=${result.usage.input_tokens} out=${result.usage.output_tokens}`);
      }
      console.log(`\n  ENTITIES (${result.entities.length}):`);
      for (const e of result.entities) {
        const qid = e.wikidata_qid ? ` [${e.wikidata_qid}]` : '';
        const cc  = e.country_code ? ` (${e.country_code})` : '';
        console.log(`    • ${e.canonical_name}${qid} — ${e.entity_type} / ${e.role} @ ${e.confidence.toFixed(2)}${cc}`);
        if (e.description) console.log(`        ${e.description}`);
        if (e.aliases.length) console.log(`        aliases: ${e.aliases.join(', ')}`);
      }
      console.log(`\n  REFERENCED DATES (${result.referenced_dates.length}):`);
      for (const d of result.referenced_dates) {
        console.log(`    • ${d.referenced_date} (${d.date_precision}) @ ${d.confidence.toFixed(2)}`);
        if (d.context_snippet) console.log(`        "${d.context_snippet}"`);
      }
    } catch (err) {
      console.error(`\n✗ ERROR: ${err.message}`);
      if (err.raw) console.error(`  raw: ${err.raw.slice(0, 400)}`);
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
  await pool.end();
}

// ─── Public API ──────────────────────────────────────────────────────────────

module.exports = {
  extractEntities,
  buildPrompt,           // exposed for prompt-tuning experiments
  CONFIDENCE_FLOOR,
};

// Run CLI if invoked directly
if (require.main === module) {
  runCLI().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
