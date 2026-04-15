require("dotenv").config();
const pool = require("../db");

const THREADS = [
  { id: 8203, title: "Iranian Hackers" },
  { id: 8479, title: "Golestan Palace" },
  { id: 8502, title: "Cártel del Noreste" },
  { id: 8463, title: "Manhattan Protest" },
];

(async () => {
  for (const t of THREADS) {
    console.log(`\n${"=".repeat(70)}\nThread #${t.id} — ${t.title}`);

    // Articles in this thread
    const { rows: arts } = await pool.query(`
      SELECT a.id, a.title, a.country_id, c.name AS routed_country
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries c ON c.id = a.country_id
      WHERE sta.thread_id = $1 ORDER BY a.id
    `, [t.id]);
    console.log(`Articles (${arts.length}):`);
    arts.forEach(a => console.log(`  #${a.id} routed=${a.routed_country || '—'} | ${a.title?.slice(0,80)}`));

    const ids = arts.map(a => a.id);
    if (!ids.length) continue;

    // ALL article_locations rows for these articles (any routing_type)
    const { rows: locs } = await pool.query(`
      SELECT a.id AS art, c.name AS country, c.iso_code, al.routing_type
      FROM article_locations al
      JOIN news_articles a ON a.id = al.article_id
      JOIN countries c ON c.id = al.country_id
      WHERE a.id = ANY($1::int[])
      ORDER BY a.id, al.routing_type
    `, [ids]);
    console.log(`\nArticle locations (all routing types):`);
    locs.forEach(l => console.log(`  art=${l.art} ${l.country} [${l.iso_code}] routing=${l.routing_type}`));

    // ALL entity mentions on these articles (no role/confidence filter, no location filter)
    const { rows: ems } = await pool.query(`
      SELECT a.id AS art, e.canonical_name, e.entity_type, e.country_code,
             aem.role, aem.confidence
      FROM article_entity_mentions aem
      JOIN entities e ON e.id = aem.entity_id
      JOIN news_articles a ON a.id = aem.article_id
      WHERE a.id = ANY($1::int[])
      ORDER BY a.id, e.entity_type, aem.role
    `, [ids]);
    console.log(`\nEntity mentions (all):`);
    if (!ems.length) console.log(`  ❌ ZERO entity mentions for any article in this thread`);
    ems.forEach(m => console.log(
      `  art=${m.art} [${m.entity_type}] ${m.canonical_name} cc=${m.country_code} role=${m.role} conf=${m.confidence}`
    ));
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
