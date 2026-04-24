/**
 * keywordAnalyticsCron.js
 *
 * Precomputes per-keyword rollups that power the Keyword Intelligence
 * widget's inline "✦ Context" panels. Runs on Render as a cron (2×/day).
 *
 * For every keyword with >= MIN_RECENT_MENTIONS articles in the last
 * TRAIL_DAYS days, we compute:
 *   - total_mentions     (distinct-article count, all-time)
 *   - recent_mentions    (distinct-article count in the 7d window)
 *   - country_breakdown  (top 8 source countries + "+N more" bucket, with %)
 *   - sample_article_ids (10 most recent, priority-weighted, for Claude ctx)
 *
 * These rollups let /api/keywords/explain deliver the user-facing ✦ panel
 * with a single cheap read + a single Claude call (instead of computing
 * country breakdowns + picking articles live on every click).
 *
 * No Claude calls in this cron — purely SQL aggregation.
 *
 * Usage:
 *   node keywordAnalyticsCron.js                  # default (7d window)
 *   node keywordAnalyticsCron.js --days=14        # wider window
 *   node keywordAnalyticsCron.js --min=3          # lower threshold
 *   node keywordAnalyticsCron.js --keyword=iran   # process only one
 *   node keywordAnalyticsCron.js --dry-run        # skip writes
 */

"use strict";
require("dotenv").config({ override: true });
const pool = require("./db");

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, "").split("=");
  return [k, rest.length ? rest.join("=") : true];
}));
const DRY_RUN            = !!ARGV.get("dry-run");
const TRAIL_DAYS         = parseInt(ARGV.get("days") || "7", 10);
const MIN_RECENT         = parseInt(ARGV.get("min") || "3", 10);
const KEYWORD_FILTER     = ARGV.get("keyword") ? String(ARGV.get("keyword")).toLowerCase().trim() : null;
const TOP_COUNTRIES      = 8;
const SAMPLE_SIZE        = 10;
// Safety cap — prevents the cron from churning if the keyword tail ever
// explodes (would still take minutes, but bounded).
const MAX_KEYWORDS       = parseInt(ARGV.get("max") || "1500", 10);

function norm(kw) {
  return String(kw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n📊 Keyword Analytics Cron — ${new Date().toISOString()}`);
  console.log(`   mode: ${DRY_RUN ? "DRY RUN" : "WRITE"} | trail=${TRAIL_DAYS}d | min_recent=${MIN_RECENT}${KEYWORD_FILTER ? ` | keyword="${KEYWORD_FILTER}"` : ""}`);

  // Step 1 — find qualifying keywords. Bump statement_timeout on a
  // dedicated session because the GROUP BY over ak × articles can take
  // a few minutes on large corpora and the default (~60s on Render) was
  // failing the cron. Per-keyword queries below are cheap → pool default.
  let keywords;
  {
    const client = await pool.connect();
    try {
      await client.query(`SET statement_timeout = '10min'`);
      const keywordQuery = KEYWORD_FILTER
        ? `AND LOWER(COALESCE(ak.normalized_keyword, ak.keyword)) = $2`
        : ``;
      const params = [TRAIL_DAYS, ...(KEYWORD_FILTER ? [KEYWORD_FILTER] : [])];

      console.log(`   [${elapsed()}] Finding qualifying keywords (scan window: ${TRAIL_DAYS}d)...`);
      // Stopword filter matches the server's /api/keywords/trending endpoint
      // (server.js ~9857): `NOT EXISTS (SELECT 1 FROM stopwords sw WHERE sw.word = k.keyword)`.
      // Previously the cron computed analytics for ~50-100 stopword keywords
      // on every tick that the UI filtered out at read time — wasted rows,
      // wasted Claude calls on per-keyword `about` summaries, and bloat in
      // keyword_analytics. Matching the server filter eliminates that.
      const { rows } = await client.query(`
        SELECT
          LOWER(COALESCE(ak.normalized_keyword, ak.keyword))      AS keyword,
          (ARRAY_AGG(ak.keyword ORDER BY a.published_at DESC))[1] AS display_keyword,
          COUNT(DISTINCT a.id)                                    AS recent_mentions
        FROM article_keywords ak
        JOIN news_articles a ON a.id = ak.article_id
        WHERE a.published_at > NOW() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM stopwords sw
             WHERE sw.word = LOWER(COALESCE(ak.normalized_keyword, ak.keyword))
          )
          ${keywordQuery}
        GROUP BY LOWER(COALESCE(ak.normalized_keyword, ak.keyword))
        HAVING COUNT(DISTINCT a.id) >= ${MIN_RECENT}
        ORDER BY COUNT(DISTINCT a.id) DESC
        LIMIT ${MAX_KEYWORDS}
      `, params);
      keywords = rows;
    } finally {
      client.release();
    }
  }

  console.log(`   [${elapsed()}] ${keywords.length} qualifying keywords (min ${MIN_RECENT} recent mentions in last ${TRAIL_DAYS}d)`);
  if (!keywords.length) {
    console.log(`   nothing to do`);
    await pool.end();
    return;
  }

  // Use a dedicated client for the per-keyword loop with a higher
  // statement_timeout. Render's Postgres default kills long-running
  // statements at ~30-60s, which was cancelling the country-breakdown
  // query for high-traffic keywords (e.g. "usa", "oil") whose article
  // sets are huge. A 2-minute per-keyword ceiling is generous enough to
  // cover the LATERAL subject-country lookup but still caps the total
  // run at 1500 × 2min = bounded.
  const perKwClient = await pool.connect();
  try { await perKwClient.query(`SET statement_timeout = '2min'`); } catch (_) {}

  // Pre-materialise subject country per article into a TEMP TABLE. Hot
  // keywords ("donald trump", "family", "west") have thousands of matching
  // articles; a per-row LATERAL subselect timed out on Render. Building
  // one indexed temp table up front turns every per-keyword query into a
  // cheap PK lookup. Session-scoped — goes away when perKwClient releases.
  console.log(`   [${elapsed()}] Materialising subject-country lookup...`);
  let subjectTableReady = false;
  try {
    await perKwClient.query(`
      CREATE TEMP TABLE _kw_subject_country (
        article_id int PRIMARY KEY,
        country_id int NOT NULL
      )
    `);
    await perKwClient.query(`
      INSERT INTO _kw_subject_country (article_id, country_id)
      SELECT DISTINCT ON (article_id) article_id, country_id
        FROM article_locations
       WHERE routing_type = 'content'
         AND country_id IS NOT NULL
       ORDER BY article_id, country_id ASC
    `);
    const { rows: cntRows } = await perKwClient.query(`SELECT COUNT(*)::int AS n FROM _kw_subject_country`);
    console.log(`   [${elapsed()}] Subject-country table: ${cntRows[0].n} articles`);
    subjectTableReady = true;
  } catch (err) {
    console.warn(`   ⚠ Subject-country build failed (${err.message}) — falling back to source country attribution`);
  }

  let written = 0;
  let skipped = 0;
  try {
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const kwLower = kw.keyword;
    const display = (kw.display_keyword || kwLower).trim();

    try {
      // Country breakdown + sample article IDs for this keyword, computed
      // in two small queries so each is fast on the per-keyword hot path.

      // 2a. Country counts across the recent window.
      //
      // Attribution rule: prefer the SUBJECT country (entity-extracted from
      // article_locations, routing_type='content') over the article's
      // source country, so institutional keywords like "pentagon" or
      // "us senate" map to US regardless of which country's outlet wrote
      // the story. Falls back to source country for articles without
      // content routing so every article still contributes to the
      // distribution.
      //
      // _kw_subject_country is pre-built once at the top of the cron (temp
      // table with article_id PK). Makes this query a fast PK JOIN instead
      // of the LATERAL-per-row that timed out on hot keywords.
      const subjectJoin = subjectTableReady
        ? `LEFT JOIN _kw_subject_country sc ON sc.article_id = a.id`
        : ``;
      const countryExpr = subjectTableReady
        ? `COALESCE(sc.country_id, a.country_id)`
        : `a.country_id`;
      // Match via plain column equality so btree indexes idx_ak_normalized
      // and idx_ak_keyword get hit. The previous predicate
      // `LOWER(COALESCE(normalized_keyword, keyword)) = $1` was index-
      // hostile — forced a sequential scan of article_keywords for EVERY
      // keyword, which is why this loop was timing out on every word.
      // Keywords are already stored lowercased (keywordExtractor.js:80),
      // so dropping LOWER() is safe.
      const { rows: countryRows } = await perKwClient.query(`
        SELECT co.iso_code,
               co.name,
               COUNT(DISTINCT a.id)::int AS n
          FROM article_keywords ak
          JOIN news_articles a ON a.id = ak.article_id
          ${subjectJoin}
          LEFT JOIN countries co ON co.id = ${countryExpr}
         WHERE (ak.normalized_keyword = $1
                OR (ak.normalized_keyword IS NULL AND ak.keyword = $1))
           AND a.published_at > NOW() - ($2 || ' days')::interval
           AND co.iso_code IS NOT NULL
         GROUP BY co.iso_code, co.name
         ORDER BY n DESC
      `, [kwLower, TRAIL_DAYS]);

      const totalRecent = countryRows.reduce((s, r) => s + r.n, 0) || Number(kw.recent_mentions) || 0;
      const top = countryRows.slice(0, TOP_COUNTRIES);
      const rest = countryRows.slice(TOP_COUNTRIES);
      const breakdown = top.map(r => ({
        iso: r.iso_code,
        name: r.name || r.iso_code,
        n: r.n,
        pct: totalRecent ? Math.round((r.n / totalRecent) * 1000) / 10 : 0,
      }));
      if (rest.length) {
        const n = rest.reduce((s, r) => s + r.n, 0);
        breakdown.push({
          iso: null,
          name: `+${rest.length} more`,
          n,
          pct: totalRecent ? Math.round((n / totalRecent) * 1000) / 10 : 0,
        });
      }

      // 2b. Sample article IDs — newest-first with base_priority tie-break.
      // These feed the Claude prompt on /api/keywords/explain when a user
      // clicks context, so we want representative + recent + high-signal.
      const { rows: sampleRows } = await perKwClient.query(`
        SELECT DISTINCT ON (a.id)
               a.id,
               a.published_at,
               a.base_priority
          FROM article_keywords ak
          JOIN news_articles a ON a.id = ak.article_id
         WHERE (ak.normalized_keyword = $1
                OR (ak.normalized_keyword IS NULL AND ak.keyword = $1))
           AND a.published_at > NOW() - ($2 || ' days')::interval
         ORDER BY a.id, a.published_at DESC
         LIMIT 200
      `, [kwLower, TRAIL_DAYS]);
      // Final ordering on the small result set — Postgres's DISTINCT ON
      // forces an a.id-first ORDER BY, so we rerank after hydration.
      sampleRows.sort((a, b) => {
        const d = new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        if (d) return d;
        return (Number(b.base_priority) || 0) - (Number(a.base_priority) || 0);
      });
      const sampleIds = sampleRows.slice(0, SAMPLE_SIZE).map(r => Number(r.id));

      if (DRY_RUN) {
        if (i < 10) {
          console.log(`   [plan ${kwLower}] recent=${kw.recent_mentions} countries=${countryRows.length} (top: ${top.slice(0, 3).map(r => `${r.iso_code}:${r.n}`).join(', ')}) samples=${sampleIds.length}`);
        }
        written++;
        continue;
      }

      // total_mentions left at the same value as recent_mentions — the
      // historical full-corpus count was expensive to compute and unused
      // downstream. The /api/keywords/explain endpoint displays recent_mentions
      // prominently; users get an accurate "mentions in last 7d" number.
      await pool.query(`
        INSERT INTO keyword_analytics
          (keyword, display_keyword, total_mentions, recent_mentions,
           country_breakdown, sample_article_ids, refreshed_at)
        VALUES ($1, $2, $3, $3, $4::jsonb, $5::int[], NOW())
        ON CONFLICT (keyword) DO UPDATE SET
          display_keyword   = EXCLUDED.display_keyword,
          total_mentions    = EXCLUDED.total_mentions,
          recent_mentions   = EXCLUDED.recent_mentions,
          country_breakdown = EXCLUDED.country_breakdown,
          sample_article_ids= EXCLUDED.sample_article_ids,
          refreshed_at      = NOW()
      `, [kwLower, display, Number(kw.recent_mentions), JSON.stringify(breakdown), sampleIds]);

      written++;
      if (written % 100 === 0) console.log(`   [${elapsed()}] processed ${written}/${keywords.length}`);
    } catch (err) {
      skipped++;
      console.warn(`   ⚠ ${kwLower}: ${err.message}`);
    }
  }
  } finally {
    // Release the dedicated client even if the loop throws.
    try { perKwClient.release(); } catch (_) {}
  }

  console.log(`\n✅ ${DRY_RUN ? 'Dry run' : 'Done'} in ${elapsed()} — written=${written} skipped=${skipped}`);
  await pool.end();
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
