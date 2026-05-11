'use strict';
require('dotenv').config({ override: true });
process.env.DB_POOL_MAX = '1';
const pool = require('./db');

(async () => {
  // Proposed move ranges based on the seed-file ID-block pattern.
  // For each hoarder, list EVERY row in the proposed-stolen range so we
  // can visually verify it's 100% the victim's phrases.
  const PROPOSALS = [
    {
      label: 'BB → FR  : 23-24',
      hoarderId: 3, where: 'id IN (23, 24)',
    },
    {
      label: 'BB → FR  : 1009-1099',
      hoarderId: 3, where: 'id BETWEEN 1009 AND 1099',
    },
    {
      label: 'BB → FR  : 2761-2768',
      hoarderId: 3, where: 'id BETWEEN 2761 AND 2768',
    },
    {
      label: 'PE → BE  : 2109-2200',
      hoarderId: 22, where: 'id BETWEEN 2109 AND 2200',
    },
    {
      label: 'AL → LU  : 7008-7107',
      hoarderId: 26, where: 'id BETWEEN 7008 AND 7107',
    },
  ];

  for (const p of PROPOSALS) {
    const { rows } = await pool.query(
      `SELECT id, phrase FROM country_location_keywords
        WHERE country_id = $1 AND ${p.where}
        ORDER BY id`,
      [p.hoarderId]
    );
    console.log(`\n=== ${p.label}  (${rows.length} rows) ===`);
    for (const r of rows) {
      console.log(`  #${String(r.id).padStart(5)}  ${r.phrase}`);
    }
  }

  // Also: make sure no rows in the proposed range CURRENTLY have a
  // country_id other than the hoarder — that would indicate
  // mixing. (Sanity belt.)
  for (const p of PROPOSALS) {
    const { rows } = await pool.query(
      `SELECT id, phrase, country_id FROM country_location_keywords
        WHERE ${p.where} AND country_id <> $1
        ORDER BY id`,
      [p.hoarderId]
    );
    if (rows.length) {
      console.log(`\n⚠ ${p.label}: ${rows.length} rows in the range have a DIFFERENT country_id than the hoarder:`);
      console.table(rows);
    }
  }

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
