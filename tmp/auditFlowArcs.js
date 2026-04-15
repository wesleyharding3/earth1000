require("dotenv").config();
const pool = require("../db");

const TARGETS = [
  { needle: "Iranian Hackers Breach Israeli Military", expect: ["Israel", "Iran"] },
  { needle: "Golestan Palace", expect: ["United States", "Israel", "Iran"] },
  { needle: "Cártel del Noreste", expect: ["United States", "Mexico", "EU"] },
  { needle: "Manhattan Protest Escalates", expect: ["Palestine", "Israel", "United States"] },
];

async function findThread(needle) {
  const { rows } = await pool.query(
    `SELECT id, title, status FROM story_threads
     WHERE title ILIKE $1
     ORDER BY id DESC LIMIT 3`,
    [`%${needle}%`]
  );
  return rows;
}

async function entityCountries(threadId) {
  const { rows } = await pool.query(`
    SELECT DISTINCT
      co.name AS place, co.iso_code AS iso,
      MIN(CASE aem.role WHEN 'subject' THEN 1 WHEN 'actor' THEN 2 WHEN 'location' THEN 3 ELSE 4 END) AS role_rank,
      COUNT(DISTINCT sta.article_id) AS mention_count
    FROM story_thread_articles sta
    JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
    JOIN entities e ON e.id = aem.entity_id
    JOIN countries co ON LOWER(co.iso_code) = LOWER(e.country_code)
    WHERE sta.thread_id = $1
      AND e.entity_type = 'location'
      AND aem.role IN ('subject','actor','location')
      AND aem.confidence >= 0.6
    GROUP BY co.name, co.iso_code
    ORDER BY role_rank, mention_count DESC
    LIMIT 15
  `, [threadId]);
  return rows;
}

async function contentCountries(threadId) {
  const { rows } = await pool.query(`
    SELECT co.name AS place, co.iso_code AS iso,
           COUNT(DISTINCT al.article_id) AS mention_count
    FROM story_thread_articles sta
    JOIN article_locations al ON al.article_id = sta.article_id
    JOIN countries co ON co.id = al.country_id
    WHERE sta.thread_id = $1 AND al.routing_type = 'content'
    GROUP BY co.name, co.iso_code
    ORDER BY mention_count DESC
    LIMIT 15
  `, [threadId]);
  return rows;
}

async function entityHits(threadId) {
  // Show ALL entity location mentions regardless of confidence/role,
  // to see where data is missing or filtered out.
  const { rows } = await pool.query(`
    SELECT e.canonical_name AS name, e.country_code, aem.role, aem.confidence,
           COUNT(DISTINCT aem.article_id) AS arts
    FROM story_thread_articles sta
    JOIN article_entity_mentions aem ON aem.article_id = sta.article_id
    JOIN entities e ON e.id = aem.entity_id
    WHERE sta.thread_id = $1 AND e.entity_type = 'location'
    GROUP BY e.canonical_name, e.country_code, aem.role, aem.confidence
    ORDER BY arts DESC
    LIMIT 30
  `, [threadId]);
  return rows;
}

async function articleCount(threadId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM story_thread_articles WHERE thread_id = $1`, [threadId]
  );
  return rows[0].n;
}

(async () => {
  for (const t of TARGETS) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`SEARCH: "${t.needle}"  → expects: ${t.expect.join(", ")}`);
    const threads = await findThread(t.needle);
    if (!threads.length) { console.log("  ❌ NO THREAD FOUND"); continue; }
    for (const th of threads) {
      const n = await articleCount(th.id);
      console.log(`\n  Thread #${th.id} [${th.status}] "${th.title}" — ${n} articles`);

      const ec = await entityCountries(th.id);
      console.log(`  Entity-route countries (used for arcs, ≥0.6 conf, subj/actor/loc):`);
      if (!ec.length) console.log("    (none) — falls back to content-routed");
      ec.forEach(r => console.log(`    • ${r.place} [${r.iso}] role_rank=${r.role_rank} arts=${r.mention_count}`));

      if (ec.length < 2) {
        const cc = await contentCountries(th.id);
        console.log(`  Fallback content-routed countries:`);
        cc.forEach(r => console.log(`    • ${r.place} [${r.iso}] arts=${r.mention_count}`));
      }

      const missing = t.expect.filter(name =>
        !ec.some(r => r.place.toLowerCase().includes(name.toLowerCase().split(" ")[0]))
      );
      if (missing.length) {
        console.log(`  ⚠️  MISSING from entity arcs: ${missing.join(", ")}`);
        console.log(`  All entity hits (any role/conf):`);
        const eh = await entityHits(th.id);
        eh.forEach(r => console.log(`    · ${r.name} cc=${r.country_code} role=${r.role} conf=${r.confidence} arts=${r.arts}`));
      }
    }
  }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
