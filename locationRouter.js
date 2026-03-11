// locationRouter.js
const pool = require("./db");

/*
=========================================================
HELPERS
=========================================================
*/
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countHits(text, phrase, isPhrase) {
  if (!text || !phrase) return 0;
  if (isPhrase) {
    // Unicode-aware boundary: no letter/number before or after the phrase
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
    return (text.match(re) || []).length;
  }
  // For space-separated scripts (Latin, Cyrillic, Arabic etc.), match exact word
  // For CJK and other scripts with no spaces, use substring match
  if (text.includes(" ")) {
    return text.split(" ").filter(w => w === phrase).length;
  }
  return text.includes(phrase) ? 1 : 0;
}

/*
=========================================================
MAIN
=========================================================
*/
async function routeArticle(articleId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ─────────────────────────────────────────
    // 1. Fetch article
    //    COALESCE: translated if available,
    //    fall back to original for English sources
    // ─────────────────────────────────────────
    const articleRes = await client.query(
      `SELECT
         a.id,
         a.source_id,
         a.country_id                              AS source_country_id,
         a.city_id                                 AS source_city_id,
         ns.city_id                                AS ns_city_id,
         ns.country_id                             AS ns_country_id,
         COALESCE(a.translated_title, a.title)     AS search_title,
         COALESCE(a.translated_summary, a.summary) AS search_summary
       FROM news_articles a
       JOIN news_sources ns ON ns.id = a.source_id
       WHERE a.id = $1`,
      [articleId]
    );

    if (!articleRes.rows.length) throw new Error("Article not found");

    const article     = articleRes.rows[0];
    const normTitle   = normalize(article.search_title);
    const normSummary = normalize(article.search_summary);

    // ─────────────────────────────────────────
    // 2. Source routing
    //
    //    Municipal  (ns.city_id set)    → insert article_locations row for its city
    //    National   (ns.country_id set) → no article_locations row needed;
    //                                     a.country_id on the article handles local feed
    //    International (both null)      → skip source routing entirely;
    //                                     content routing (steps 3+4) handles all placement
    // ─────────────────────────────────────────
    if (article.ns_city_id) {
      await client.query(
        `INSERT INTO article_locations
           (article_id, country_id, city_id, routing_type)
         VALUES ($1, $2, $3, 'source')
         ON CONFLICT DO NOTHING`,
        [articleId, article.source_country_id, article.ns_city_id]
      );
    } else if (article.ns_country_id) {
      // National source — local feed reads directly from a.country_id, nothing to do here
    } else {
      // International source — content routing only, will not appear in any local feed
      console.log(`🌐 Intl source: article ${articleId} — content routing only`);
    }

    // ─────────────────────────────────────────
    // 3. Content routing — city keywords
    // ─────────────────────────────────────────
    const cityKeywordRes = await client.query(`
      SELECT
        clk.city_id,
        clk.country_id,
        clk.phrase,
        clk.is_phrase,
        clk.threshold,
        kt.base_score
      FROM city_location_keywords clk
      JOIN keyword_tiers kt ON kt.id = clk.tier_id
    `);

    const cityScores = {};

    for (const row of cityKeywordRes.rows) {
      const phrase  = normalize(row.phrase);
      const cityId  = row.city_id;

      const titleHits   = countHits(normTitle,   phrase, row.is_phrase);
      const summaryHits = countHits(normSummary, phrase, row.is_phrase);
      const totalHits   = (titleHits * 1.8) + summaryHits;

      if (totalHits === 0) continue;

      const score = totalHits * parseFloat(row.base_score);

      if (!cityScores[cityId]) {
        cityScores[cityId] = {
          score:      0,
          threshold:  parseFloat(row.threshold),
          country_id: row.country_id,
          hits:       []
        };
      }
      cityScores[cityId].score += score;
      cityScores[cityId].hits.push({ phrase: row.phrase, score });
    }

    for (const [cityId, data] of Object.entries(cityScores)) {
      if (data.score >= data.threshold) {
        await client.query(
          `INSERT INTO article_locations
             (article_id, country_id, city_id, routing_type)
           VALUES ($1, $2, $3, 'content')
           ON CONFLICT DO NOTHING`,
          [articleId, data.country_id, parseInt(cityId)]
        );
        console.log(`📍 City routed: article ${articleId} → city ${cityId} (score: ${data.score.toFixed(3)}) — hits: ${JSON.stringify(data.hits)}`);
      }
    }

    // ─────────────────────────────────────────
    // 4. Content routing — country keywords
    // ─────────────────────────────────────────
    const countryKeywordRes = await client.query(`
      SELECT
        clk.country_id,
        clk.phrase,
        clk.is_phrase,
        clk.threshold,
        kt.base_score
      FROM country_location_keywords clk
      JOIN keyword_tiers kt ON kt.id = clk.tier_id
    `);

    const countryScores = {};

    for (const row of countryKeywordRes.rows) {
      const phrase    = normalize(row.phrase);
      const countryId = row.country_id;

      const titleHits   = countHits(normTitle,   phrase, row.is_phrase);
      const summaryHits = countHits(normSummary, phrase, row.is_phrase);
      const totalHits   = (titleHits * 1.8) + summaryHits;

      if (totalHits === 0) continue;

      const score = totalHits * parseFloat(row.base_score);

      if (!countryScores[countryId]) {
        countryScores[countryId] = {
          score:     0,
          threshold: parseFloat(row.threshold),
          hits:      []
        };
      }
      countryScores[countryId].score += score;
      countryScores[countryId].hits.push({ phrase: row.phrase, score });
    }

    for (const [countryId, data] of Object.entries(countryScores)) {
      if (data.score >= data.threshold) {
        await client.query(
          `INSERT INTO article_locations
             (article_id, country_id, city_id, routing_type)
           VALUES ($1, $2, NULL, 'content')
           ON CONFLICT DO NOTHING`,
          [articleId, parseInt(countryId)]
        );
        console.log(`🌍 Country routed: article ${articleId} → country ${countryId} (score: ${data.score.toFixed(3)}) — hits: ${JSON.stringify(data.hits)}`);
      }
    }

    await client.query("COMMIT");

    return { success: true };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("routeArticle error:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { routeArticle };