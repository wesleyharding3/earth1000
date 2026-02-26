// scoringEngine.js
const pool = require("./db");

/*
=========================================================
CONFIGURATION
=========================================================
*/
const ALPHA           = 0.35;   // Source prior weight
const BETA            = 0.65;   // Keyword signal weight
const FLIP_THRESHOLD  = 1.15;   // Keyword must beat prior by 15% to flip
const TITLE_WEIGHT    = 1.8;    // Title hit multiplier

/*
=========================================================
HELPERS
=========================================================
*/
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  const t = (text || "").trim();
  if (!t) return 1;
  return t.split(/\s+/).length;
}

/*
=========================================================
MAIN
=========================================================
*/
async function classifyArticle(articleId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ─────────────────────────────────────────
    // 1. Fetch article
    // ─────────────────────────────────────────
    const articleRes = await client.query(
      `SELECT id, translated_title, translated_summary, source_id
       FROM news_articles
       WHERE id = $1`,
      [articleId]
    );

    if (!articleRes.rows.length) throw new Error("Article not found");

    const article        = articleRes.rows[0];
    const normTitle      = normalize(article.translated_title);
    const normSummary    = normalize(article.translated_summary);
    const totalWords     = wordCount(normTitle) + wordCount(normSummary);

    // ─────────────────────────────────────────
    // 2. Source tag priors
    // ─────────────────────────────────────────
    const priorRes = await client.query(
      `SELECT tag_id, weight
       FROM source_tag_weights
       WHERE source_id = $1`,
      [article.source_id]
    );

    const sourcePriors = {};
    priorRes.rows.forEach(r => {
      sourcePriors[r.tag_id] = parseFloat(r.weight);
    });

    // ─────────────────────────────────────────
    // 3. Keyword scoring
    // ─────────────────────────────────────────
    const keywordRes = await client.query(`
      SELECT
        tk.tag_id,
        k.phrase,
        k.is_phrase,
        kt.base_score
      FROM tag_keywords tk
      JOIN keywords      k  ON k.id  = tk.keyword_id
      JOIN keyword_tiers kt ON kt.id = tk.tier_id
    `);

    const tagKeywordScores = {};

    for (const row of keywordRes.rows) {
      const phrase    = normalize(row.phrase);
      const baseScore = parseFloat(row.base_score);
      const tagId     = row.tag_id;

      let titleHits   = 0;
      let summaryHits = 0;

      if (row.is_phrase) {
        // Multi-word phrase — boundary-anchored regex
        const re      = new RegExp(`\\b${phrase}\\b`, "g");
        titleHits     = (normTitle.match(re)   || []).length;
        summaryHits   = (normSummary.match(re) || []).length;
      } else {
        // Single word — exact token match
        titleHits     = normTitle.split(" ").filter(w => w === phrase).length;
        summaryHits   = normSummary.split(" ").filter(w => w === phrase).length;
      }

      const weightedHits = (titleHits * TITLE_WEIGHT) + summaryHits;
      if (weightedHits === 0) continue;

      // Intensity: weighted hits scaled by keyword strength, normalised by doc length
      const intensity = (weightedHits * baseScore) / Math.sqrt(totalWords);

      tagKeywordScores[tagId] = (tagKeywordScores[tagId] || 0) + intensity;
    }

    // ─────────────────────────────────────────
    // 4. Combine prior + keyword signal
    // ─────────────────────────────────────────
    const allTagIds = new Set([
      ...Object.keys(sourcePriors).map(Number),
      ...Object.keys(tagKeywordScores).map(Number)
    ]);

    const finalScores = [];

    for (const tagId of allTagIds) {
      const prior        = sourcePriors[tagId]     || 0;
      const keywordScore = tagKeywordScores[tagId] || 0;

      const weightedPrior   = prior        * ALPHA;
      const weightedKeyword = keywordScore * BETA;

      let combined = weightedPrior + weightedKeyword;

      // Flip logic: keyword dominates → slight boost
      if (
        weightedKeyword > weightedPrior &&
        weightedPrior > 0 &&               // avoid divide-by-zero amplification
        weightedKeyword >= weightedPrior * FLIP_THRESHOLD
      ) {
        combined *= 1.1;
      }

      finalScores.push({ tagId, prior, keywordScore, combined });
    }

    // ─────────────────────────────────────────
    // 5. Sort
    // ─────────────────────────────────────────
    finalScores.sort((a, b) => b.combined - a.combined);

    if (!finalScores.length) {
      await client.query("COMMIT");
      return { success: false, reason: "No classification signal" };
    }

    // ─────────────────────────────────────────
    // 6. Write article_tags (top 3)
    // ─────────────────────────────────────────
    await client.query(
      `DELETE FROM article_tags WHERE article_id = $1`,
      [articleId]
    );

    const topTags = finalScores.slice(0, 3);

    for (let i = 0; i < topTags.length; i++) {
      const { tagId, combined } = topTags[i];
      await client.query(
        `INSERT INTO article_tags (article_id, tag_id, rank, score)
         VALUES ($1, $2, $3, $4)`,
        [articleId, tagId, i + 1, combined]
      );
    }

    // ─────────────────────────────────────────
    // 7. Compute + write base_priority
    //    priorityEngine reads this at query time,
    //    but we pre-compute a source-only baseline
    //    here so the field is never null.
    //
    //    Full re-score happens in priorityEngine
    //    using popularity_score at read time.
    // ─────────────────────────────────────────
    const topScore = topTags[0]?.combined || 0;

    await client.query(
      `UPDATE news_articles
       SET base_priority = $1
       WHERE id = $2`,
      [topScore, articleId]
    );

    await client.query("COMMIT");

    return { success: true, topTags };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("classifyArticle error:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { classifyArticle };