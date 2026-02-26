// scoringEngine.js

const pool = require("./db");

/*
=========================================================
CONFIGURATION
=========================================================
*/

const ALPHA = 0.35;            // Source prior weight
const BETA = 0.65;             // Keyword dominance
const FLIP_THRESHOLD = 1.15;   // Keyword must beat prior by 15%
const TITLE_WEIGHT = 1.8;      // Headline importance multiplier

/*
=========================================================
HELPERS
=========================================================
*/

// Normalize text
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Word count
function wordCount(text) {
  if (!text) return 1;
  return text.split(/\s+/).length || 1;
}

/*
=========================================================
MAIN CLASSIFICATION FUNCTION
=========================================================
*/

async function classifyArticle(articleId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
    =========================================================
    1️⃣ Fetch Article (Translated Fields Only)
    =========================================================
    */

    const articleRes = await client.query(
      `SELECT a.id,
              a.translated_title,
              a.translated_summary,
              a.source_id
       FROM news_articles a
       WHERE a.id = $1`,
      [articleId]
    );

    if (!articleRes.rows.length) {
      throw new Error("Article not found");
    }

    const article = articleRes.rows[0];

    const title = article.translated_title || "";
    const summary = article.translated_summary || "";

    const normalizedTitle = normalize(title);
    const normalizedSummary = normalize(summary);

    const totalWords =
      wordCount(normalizedTitle) +
      wordCount(normalizedSummary);

    /*
    =========================================================
    2️⃣ Fetch Source Tag Priors
    =========================================================
    */

    const priorRes = await client.query(
      `SELECT tag_id, weight
       FROM source_tag_weights
       WHERE source_id = $1`,
      [article.source_id]
    );

    const sourcePriors = {};
    priorRes.rows.forEach(row => {
      sourcePriors[row.tag_id] = parseFloat(row.weight);
    });

    /*
    =========================================================
    3️⃣ Fetch All Keywords + Tiers
    =========================================================
    */

    const keywordRes = await client.query(`
      SELECT 
        tk.tag_id,
        k.phrase,
        k.is_phrase,
        kt.base_score
      FROM tag_keywords tk
      JOIN keywords k ON k.id = tk.keyword_id
      JOIN keyword_tiers kt ON kt.id = tk.tier_id
    `);

    const tagKeywordScores = {};

    for (const row of keywordRes.rows) {
      const tagId = row.tag_id;
      const phrase = normalize(row.phrase);
      const baseScore = parseFloat(row.base_score);

      let titleOccurrences = 0;
      let summaryOccurrences = 0;

      if (row.is_phrase) {
        const regex = new RegExp(`\\b${phrase}\\b`, "g");

        const titleMatches = normalizedTitle.match(regex);
        const summaryMatches = normalizedSummary.match(regex);

        titleOccurrences = titleMatches ? titleMatches.length : 0;
        summaryOccurrences = summaryMatches ? summaryMatches.length : 0;

      } else {
        const titleWords = normalizedTitle.split(" ");
        const summaryWords = normalizedSummary.split(" ");

        titleOccurrences = titleWords.filter(w => w === phrase).length;
        summaryOccurrences = summaryWords.filter(w => w === phrase).length;
      }

      const weightedOccurrences =
        (titleOccurrences * TITLE_WEIGHT) +
        summaryOccurrences;

      if (weightedOccurrences > 0) {
        if (!tagKeywordScores[tagId]) {
          tagKeywordScores[tagId] = 0;
        }

        const intensity =
          (weightedOccurrences * baseScore) /
          Math.sqrt(totalWords);

        tagKeywordScores[tagId] += intensity;
      }
    }

    /*
    =========================================================
    4️⃣ Combine Prior + Keyword Signal
    =========================================================
    */

    const allTagIds = new Set([
      ...Object.keys(sourcePriors),
      ...Object.keys(tagKeywordScores)
    ]);

    const finalScores = [];

    for (const tagId of allTagIds) {
      const prior = sourcePriors[tagId] || 0;
      const keywordScore = tagKeywordScores[tagId] || 0;

      const combined =
        (prior * ALPHA) +
        (keywordScore * BETA);

      finalScores.push({
        tagId: parseInt(tagId),
        prior,
        keywordScore,
        combined
      });
    }

    /*
    =========================================================
    5️⃣ Flip Logic (Keyword Override)
    =========================================================
    */

    finalScores.forEach(obj => {
      const weightedPrior = obj.prior * ALPHA;
      const weightedKeyword = obj.keywordScore * BETA;

      if (
        weightedKeyword > weightedPrior &&
        weightedKeyword >= weightedPrior * FLIP_THRESHOLD
      ) {
        obj.combined *= 1.1; // slight dominance boost
      }
    });

    /*
    =========================================================
    6️⃣ Sort + Early Exit If No Signal
    =========================================================
    */

    finalScores.sort((a, b) => b.combined - a.combined);

    if (finalScores.length === 0) {
      await client.query("COMMIT");
      return { success: false, reason: "No classification signal" };
    }

    /*
    =========================================================
    7️⃣ Store Top 3 Tags
    =========================================================
    */

    await client.query(
      `DELETE FROM article_tags WHERE article_id = $1`,
      [articleId]
    );

    const topTags = finalScores.slice(0, 3);

    for (let i = 0; i < topTags.length; i++) {
      const tag = topTags[i];

      await client.query(
        `INSERT INTO article_tags
         (article_id, tag_id, rank, score)
         VALUES ($1, $2, $3, $4)`,
        [articleId, tag.tagId, i + 1, tag.combined]
      );
    }

    await client.query("COMMIT");

    return {
      success: true,
      topTags
    };

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Classification error:", err);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  classifyArticle
};