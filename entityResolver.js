/**
 * entityResolver.js
 *
 * Takes raw entity extraction output from entityExtractor.js and resolves
 * each entity against:
 *   1. Our local `entities` table (fuzzy match via pg_trgm), then
 *   2. Wikidata's wbsearchentities API to get a real, verified QID, then
 *   3. Inserts/updates the canonical row, plus the article_entity_mentions
 *      and article_referenced_dates rows for this article.
 *
 * Why a separate module: Claude is unreliable at producing Wikidata QIDs
 * from memory (~60% hallucination rate in our v0 test). This module gets
 * QIDs from the actual Wikidata search API, which is authoritative. Claude
 * provides the canonical name, type, and disambiguating description; we
 * use those to query Wikidata and pick the correct match.
 *
 * CLI test mode:
 *   node entityResolver.js <article_id>            — extract + resolve + WRITE
 *   node entityResolver.js <article_id> --dry-run  — extract + resolve, NO writes
 *   node entityResolver.js --random                — pick a random article
 *   node entityResolver.js --recent=N              — N most recent articles
 *
 * Marks the article as 'done' in article_entity_extraction_state on success.
 */

'use strict';

require('dotenv').config({ override: true });
const https     = require('https');
const pool      = require('./db');
const { extractEntities } = require('./entityExtractor');

// ─── Config ──────────────────────────────────────────────────────────────────

const LOCAL_TRIGRAM_THRESHOLD = 0.55;   // pg_trgm similarity to accept a local match
const WIKIDATA_API_DELAY_MS   = 250;    // courtesy delay between Wikidata calls
const WIKIDATA_USER_AGENT     = 'earth00-timelines-resolver/0.1 (https://earth00.com)';
const MAX_WIKIDATA_RESULTS    = 5;

// Map our entity_type → keywords expected in a Wikidata description for that type.
// Used to validate that the top wbsearchentities hit is the RIGHT KIND of thing.
// We accept a hit if its description contains ANY of the keywords for its type.
const TYPE_DESCRIPTION_KEYWORDS = {
  person: [
    'politician','president','minister','leader','general','officer','activist',
    'journalist','author','writer','academic','professor','economist','diplomat',
    'lawyer','judge','actor','actress','singer','musician','athlete','scientist',
    'businessman','businesswoman','founder','executive','revolutionary','militant',
    'religious','clergyman','imam','rabbi','priest','monk','born','died'
  ],
  organization: [
    'organization','organisation','agency','party','government','ministry',
    'department','company','corporation','firm','bank','university','school',
    'committee','council','commission','union','federation','group','movement',
    'army','military','force','force,','militia','intelligence','police',
    'club','team','foundation','ngo','non-governmental','institution','network'
  ],
  location: [
    'country','city','town','village','region','province','state','county',
    'capital','district','municipality','commune','prefecture','territory',
    'island','peninsula','archipelago','mountain','river','lake','sea','ocean',
    'strait','gulf','bay','desert','forest','park','located in','part of'
  ],
  ideology: [
    'ideology','philosophy','doctrine','movement','school of thought','religion',
    'denomination','sect','political','ism'
  ],
  event: [
    'war','battle','conflict','revolution','coup','uprising','protest','election',
    'summit','treaty','agreement','massacre','genocide','attack','bombing','crisis',
    'pandemic','famine','earthquake','disaster','ceremony','festival','olympics',
    'championship','occurred','took place','held in','signed in',
    'shortage','embargo','recession','collapse','blockade','intervention',
    'invasion','strike','assassination','riot','rebellion','independence',
    'unification','dissolution','partition','accord','referendum','scandal'
  ],
  work: [
    'book','novel','film','movie','album','song','painting','sculpture',
    'report','document','treaty','law','act','constitution','manuscript',
    'newspaper','magazine','journal','website','published'
  ],
  other: []
};

// ─── Wikidata API ────────────────────────────────────────────────────────────

let lastWikidataCall = 0;
async function throttleWikidata() {
  const since = Date.now() - lastWikidataCall;
  if (since < WIKIDATA_API_DELAY_MS) {
    await new Promise(r => setTimeout(r, WIKIDATA_API_DELAY_MS - since));
  }
  lastWikidataCall = Date.now();
}

function httpGetJSON(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'www.wikidata.org',
      path,
      headers: { 'User-Agent': WIKIDATA_USER_AGENT, 'Accept': 'application/json' }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`wikidata parse error: ${err.message} — body: ${data.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * searchWikidata(name, entityType, countryCode)
 *
 * Calls wbsearchentities, then validates each candidate against the
 * expected entity type using description keywords. Returns the first
 * candidate whose description matches, or null if none do.
 *
 * @returns { qid, label, description } | null
 */
async function searchWikidata(name, entityType, countryCode) {
  if (!name) return null;
  await throttleWikidata();

  const params = new URLSearchParams({
    action:    'wbsearchentities',
    search:    name,
    language:  'en',
    uselang:   'en',
    format:    'json',
    type:      'item',
    limit:     String(MAX_WIKIDATA_RESULTS)
  });

  let result;
  try {
    result = await httpGetJSON('/w/api.php?' + params.toString());
  } catch (err) {
    return null;
  }

  const candidates = result?.search || [];
  if (!candidates.length) return null;

  const keywords = TYPE_DESCRIPTION_KEYWORDS[entityType] || [];
  const queryLower = name.toLowerCase().trim();

  // Pass 0: EXACT label match — if Wikidata's label is identical to our
  // query (case-insensitive), trust it regardless of description. This is
  // the strongest possible signal and skipping validation here recovers
  // many valid hits whose descriptions happen not to use our keywords
  // (e.g. "1973 oil crisis" → described as "1973 petroleum shortage").
  for (const c of candidates) {
    if ((c.label || '').toLowerCase().trim() === queryLower) {
      return { qid: c.id, label: c.label, description: c.description || null };
    }
  }

  // Pass 1: prefer candidates whose description matches the expected type
  for (const c of candidates) {
    const desc = (c.description || '').toLowerCase();
    if (!desc) continue;
    const typeMatch = keywords.length === 0 || keywords.some(k => desc.includes(k));
    if (!typeMatch) continue;
    return { qid: c.id, label: c.label, description: c.description };
  }

  // Pass 2: if entity_type is 'other' or no description matched, accept the
  // top hit ONLY if it has SOME description (i.e. is a real entity, not a
  // disambiguation page or empty stub).
  const top = candidates[0];
  if (top && top.description && entityType === 'other') {
    return { qid: top.id, label: top.label, description: top.description };
  }

  // Otherwise: better to return null than store a wrong QID.
  return null;
}

// ─── Local entity matching ──────────────────────────────────────────────────

/**
 * findLocalEntity(name, entityType)
 *
 * Uses pg_trgm similarity on canonical_name + alias array to find an
 * existing entity in our DB. Returns the row if similarity >= threshold,
 * else null.
 */
async function findLocalEntity(name, entityType, client) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT id, canonical_name, entity_type, wikidata_qid, aliases, description, country_code,
            similarity(canonical_name, $1) AS sim_name
       FROM entities
      WHERE entity_type = $2
        AND (
          similarity(canonical_name, $1) >= $3
          OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = lower($1))
        )
      ORDER BY sim_name DESC
      LIMIT 5`,
    [name, entityType, LOCAL_TRIGRAM_THRESHOLD]
  );
  if (!rows.length) return null;

  // Year-mismatch guard: if the query contains a 4-digit year (e.g.
  // "2022 energy crisis") and a candidate contains a DIFFERENT 4-digit
  // year (e.g. "1979 energy crisis"), they're talking about different
  // events and should NOT be merged, even if trigram similarity is high.
  // Critical for time-anchored entities (events, election years, etc.).
  const queryYears = (name.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/g) || []);
  for (const row of rows) {
    const candYears = (row.canonical_name.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/g) || []);
    // If both have years and the sets don't overlap → skip this candidate
    if (queryYears.length && candYears.length) {
      const overlap = queryYears.some(y => candYears.includes(y));
      if (!overlap) continue;
    }
    return row;
  }
  return null;
}

// ─── Entity upsert ──────────────────────────────────────────────────────────

/**
 * upsertEntity(entity, client?)
 *
 * Steps:
 *   1. Try to match against an existing local entity (trigram + alias check)
 *   2. If not found, try Wikidata search to get a verified QID
 *   3. If a QID was found AND that QID already exists locally, return that row
 *   4. Else, INSERT a new row
 *
 * Returns: { id, wikidata_qid, source: 'local'|'wikidata'|'new' }
 */
async function upsertEntity(entity, client) {
  const db = client || pool;

  // 1. Local match by name/alias
  const local = await findLocalEntity(entity.canonical_name, entity.entity_type, db);
  if (local) {
    // Merge any new aliases the extractor found into the existing row
    const newAliases = (entity.aliases || []).filter(a =>
      a.toLowerCase() !== local.canonical_name.toLowerCase() &&
      !(local.aliases || []).map(x => x.toLowerCase()).includes(a.toLowerCase())
    );
    if (newAliases.length) {
      await db.query(
        `UPDATE entities
            SET aliases    = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || $1::text[]))),
                updated_at = NOW()
          WHERE id = $2`,
        [newAliases, local.id]
      );
    }
    return { id: local.id, wikidata_qid: local.wikidata_qid, source: 'local' };
  }

  // 2. Wikidata lookup
  const wd = await searchWikidata(entity.canonical_name, entity.entity_type, entity.country_code);

  // 3. If Wikidata gave us a QID, check whether we already have a row with that QID
  if (wd?.qid) {
    const { rows: byQid } = await db.query(
      `SELECT id, wikidata_qid FROM entities WHERE wikidata_qid = $1 LIMIT 1`,
      [wd.qid]
    );
    if (byQid[0]) {
      // Add the extractor's name as an alias if it differs
      if (entity.canonical_name) {
        await db.query(
          `UPDATE entities
              SET aliases    = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$1]::text[]))),
                  updated_at = NOW()
            WHERE id = $2 AND lower(canonical_name) <> lower($1)`,
          [entity.canonical_name, byQid[0].id]
        );
      }
      return { id: byQid[0].id, wikidata_qid: byQid[0].wikidata_qid, source: 'wikidata' };
    }
  }

  // 4. Insert new row. Prefer Wikidata's canonical label if we got one,
  //    falling back to the extractor's canonical_name.
  const canonicalName = wd?.label || entity.canonical_name;
  const description   = entity.description || wd?.description || null;

  const { rows: inserted } = await db.query(
    `INSERT INTO entities
       (canonical_name, entity_type, wikidata_qid, aliases, description, country_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wikidata_qid) DO UPDATE
       SET updated_at = NOW()
     RETURNING id, wikidata_qid`,
    [
      canonicalName,
      entity.entity_type,
      wd?.qid || null,
      entity.aliases || [],
      description,
      entity.country_code || null
    ]
  );
  return { id: inserted[0].id, wikidata_qid: inserted[0].wikidata_qid, source: 'new' };
}

// ─── Article extraction save ────────────────────────────────────────────────

/**
 * saveArticleExtraction(articleId, extracted, opts)
 *
 * Persists the full extractor output for one article:
 *   - upserts every entity
 *   - inserts an article_entity_mentions row per (entity, role)
 *   - inserts article_referenced_dates rows
 *   - marks article_entity_extraction_state.status = 'done'
 *
 * @param {number} articleId
 * @param {object} extracted    - output of extractEntities()
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{
 *   entities: Array<{name, id, qid, source, role}>,
 *   dates_inserted: number,
 *   mentions_inserted: number
 * }>}
 */
async function saveArticleExtraction(articleId, extracted, opts = {}) {
  const dryRun = !!opts.dryRun;
  const client = await pool.connect();
  const summary = { entities: [], dates_inserted: 0, mentions_inserted: 0 };

  try {
    if (!dryRun) await client.query('BEGIN');

    // ── Resolve every entity (these may write to entities table)
    for (const ent of extracted.entities) {
      let resolved;
      if (dryRun) {
        // In dry-run, do the local + Wikidata lookups but don't INSERT/UPDATE
        const local = await findLocalEntity(ent.canonical_name, ent.entity_type, client);
        if (local) {
          resolved = { id: local.id, wikidata_qid: local.wikidata_qid, source: 'local' };
        } else {
          const wd = await searchWikidata(ent.canonical_name, ent.entity_type, ent.country_code);
          resolved = { id: null, wikidata_qid: wd?.qid || null, source: wd ? 'wikidata' : 'unresolved' };
        }
      } else {
        resolved = await upsertEntity(ent, client);
      }

      summary.entities.push({
        name:       ent.canonical_name,
        id:         resolved.id,
        qid:        resolved.wikidata_qid,
        source:     resolved.source,
        role:       ent.role,
        confidence: ent.confidence
      });

      // Insert the mention link (skip in dry-run, and skip if no entity id)
      if (!dryRun && resolved.id) {
        const ins = await client.query(
          `INSERT INTO article_entity_mentions
             (article_id, entity_id, role, confidence, extracted_by)
           VALUES ($1, $2, $3, $4, 'claude')
           ON CONFLICT (article_id, entity_id, role) DO NOTHING
           RETURNING id`,
          [articleId, resolved.id, ent.role, ent.confidence]
        );
        if (ins.rowCount > 0) summary.mentions_inserted++;
      }
    }

    // ── Insert referenced dates
    for (const d of extracted.referenced_dates) {
      if (dryRun) { summary.dates_inserted++; continue; }
      const ins = await client.query(
        `INSERT INTO article_referenced_dates
           (article_id, referenced_date, date_precision, context_snippet, confidence)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [articleId, d.referenced_date, d.date_precision, d.context_snippet, d.confidence]
      );
      if (ins.rowCount > 0) summary.dates_inserted++;
    }

    // ── Mark extraction state
    if (!dryRun) {
      await client.query(
        `INSERT INTO article_entity_extraction_state
           (article_id, status, entities_found, dates_found, processed_at)
         VALUES ($1, 'done', $2, $3, NOW())
         ON CONFLICT (article_id) DO UPDATE
           SET status         = 'done',
               entities_found = EXCLUDED.entities_found,
               dates_found    = EXCLUDED.dates_found,
               error_message  = NULL,
               processed_at   = NOW()`,
        [articleId, extracted.entities.length, extracted.referenced_dates.length]
      );

      await client.query('COMMIT');
    }
  } catch (err) {
    if (!dryRun) {
      await client.query('ROLLBACK');
      // Best-effort: mark as failed (outside the rolled-back tx)
      try {
        await pool.query(
          `INSERT INTO article_entity_extraction_state (article_id, status, error_message, processed_at)
           VALUES ($1, 'failed', $2, NOW())
           ON CONFLICT (article_id) DO UPDATE
             SET status        = 'failed',
                 error_message = EXCLUDED.error_message,
                 processed_at  = NOW()`,
          [articleId, err.message.slice(0, 500)]
        );
      } catch (_) { /* swallow */ }
    }
    throw err;
  } finally {
    client.release();
  }

  return summary;
}

// ─── Convenience: extract + resolve + save in one shot ──────────────────────

async function processArticle(article, opts = {}) {
  const extracted = await extractEntities(article);
  const summary   = await saveArticleExtraction(article.id, extracted, opts);
  return { extracted, summary };
}

/**
 * processArticleById(articleId, opts)
 *
 * Public entry point used by articleListener.js. Fetches the article row,
 * runs extraction + resolution + persistence. Skips silently if the article
 * has already been processed (extraction state = 'done' or 'processing').
 *
 * Designed to be fire-and-forget: throws on hard failures so the caller
 * can log them, but never blocks the rest of the ingest pipeline.
 */
async function processArticleById(articleId, opts = {}) {
  // Skip if already processed (idempotent under double-fire from notify trigger)
  const { rows: stateRows } = await pool.query(
    `SELECT status FROM article_entity_extraction_state WHERE article_id = $1`,
    [articleId]
  );
  if (stateRows[0] && (stateRows[0].status === 'done' || stateRows[0].status === 'processing')) {
    return { skipped: true, reason: stateRows[0].status };
  }

  // Mark as processing so concurrent listeners don't double-extract
  await pool.query(
    `INSERT INTO article_entity_extraction_state (article_id, status, processed_at)
     VALUES ($1, 'processing', NOW())
     ON CONFLICT (article_id) DO UPDATE
       SET status = 'processing', processed_at = NOW()
     WHERE article_entity_extraction_state.status NOT IN ('done', 'processing')`,
    [articleId]
  );

  // Fetch the article
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles WHERE id = $1`,
    [articleId]
  );
  const article = rows[0];
  if (!article) {
    await pool.query(
      `INSERT INTO article_entity_extraction_state (article_id, status, error_message, processed_at)
       VALUES ($1, 'failed', 'article not found', NOW())
       ON CONFLICT (article_id) DO UPDATE
         SET status = 'failed', error_message = 'article not found', processed_at = NOW()`,
      [articleId]
    );
    throw new Error(`article ${articleId} not found`);
  }

  // Skip articles with no usable text
  const hasText = article.title || article.summary || article.translated_summary;
  if (!hasText) {
    await pool.query(
      `INSERT INTO article_entity_extraction_state (article_id, status, processed_at)
       VALUES ($1, 'skipped', NOW())
       ON CONFLICT (article_id) DO UPDATE
         SET status = 'skipped', processed_at = NOW()`,
      [articleId]
    );
    return { skipped: true, reason: 'no text' };
  }

  return await processArticle(article, opts);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function fetchArticleById(id) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function fetchRandomArticle() {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles
      WHERE summary IS NOT NULL AND length(summary) > 200
      ORDER BY random() LIMIT 1`);
  return rows[0] || null;
}

async function fetchRecentArticles(n) {
  const { rows } = await pool.query(
    `SELECT id, title, summary, translated_summary, published_at
       FROM news_articles
      WHERE summary IS NOT NULL AND length(summary) > 200
      ORDER BY published_at DESC LIMIT $1`, [n]);
  return rows;
}

function printSummary(article, extracted, summary) {
  console.log('\n' + '═'.repeat(72));
  console.log(`Article #${article.id} — ${article.published_at ? new Date(article.published_at).toISOString().slice(0,10) : 'undated'}`);
  console.log(`TITLE: ${(article.title || '').slice(0, 100)}`);
  console.log('─'.repeat(72));
  console.log(`\nENTITIES (${summary.entities.length}):`);
  for (const e of summary.entities) {
    const tag = e.qid ? `[${e.qid}]` : '[no qid]';
    const src = `(${e.source})`;
    const id  = e.id ? `id=${e.id}` : 'id=—';
    console.log(`  • ${e.name.padEnd(40)} ${tag.padEnd(12)} ${e.role.padEnd(22)} ${src.padEnd(11)} ${id} @ ${e.confidence.toFixed(2)}`);
  }
  console.log(`\nREFERENCED DATES (${extracted.referenced_dates.length}):`);
  for (const d of extracted.referenced_dates) {
    console.log(`  • ${d.referenced_date} (${d.date_precision}) @ ${d.confidence.toFixed(2)}`);
    if (d.context_snippet) console.log(`      "${d.context_snippet}"`);
  }
  console.log(`\nWrites: ${summary.mentions_inserted} mention(s), ${summary.dates_inserted} date(s)`);
}

async function runCLI() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));
  const flag = args.find(a => a.startsWith('--') && a !== '--dry-run');

  if (!args.length || (args.length === 1 && args[0] === '--dry-run')) {
    console.log('Usage:');
    console.log('  node entityResolver.js <article_id> [--dry-run]');
    console.log('  node entityResolver.js --random [--dry-run]');
    console.log('  node entityResolver.js --recent=5 [--dry-run]');
    await pool.end();
    return;
  }

  let articles = [];
  if (flag === '--random') {
    const a = await fetchRandomArticle();
    if (a) articles = [a];
  } else if (flag && flag.startsWith('--recent=')) {
    const n = parseInt(flag.split('=')[1] || '5', 10);
    articles = await fetchRecentArticles(n);
  } else if (positional[0]) {
    const id = parseInt(positional[0], 10);
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

  if (dryRun) console.log('\n*** DRY RUN — no DB writes ***');

  for (const article of articles) {
    try {
      const t0 = Date.now();
      const { extracted, summary } = await processArticle(article, { dryRun });
      const ms = Date.now() - t0;
      printSummary(article, extracted, summary);
      console.log(`Processed in ${ms}ms`);
    } catch (err) {
      console.error(`\n✗ Article #${article.id} ERROR: ${err.message}`);
      if (err.raw) console.error(`  raw: ${err.raw.slice(0, 300)}`);
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
  await pool.end();
}

// ─── Public API ─────────────────────────────────────────────────────────────

module.exports = {
  searchWikidata,
  findLocalEntity,
  upsertEntity,
  saveArticleExtraction,
  processArticle,
  processArticleById,
};

if (require.main === module) {
  runCLI().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
