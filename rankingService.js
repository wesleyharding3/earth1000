// rankingService.js  (missing link)
const pool = require("./db");
const { rankArticles } = require("./priorityEngine");


async function getRankedArticles(countryId) {
  const { rows } = await pool.query(`
    SELECT
      a.id,
      a.title,
      a.published_at,
      ns.popularity_score,
      ns.popularity_tier,
      COALESCE(SUM(at.score), 0)         AS intensity,
      COALESCE(SUM(stw.weight), 0)       AS "tagWeightSum"
    FROM news_articles a
    JOIN news_sources ns       ON ns.id = a.source_id
    LEFT JOIN article_tags at  ON at.article_id = a.id
    LEFT JOIN source_tag_weights stw
                               ON stw.source_id = a.source_id
                               AND stw.tag_id = at.tag_id
    WHERE a.country_id = $1
      AND a.published_at > NOW() - INTERVAL '24 hours'
    GROUP BY a.id, ns.popularity_score, ns.popularity_tier
  `, [countryId]);

  const maxIntensity = Math.max(...rows.map(r => r.intensity), 1);
  return rankArticles(rows, maxIntensity);
}