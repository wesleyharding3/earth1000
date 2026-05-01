#!/usr/bin/env node
'use strict';

/**
 * _apply_round2_sources.js
 *
 * Stage 2 of the source-coverage expansion:
 *   - Inserts candidate sources for HIGH-gap countries (18 countries
 *     with 1-2 country-level sources today) and MEDIUM-gap countries
 *     (20 countries with 3-5 sources) as is_active=false. They're
 *     deduplicated against domains already in news_sources for the
 *     same country, so re-runs are idempotent.
 *   - Outputs the inserted IDs so the auto-tester can be invoked
 *     against just those rows (skipping the broader inactive queue).
 *
 * No DB writes outside the news_sources INSERT. No Pakistan-style
 * merge needed for these countries.
 *
 * Run:
 *   node _apply_round2_sources.js
 *   node _auto_test_sources.js --ids=<comma list from inserted_ids.json>
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const fs = require('fs');
const path = require('path');

// ─── HIGH-gap candidates (18 countries, 1-2 sources today) ────────────
// ─── MEDIUM-gap candidates (20 countries, 3-5 sources today) ──────────
// All training-knowledge picks; the auto-tester probes each URL and
// drops anything unreachable / unparseable.
const CANDIDATES = [
  // ── Andorra (AD) — existing: bondia.ad, diariandorra.ad ──
  { name: 'Andorra Difusió (RTVA)',                site_url: 'https://www.rtva.ad',                country_iso: 'AD', language: 'ca' },
  { name: 'Altaveu',                               site_url: 'https://www.altaveu.com',            country_iso: 'AD', language: 'ca' },
  { name: 'El Periòdic d\'Andorra',                site_url: 'https://www.elperiodic.ad',          country_iso: 'AD', language: 'ca' },

  // ── Antigua and Barbuda (AG) — existing: 2 ──
  { name: 'Antigua News',                          site_url: 'https://antigua.news',               country_iso: 'AG', language: 'en' },
  { name: 'Pointe Xpress Antigua',                 site_url: 'https://pointexpress.com',           country_iso: 'AG', language: 'en' },
  { name: 'ABS Antigua',                           site_url: 'https://www.abstvradio.com',         country_iso: 'AG', language: 'en' },

  // ── Belize (BZ) — existing: 2 ──
  { name: 'Channel 5 Belize',                      site_url: 'https://channel5belize.com',         country_iso: 'BZ', language: 'en' },
  { name: 'Amandala',                              site_url: 'https://amandala.com.bz',            country_iso: 'BZ', language: 'en' },
  { name: 'The Reporter Belize',                   site_url: 'https://www.reporter.bz',            country_iso: 'BZ', language: 'en' },

  // ── Cabo Verde (CV) — existing: 1 ──
  { name: 'Expresso das Ilhas',                    site_url: 'https://expressodasilhas.cv',        country_iso: 'CV', language: 'pt' },
  { name: 'Inforpress Cabo Verde',                 site_url: 'https://inforpress.cv',              country_iso: 'CV', language: 'pt' },
  { name: 'A Nação',                               site_url: 'https://www.anacao.cv',              country_iso: 'CV', language: 'pt' },

  // ── Comoros (KM) — existing: 1 ──
  { name: 'Al-Watwan',                             site_url: 'https://alwatwan.net',               country_iso: 'KM', language: 'fr' },
  { name: 'HZK Press',                             site_url: 'https://hzkpresse.com',              country_iso: 'KM', language: 'fr' },
  { name: 'La Gazette des Comores',                site_url: 'https://lagazettedescomores.com',    country_iso: 'KM', language: 'fr' },

  // ── Eswatini (SZ) — existing: 1 ──
  { name: 'Times of Eswatini',                     site_url: 'http://www.times.co.sz',             country_iso: 'SZ', language: 'en' },
  { name: 'Eswatini Observer',                     site_url: 'https://www.observer.org.sz',        country_iso: 'SZ', language: 'en' },

  // ── Grenada (GD) — existing: 1 ──
  { name: 'NOW Grenada',                           site_url: 'https://www.nowgrenada.com',         country_iso: 'GD', language: 'en' },
  { name: 'The Grenadian Voice',                   site_url: 'https://grenadianvoice.com',         country_iso: 'GD', language: 'en' },

  // ── Guinea-Bissau (GW) — existing: 2 ──
  { name: 'Bissau Digital',                        site_url: 'https://www.bissaudigital.com',      country_iso: 'GW', language: 'pt' },
  { name: 'No Pintcha',                            site_url: 'https://www.nopintcha.gw',           country_iso: 'GW', language: 'pt' },

  // ── Kosovo (XK) — existing: 2 ──
  { name: 'Telegrafi',                             site_url: 'https://telegrafi.com',              country_iso: 'XK', language: 'sq' },
  { name: 'Klan Kosova',                           site_url: 'https://klankosova.tv',              country_iso: 'XK', language: 'sq' },
  { name: 'RTK Kosovo',                            site_url: 'https://www.rtklive.com',            country_iso: 'XK', language: 'sq' },
  { name: 'Kallxo',                                site_url: 'https://kallxo.com',                 country_iso: 'XK', language: 'sq' },
  { name: 'Bota Sot',                              site_url: 'https://www.botasot.info',           country_iso: 'XK', language: 'sq' },
  { name: 'Indeksonline',                          site_url: 'https://indeksonline.net',           country_iso: 'XK', language: 'sq' },

  // ── Lesotho (LS) — existing: 1 ──
  { name: 'Lesotho Times',                         site_url: 'https://www.lestimes.com',           country_iso: 'LS', language: 'en' },
  { name: 'The Post Lesotho',                      site_url: 'https://www.thepost.co.ls',          country_iso: 'LS', language: 'en' },
  { name: 'Sunday Express Lesotho',                site_url: 'https://sundayexpress.co.ls',        country_iso: 'LS', language: 'en' },

  // ── Republic of the Congo (CG) — existing: 2 ──
  { name: 'Adiac Congo',                           site_url: 'https://www.adiac-congo.com',        country_iso: 'CG', language: 'fr' },
  { name: 'Sangonet',                              site_url: 'https://www.sangonet.com',           country_iso: 'CG', language: 'fr' },

  // ── Saint Kitts and Nevis (KN) — existing: 2 ──
  { name: 'SKNIS',                                 site_url: 'https://www.sknis.gov.kn',           country_iso: 'KN', language: 'en' },
  { name: 'Nevis Pages',                           site_url: 'https://www.nevispages.com',         country_iso: 'KN', language: 'en' },
  { name: 'The Observer SKN',                      site_url: 'https://www.theobserver.kn',         country_iso: 'KN', language: 'en' },

  // ── Saint Lucia (LC) — existing: 1 ──
  { name: 'The Voice St Lucia',                    site_url: 'https://thevoiceslu.com',            country_iso: 'LC', language: 'en' },
  { name: 'St Lucia News Online',                  site_url: 'https://www.stlucianewsonline.com',  country_iso: 'LC', language: 'en' },
  { name: 'HTS St Lucia',                          site_url: 'https://hts.com.lc',                 country_iso: 'LC', language: 'en' },

  // ── Saint Vincent and the Grenadines (VC) — existing: 1 ──
  { name: 'iWitness News',                         site_url: 'https://www.iwnsvg.com',             country_iso: 'VC', language: 'en' },
  { name: 'News784',                               site_url: 'https://news784.com',                country_iso: 'VC', language: 'en' },
  { name: 'The Vincentian',                        site_url: 'https://www.thevincentian.com',      country_iso: 'VC', language: 'en' },

  // ── Solomon Islands (SB) — existing: 1 ──
  { name: 'Solomon Times',                         site_url: 'https://www.solomontimes.com',       country_iso: 'SB', language: 'en' },
  { name: 'Island Sun Solomon',                    site_url: 'https://theislandsun.com.sb',        country_iso: 'SB', language: 'en' },
  { name: 'SIBC Solomon Islands',                  site_url: 'https://www.sibconline.com.sb',      country_iso: 'SB', language: 'en' },

  // ── South Sudan (SS) — existing: 1 ──
  { name: 'Eye Radio South Sudan',                 site_url: 'https://www.eyeradio.org',           country_iso: 'SS', language: 'en' },
  { name: 'Sudan Tribune',                         site_url: 'https://www.sudantribune.com',       country_iso: 'SS', language: 'en' },
  { name: 'The City Review South Sudan',           site_url: 'https://cityreviewss.com',           country_iso: 'SS', language: 'en' },
  { name: 'Juba Echo',                             site_url: 'https://jubaecho.com',               country_iso: 'SS', language: 'en' },

  // ── Timor-Leste (TL) — existing: 1 ──
  { name: 'Diario Nacional Timor',                 site_url: 'https://diarionacionaltl.com',       country_iso: 'TL', language: 'pt' },
  { name: 'The Independente',                      site_url: 'https://theindependente.com',        country_iso: 'TL', language: 'pt' },
  { name: 'Neon Metin',                            site_url: 'https://neonmetin.com',              country_iso: 'TL', language: 'pt' },

  // ─── MEDIUM-gap countries ─────────────────────────────────────────

  // ── Afghanistan (AF) — existing: 4 ──
  { name: 'TOLOnews',                              site_url: 'https://tolonews.com',               country_iso: 'AF', language: 'en' },
  { name: 'Pajhwok Afghan News',                   site_url: 'https://pajhwok.com',                country_iso: 'AF', language: 'en' },
  { name: '1TV News Afghanistan',                  site_url: 'https://1tvnews.af',                 country_iso: 'AF', language: 'en' },
  { name: 'Khaama Press',                           site_url: 'https://www.khaama.com',             country_iso: 'AF', language: 'en' },
  { name: 'Hasht-e Subh',                          site_url: 'https://8am.media',                  country_iso: 'AF', language: 'fa' },

  // ── Barbados (BB) — existing: 5 ──
  { name: 'Loop Barbados',                         site_url: 'https://barbados.loopnews.com',      country_iso: 'BB', language: 'en' },

  // ── Brunei (BN) — existing: 3 ──
  { name: 'Borneo Bulletin',                       site_url: 'https://borneobulletin.com.bn',      country_iso: 'BN', language: 'en' },
  { name: 'RTB Brunei',                            site_url: 'https://www.rtb.gov.bn',             country_iso: 'BN', language: 'en' },

  // ── Burundi (BI) — existing: 4 ──
  { name: 'Iwacu Burundi',                         site_url: 'https://www.iwacu-burundi.org',      country_iso: 'BI', language: 'fr' },

  // ── Djibouti (DJ) — existing: 3 ──
  { name: 'La Nation Djibouti',                    site_url: 'https://www.lanation.dj',            country_iso: 'DJ', language: 'fr' },
  { name: 'ADI Djibouti',                          site_url: 'https://www.adi.dj',                 country_iso: 'DJ', language: 'fr' },
  { name: 'RTD Djibouti',                          site_url: 'https://rtd.dj',                     country_iso: 'DJ', language: 'fr' },

  // ── Eritrea (ER) — existing: 4 ──
  { name: 'Madote',                                site_url: 'https://www.madote.com',             country_iso: 'ER', language: 'en' },
  { name: 'Tesfa News',                            site_url: 'https://www.tesfanews.com',          country_iso: 'ER', language: 'en' },

  // ── Greenland (GL) — existing: 3 ──
  { name: 'Sermitsiaq AG',                         site_url: 'https://sermitsiaq.ag',              country_iso: 'GL', language: 'da' },
  { name: 'KNR Greenland',                         site_url: 'https://knr.gl',                     country_iso: 'GL', language: 'da' },

  // ── Guyana (GY) — existing: 5 ──
  { name: 'Stabroek News',                         site_url: 'https://www.stabroeknews.com',       country_iso: 'GY', language: 'en' },
  { name: 'News Source Guyana',                    site_url: 'https://newssourcegy.com',           country_iso: 'GY', language: 'en' },
  { name: 'Demerara Waves',                        site_url: 'https://demerarawaves.com',          country_iso: 'GY', language: 'en' },

  // ── Iran (IR) — existing: 5 ──
  { name: 'Tasnim News Agency',                    site_url: 'https://www.tasnimnews.com',         country_iso: 'IR', language: 'fa' },
  { name: 'IRNA',                                  site_url: 'https://www.irna.ir',                country_iso: 'IR', language: 'fa' },
  { name: 'Mehr News Agency',                      site_url: 'https://en.mehrnews.com',            country_iso: 'IR', language: 'en' },
  { name: 'Fars News',                             site_url: 'https://www.farsnews.ir',            country_iso: 'IR', language: 'fa' },
  { name: 'ISNA',                                  site_url: 'https://www.isna.ir',                country_iso: 'IR', language: 'fa' },
  { name: 'IranWire',                              site_url: 'https://iranwire.com/en',            country_iso: 'IR', language: 'en' },

  // ── Laos (LA) — existing: 5 ──
  { name: 'Vientiane Times',                       site_url: 'https://www.vientianetimes.org.la',  country_iso: 'LA', language: 'en' },
  { name: 'KPL Laos',                              site_url: 'https://kpl.gov.la',                 country_iso: 'LA', language: 'en' },

  // ── Liberia (LR) — existing: 4 ──
  { name: 'Front Page Africa',                     site_url: 'https://frontpageafricaonline.com',  country_iso: 'LR', language: 'en' },
  { name: 'The Inquirer Liberia',                  site_url: 'https://www.theinquirer.com.lr',     country_iso: 'LR', language: 'en' },

  // ── Malawi (MW) — existing: 3 ──
  { name: 'Malawi News Agency',                    site_url: 'https://www.manaonline.gov.mw',      country_iso: 'MW', language: 'en' },
  { name: 'Maravi Post',                           site_url: 'https://www.maravipost.com',         country_iso: 'MW', language: 'en' },

  // ── Montenegro (ME) — existing: 3 ──
  { name: 'Vijesti',                               site_url: 'https://www.vijesti.me',             country_iso: 'ME', language: 'sr' },
  { name: 'Dan Online',                            site_url: 'https://www.dan.co.me',              country_iso: 'ME', language: 'sr' },
  { name: 'Antena M',                              site_url: 'https://www.antenam.net',            country_iso: 'ME', language: 'sr' },

  // ── Mozambique (MZ) — existing: 5 ──
  { name: 'Verdade Mozambique',                    site_url: 'https://www.verdade.co.mz',          country_iso: 'MZ', language: 'pt' },

  // ── Sierra Leone (SL) — existing: 4 ──
  { name: 'Awoko Newspaper',                       site_url: 'https://awoko.org',                  country_iso: 'SL', language: 'en' },
  { name: 'Salone Times',                          site_url: 'https://salonetimes.com',            country_iso: 'SL', language: 'en' },
  { name: 'Standard Times Press',                  site_url: 'https://standardtimespress.org',     country_iso: 'SL', language: 'en' },

  // ── Suriname (SR) — existing: 3 ──
  { name: 'Starnieuws',                            site_url: 'https://www.starnieuws.com',         country_iso: 'SR', language: 'nl' },
  { name: 'De West (DWT Online)',                  site_url: 'https://www.dwtonline.com',          country_iso: 'SR', language: 'nl' },

  // ── Tajikistan (TJ) — existing: 4 ──
  { name: 'Asia-Plus Tajikistan',                  site_url: 'https://asiaplustj.info',            country_iso: 'TJ', language: 'ru' },
  { name: 'Avesta Tajikistan',                     site_url: 'https://avesta.tj',                  country_iso: 'TJ', language: 'tg' },

  // ── Togo (TG) — existing: 5 ──
  { name: '27Avril Togo',                          site_url: 'https://www.27avril.com',            country_iso: 'TG', language: 'fr' },
  { name: 'Togo First',                            site_url: 'https://www.togofirst.com',          country_iso: 'TG', language: 'fr' },
  { name: 'L\'Union Togo',                          site_url: 'https://l-union.com',                country_iso: 'TG', language: 'fr' },

  // ── Yemen (YE) — existing: 5 ──
  { name: 'Saba News Agency',                      site_url: 'https://www.saba.ye',                country_iso: 'YE', language: 'ar' },
  { name: 'Al-Masdar Online',                      site_url: 'https://almasdaronline.com',         country_iso: 'YE', language: 'ar' },
  { name: 'Yemen Online',                          site_url: 'https://www.yemenonline.info',       country_iso: 'YE', language: 'ar' },
  { name: 'Al-Mashhad Al-Yemeni',                  site_url: 'https://almashhad-alyemeni.com',     country_iso: 'YE', language: 'ar' },
];

async function main() {
  const t0 = Date.now();
  console.log(`[round2] starting at ${new Date().toISOString()}`);
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'tmp', `round2-staging-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  // Country lookup
  const isos = Array.from(new Set(CANDIDATES.map(c => c.country_iso)));
  const { rows: countryRows } = await pool.query(
    `SELECT id, iso_code FROM countries WHERE iso_code = ANY($1::char(2)[])`,
    [isos]
  );
  const isoToId = new Map(countryRows.map(r => [r.iso_code, r.id]));

  // Domain dedupe pre-flight
  const candidateDomains = CANDIDATES.map(c => {
    try { return new URL(c.site_url).hostname.replace(/^www\./i, '').toLowerCase(); }
    catch { return c.site_url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase(); }
  });
  const { rows: existing } = await pool.query(`
    SELECT s.id, s.site_url, s.rss_url, s.scrape_url, s.country_id
      FROM news_sources s
     WHERE EXISTS (
       SELECT 1 FROM unnest($1::text[]) d
       WHERE LOWER(s.site_url)  LIKE '%' || d || '%'
          OR LOWER(s.rss_url)   LIKE '%' || d || '%'
          OR LOWER(s.scrape_url) LIKE '%' || d || '%'
     )
  `, [candidateDomains]);

  const usedByCountry = new Map();
  for (const m of existing) {
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
      if (!usedByCountry.has(country_id)) usedByCountry.set(country_id, new Set());
      usedByCountry.get(country_id).add(domain);
    } catch (e) {
      skipped.push({ ...c, reason: `insert error: ${e.message}` });
    }
  }
  console.log(`[round2] inserted ${inserted.length}, skipped ${skipped.length}`);

  fs.writeFileSync(path.join(outDir, 'inserted_ids.json'),  JSON.stringify(inserted, null, 2));
  fs.writeFileSync(path.join(outDir, 'skipped_inserts.json'), JSON.stringify(skipped, null, 2));

  const summary = {
    timestamp: new Date().toISOString(),
    output_dir: outDir,
    inserted: inserted.length,
    skipped:  skipped.length,
    elapsed_secs: ((Date.now() - t0) / 1000).toFixed(1),
    auto_test_command: `node _auto_test_sources.js --ids=${inserted.map(r => r.id).join(',')}`,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`[round2] done in ${summary.elapsed_secs}s`);
  console.log(`[round2] output: ${outDir}`);
  console.log(`[round2] next: ${summary.auto_test_command.slice(0, 120)}…`);

  await pool.end().catch(() => {});
}

main().catch(err => { console.error('[round2] fatal:', err); process.exit(1); });
