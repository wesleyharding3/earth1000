#!/usr/bin/env node
'use strict';

/**
 * _apply_round1_sources.js
 *
 * Stage 1 of the source-coverage expansion:
 *   1. Pakistan The News merge — keeps #1609 (country-level, active),
 *      deletes the three city-level duplicates (Lahore #131, Karachi
 *      #2963, Peshawar #25090). All four point at thenews.com.pk; the
 *      city ones add no unique articles, just RSS-feed duplication.
 *   2. Insert Round-1 candidate sources (Palestine + 18 CRITICAL gap
 *      countries) as is_active=false so the auto-tester picks them
 *      up. Each insert places site_url AND rss_url at the same URL —
 *      the tester's probeFeeds() will discover the real RSS endpoint
 *      (or fall back to HTML scraping config) and update the row.
 *   3. Mark every existing source with last_success_at IS NULL as
 *      is_active=false so the auto-tester reaches them in the same
 *      pass.
 *
 * Output:
 *   - tmp/round1-staging-<ts>/inserted_ids.json  (new candidate IDs)
 *   - tmp/round1-staging-<ts>/deleted_ids.json   (Pakistan TNS dups)
 *   - tmp/round1-staging-<ts>/stranded_ids.json  (existing never-
 *                                                  fetched sources
 *                                                  to retest)
 *   - stdout summary
 *
 * No source_test runs in this script — that's _auto_test_sources.js.
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const fs = require('fs');
const path = require('path');

// ─── Round-1 candidates ────────────────────────────────────────────────
// Hand-curated from Round 1 in chat. Site-only URLs (no RSS guess) —
// the auto-tester probes for RSS via <link rel=alternate> + standard
// /feed paths; if nothing's found it falls back to HTML scraping.
// A handful are deliberately omitted from the chat list because they
// look diaspora-based or otherwise fail the user's "based in target
// entity" rule.
const CANDIDATES = [
  // ── Palestine (priority — country shows 0 sources today) ────────────
  { name: 'WAFA Palestinian News Agency (English)', site_url: 'https://english.wafa.ps',         country_iso: 'PS', language: 'en' },
  { name: 'WAFA Palestinian News Agency',           site_url: 'https://www.wafa.ps',             country_iso: 'PS', language: 'ar' },
  { name: 'Maan News Agency',                       site_url: 'https://www.maannews.net',        country_iso: 'PS', language: 'ar' },
  { name: 'Palestine News Network',                 site_url: 'https://english.pnn.ps',          country_iso: 'PS', language: 'en' },
  { name: 'Sama News Agency',                       site_url: 'https://samanews.ps',             country_iso: 'PS', language: 'ar' },
  { name: 'Quds News Network',                      site_url: 'https://qudsn.com',               country_iso: 'PS', language: 'ar' },
  { name: 'Quds News Network (English)',            site_url: 'https://qudsnen.co',              country_iso: 'PS', language: 'en' },
  { name: 'Al-Quds Newspaper',                      site_url: 'https://www.alquds.com',          country_iso: 'PS', language: 'ar' },
  { name: 'Al-Ayyam',                               site_url: 'https://www.al-ayyam.ps',         country_iso: 'PS', language: 'ar' },
  { name: 'Al-Hayat al-Jadida',                     site_url: 'https://www.alhaya.ps',           country_iso: 'PS', language: 'ar' },
  { name: 'Felesteen Online',                       site_url: 'https://felesteen.ps',            country_iso: 'PS', language: 'ar' },
  { name: 'Filastin Al-Yawm',                       site_url: 'https://paltoday.ps',             country_iso: 'PS', language: 'ar' },
  { name: 'Shehab News Agency',                     site_url: 'https://shehab.ps',               country_iso: 'PS', language: 'ar' },
  { name: 'Dunia Al-Watan',                         site_url: 'https://www.alwatanvoice.com',    country_iso: 'PS', language: 'ar' },
  { name: 'Al-Shabaka',                             site_url: 'https://al-shabaka.org',          country_iso: 'PS', language: 'en' },
  // Institute for Palestine Studies — research-heavy, low cadence,
  // but on-topic for the user's geopolitical/trade brief.
  { name: 'Institute for Palestine Studies',        site_url: 'https://www.palestine-studies.org', country_iso: 'PS', language: 'en' },

  // ── Côte d'Ivoire (CI) ──
  { name: 'Fraternité Matin',                       site_url: 'https://www.fratmat.info',        country_iso: 'CI', language: 'fr' },
  { name: 'L\'Infodrôme',                           site_url: 'https://www.linfodrome.com',      country_iso: 'CI', language: 'fr' },
  { name: 'KOACI',                                  site_url: 'https://www.koaci.com',           country_iso: 'CI', language: 'fr' },
  { name: 'Agence Ivoirienne de Presse',            site_url: 'https://aip.ci',                  country_iso: 'CI', language: 'fr' },

  // ── Czech Republic (CZ) ──
  { name: 'iDNES',                                  site_url: 'https://www.idnes.cz',            country_iso: 'CZ', language: 'cs' },
  { name: 'Seznam Zprávy',                          site_url: 'https://www.seznamzpravy.cz',     country_iso: 'CZ', language: 'cs' },
  { name: 'Deník N',                                site_url: 'https://denikn.cz',               country_iso: 'CZ', language: 'cs' },
  { name: 'Hospodářské noviny',                     site_url: 'https://hn.cz',                   country_iso: 'CZ', language: 'cs' },
  { name: 'Czech Radio (Radio Prague Intl)',        site_url: 'https://english.radio.cz',        country_iso: 'CZ', language: 'en' },
  { name: 'Expats CZ',                              site_url: 'https://www.expats.cz',           country_iso: 'CZ', language: 'en' },

  // ── Hong Kong (HK) ──
  { name: 'South China Morning Post',               site_url: 'https://www.scmp.com',            country_iso: 'HK', language: 'en' },
  { name: 'The Standard HK',                        site_url: 'https://www.thestandard.com.hk',  country_iso: 'HK', language: 'en' },
  { name: 'Hong Kong Free Press',                   site_url: 'https://hongkongfp.com',          country_iso: 'HK', language: 'en' },
  { name: 'HK01',                                   site_url: 'https://www.hk01.com',            country_iso: 'HK', language: 'zh' },
  { name: 'Ming Pao',                               site_url: 'https://www.mingpao.com',         country_iso: 'HK', language: 'zh' },
  { name: 'Dimsum Daily',                           site_url: 'https://www.dimsumdaily.hk',      country_iso: 'HK', language: 'en' },
  { name: 'RTHK',                                   site_url: 'https://www.rthk.hk/news',        country_iso: 'HK', language: 'en' },

  // ── Macao (MO) ──
  { name: 'Macao Business',                         site_url: 'https://www.macaobusiness.com',   country_iso: 'MO', language: 'en' },
  { name: 'TDM Macau',                              site_url: 'https://www.tdm.com.mo',          country_iso: 'MO', language: 'pt' },
  { name: 'Macao News',                             site_url: 'https://macaonews.org',           country_iso: 'MO', language: 'en' },

  // ── Mauritius (MU) ──
  { name: 'L\'Express Mauritius',                   site_url: 'https://www.lexpress.mu',         country_iso: 'MU', language: 'fr' },
  { name: 'Le Défi Media',                          site_url: 'https://defimedia.info',          country_iso: 'MU', language: 'fr' },
  { name: 'Le Mauricien',                           site_url: 'https://www.lemauricien.com',     country_iso: 'MU', language: 'fr' },
  { name: 'News.mu',                                site_url: 'https://news.mu',                 country_iso: 'MU', language: 'en' },

  // ── Seychelles (SC) ──
  { name: 'Seychelles News Agency',                 site_url: 'https://www.seychellesnewsagency.com', country_iso: 'SC', language: 'en' },
  { name: 'Seychelles Nation',                      site_url: 'https://www.nation.sc',           country_iso: 'SC', language: 'en' },
  { name: 'Today in Seychelles',                    site_url: 'https://www.today.sc',            country_iso: 'SC', language: 'en' },

  // ── Vatican City (VA) ──
  { name: 'Vatican News',                           site_url: 'https://www.vaticannews.va/en.html', country_iso: 'VA', language: 'en' },
  { name: 'L\'Osservatore Romano',                  site_url: 'https://www.osservatoreromano.va', country_iso: 'VA', language: 'it' },
  { name: 'ACI Stampa',                             site_url: 'https://www.acistampa.com',       country_iso: 'VA', language: 'it' },

  // ── Western Sahara (EH) — disputed-territory media is thin ──
  { name: 'Sahara Press Service',                   site_url: 'https://www.spsrasd.info',        country_iso: 'EH', language: 'es' },
  { name: 'Equipe Media',                           site_url: 'https://www.ecsaharaui.com',      country_iso: 'EH', language: 'es' },

  // ── Tonga (TO) ──
  { name: 'Matangi Tonga',                          site_url: 'https://matangitonga.to',         country_iso: 'TO', language: 'en' },

  // ── Vanuatu (VU) ──
  { name: 'Vanuatu Daily Post',                     site_url: 'https://www.dailypost.vu',        country_iso: 'VU', language: 'en' },
  { name: 'VBTC',                                   site_url: 'https://www.vbtc.vu',             country_iso: 'VU', language: 'en' },

  // ── Sint Maarten (SX) ──
  { name: 'The Daily Herald SXM',                   site_url: 'https://www.thedailyherald.sx',   country_iso: 'SX', language: 'en' },
  { name: '721News',                                site_url: 'https://721news.com',             country_iso: 'SX', language: 'en' },
  { name: 'SMN News',                               site_url: 'https://www.smn-news.com',        country_iso: 'SX', language: 'en' },

  // ── Sao Tome and Principe (ST) ──
  { name: 'STP Press',                              site_url: 'https://www.stp-press.st',        country_iso: 'ST', language: 'pt' },
  { name: 'Téla Nón',                               site_url: 'https://www.telanon.info',        country_iso: 'ST', language: 'pt' },

  // ── Federated States of Micronesia (FM) ──
  { name: 'Kaselehlie Press',                       site_url: 'https://www.kpress.info',         country_iso: 'FM', language: 'en' },

  // ── Palau (PW) ──
  { name: 'Island Times Palau',                     site_url: 'https://islandtimes.org',         country_iso: 'PW', language: 'en' },
  { name: 'Tia Belau',                              site_url: 'https://www.tiabelau.com',        country_iso: 'PW', language: 'en' },

  // ── Kiribati (KI) ──
  { name: 'Kiribati Updates',                       site_url: 'https://kiribatiupdates.com.ki',  country_iso: 'KI', language: 'en' },

  // ── Dominica (DM) ──
  { name: 'Dominica News Online',                   site_url: 'https://dominicanewsonline.com',  country_iso: 'DM', language: 'en' },
  { name: 'The Sun Dominica',                       site_url: 'https://www.thesundominica.com',  country_iso: 'DM', language: 'en' },

  // (Nauru/Tuvalu/Marshall Islands intentionally light — those nations
  //  genuinely have minimal independent press; what's there is in the
  //  HIGH-gap audit already.)
];

const PAKISTAN_TNS_DELETE_IDS = [131, 2963, 25090]; // keep #1609

async function main() {
  const t0 = Date.now();
  console.log(`[round1] starting at ${new Date().toISOString()}`);

  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'tmp', `round1-staging-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  // ── 1. Pakistan The News merge ──────────────────────────────────────
  console.log(`\n[round1] step 1: Pakistan The News merge`);
  // Confirm the survivor still exists before deleting duplicates so
  // we never leave Pakistan with zero TNS records.
  const survivor = await pool.query(`SELECT id, name, is_active FROM news_sources WHERE id = 1609`);
  if (!survivor.rows.length) {
    throw new Error('Survivor Pakistan TNS row #1609 is missing — aborting merge.');
  }
  console.log(`  keeper: #1609 ${survivor.rows[0].name} (active=${survivor.rows[0].is_active})`);
  const delResult = await pool.query(
    `DELETE FROM news_sources WHERE id = ANY($1::int[]) RETURNING id, name`,
    [PAKISTAN_TNS_DELETE_IDS]
  );
  console.log(`  deleted ${delResult.rows.length} duplicates: ${delResult.rows.map(r => `#${r.id}`).join(', ')}`);
  fs.writeFileSync(path.join(outDir, 'deleted_ids.json'), JSON.stringify(delResult.rows, null, 2));

  // ── 2. Country-id lookup for candidates ─────────────────────────────
  console.log(`\n[round1] step 2: Insert ${CANDIDATES.length} new candidate sources`);
  const isos = Array.from(new Set(CANDIDATES.map(c => c.country_iso)));
  const { rows: countryRows } = await pool.query(
    `SELECT id, iso_code FROM countries WHERE iso_code = ANY($1::char(2)[])`,
    [isos]
  );
  const isoToId = new Map(countryRows.map(r => [r.iso_code, r.id]));
  for (const iso of isos) {
    if (!isoToId.has(iso)) {
      console.warn(`  ⚠ country iso ${iso} not found in countries table — candidates for this country will be skipped`);
    }
  }

  // ── 3. Detect existing duplicates by domain so we don't insert dups ─
  // Match against site_url, rss_url, scrape_url — any of which already
  // pointing at a candidate's domain disqualifies the insert. Only
  // disqualify within the same country to allow legit cross-country
  // outlets that share a parent (rare but possible).
  const candidateDomains = CANDIDATES.map(c => {
    try { return new URL(c.site_url).hostname.replace(/^www\./i, '').toLowerCase(); }
    catch { return c.site_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase(); }
  });
  const { rows: existingMatches } = await pool.query(`
    SELECT s.id, s.site_url, s.rss_url, s.scrape_url, s.country_id, c.iso_code
      FROM news_sources s
      LEFT JOIN countries c ON c.id = s.country_id
     WHERE (
       LOWER(REGEXP_REPLACE(COALESCE(s.site_url, ''),  '^https?://(www\\.)?',  '', 'i'))   = ANY($1::text[])
       OR LOWER(REGEXP_REPLACE(COALESCE(s.rss_url, ''),  '^https?://(www\\.)?',  '', 'i')) = ANY($1::text[])
       OR LOWER(REGEXP_REPLACE(COALESCE(s.scrape_url, ''), '^https?://(www\\.)?', '', 'i')) = ANY($1::text[])
       OR EXISTS (
         SELECT 1 FROM unnest($1::text[]) d
         WHERE LOWER(s.site_url)  LIKE '%' || d || '%'
            OR LOWER(s.rss_url)   LIKE '%' || d || '%'
            OR LOWER(s.scrape_url) LIKE '%' || d || '%'
       )
     )
  `, [candidateDomains]);

  // Build a per-country set of already-used domains
  const usedByCountry = new Map(); // country_id → Set<domain>
  for (const m of existingMatches) {
    let domain = '';
    for (const url of [m.site_url, m.rss_url, m.scrape_url]) {
      if (!url) continue;
      try { domain = new URL(url).hostname.replace(/^www\./i, '').toLowerCase(); break; }
      catch {}
    }
    if (!domain) continue;
    if (!usedByCountry.has(m.country_id)) usedByCountry.set(m.country_id, new Set());
    usedByCountry.get(m.country_id).add(domain);
  }

  // ── 4. Insert ───────────────────────────────────────────────────────
  const inserted = [];
  const skipped  = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    const country_id = isoToId.get(c.country_iso);
    if (!country_id) { skipped.push({ ...c, reason: 'country not in DB' }); continue; }
    const domain = candidateDomains[i];
    if (usedByCountry.get(country_id)?.has(domain)) {
      skipped.push({ ...c, reason: 'domain already exists for this country' });
      continue;
    }
    try {
      // rss_url defaults to site_url so the NOT NULL constraint passes;
      // sourceTester's probeFeeds discovers + overwrites with the real
      // feed during testing.
      const r = await pool.query(`
        INSERT INTO news_sources (
          name, site_url, rss_url, scrape_url, country_id, language,
          source_type, is_active, popularity_tier, popularity_score,
          fetch_tier, fetch_bootstrap_phase
        ) VALUES (
          $1, $2, $3, $2, $4, $5,
          'rss', false, 1, 1.00,
          1, 'baseline'
        )
        RETURNING id
      `, [c.name, c.site_url, c.site_url, country_id, c.language || null]);
      inserted.push({ id: r.rows[0].id, ...c, country_id });
      // mark domain claimed so subsequent same-domain candidates dedupe
      if (!usedByCountry.has(country_id)) usedByCountry.set(country_id, new Set());
      usedByCountry.get(country_id).add(domain);
    } catch (e) {
      skipped.push({ ...c, reason: `insert error: ${e.message}` });
    }
  }
  console.log(`  inserted ${inserted.length}, skipped ${skipped.length}`);
  fs.writeFileSync(path.join(outDir, 'inserted_ids.json'),  JSON.stringify(inserted, null, 2));
  fs.writeFileSync(path.join(outDir, 'skipped_inserts.json'), JSON.stringify(skipped, null, 2));

  // ── 5. Mark all never-fetched existing sources as inactive ──────────
  // The auto-tester's queue is "is_active = false". Sources that have
  // never produced a successful article (last_success_at IS NULL) need
  // to be in that queue for the tester to re-probe them. We don't
  // touch sources that are already inactive — they're already in the
  // queue. We only push currently-active never-fetched ones over.
  console.log(`\n[round1] step 3: Mark never-fetched sources as inactive`);
  const stranded = await pool.query(`
    UPDATE news_sources
       SET is_active = false
     WHERE last_success_at IS NULL
       AND is_active = true
     RETURNING id, name, country_id, site_url
  `);
  console.log(`  marked ${stranded.rows.length} previously-active never-fetched sources inactive`);
  fs.writeFileSync(path.join(outDir, 'stranded_marked_inactive.json'), JSON.stringify(stranded.rows, null, 2));

  // ── Summary ─────────────────────────────────────────────────────────
  const summary = {
    timestamp:       new Date().toISOString(),
    output_dir:      outDir,
    pakistan_tns_deleted: delResult.rows.map(r => r.id),
    candidates_inserted: inserted.length,
    candidates_skipped:  skipped.length,
    stranded_marked_inactive: stranded.rows.length,
    elapsed_secs: ((Date.now() - t0) / 1000).toFixed(1),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n[round1] done in ${summary.elapsed_secs}s`);
  console.log(`[round1] output: ${outDir}`);
  console.log(`[round1] next: node _auto_test_sources.js ${outDir}`);

  await pool.end().catch(() => {});
}

main().catch(err => { console.error('[round1] fatal:', err); process.exit(1); });
