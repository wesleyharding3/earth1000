// rankingService.js
const pool = require("./db");
const { rankArticles } = require("./priorityEngine");

const ARTICLE_FIELDS = `
  a.id,
  a.title,
  a.translated_title,
  a.url,
  a.article_url,
  a.summary,
  a.translated_summary,
  a.image_url,
  a.published_at,
  ns.name            AS source_name,
  ns.site_url,
  ns.popularity_score,
  ns.popularity_tier,
  co.iso_code,
  COALESCE(SUM(at.score), 0)   AS intensity,
  COALESCE(SUM(stw.weight), 0) AS "tagWeightSum"
`;

const ARTICLE_JOINS = `
  JOIN news_sources ns      ON ns.id = a.source_id
  LEFT JOIN article_tags at ON at.article_id = a.id
  LEFT JOIN source_tag_weights stw
                            ON stw.source_id = a.source_id
                            AND stw.tag_id = at.tag_id
  LEFT JOIN countries co    ON co.id = a.country_id
`;

// National feed
async function getRankedArticles(countryId) {
  const { rows } = await pool.query(`
    SELECT ${ARTICLE_FIELDS}
    FROM news_articles a
    ${ARTICLE_JOINS}
    WHERE a.country_id = $1
      AND a.city_id IS NULL
      AND a.published_at > NOW() - INTERVAL '24 hours'
    GROUP BY a.id, ns.id, co.iso_code
  `, [countryId]);

  const maxIntensity = Math.max(...rows.map(r => r.intensity), 1);
  return rankArticles(rows, maxIntensity);
}

// City feed
async function getRankedCityArticles(cityId) {
  const { rows } = await pool.query(`
    SELECT ${ARTICLE_FIELDS}
    FROM news_articles a
    ${ARTICLE_JOINS}
    WHERE a.city_id = $1
      AND a.published_at > NOW() - INTERVAL '24 hours'
    GROUP BY a.id, ns.id, co.iso_code
  `, [cityId]);

  const maxIntensity = Math.max(...rows.map(r => r.intensity), 1);
  return rankArticles(rows, maxIntensity);
}

module.exports = { getRankedArticles, getRankedCityArticles };