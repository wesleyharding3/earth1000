#!/usr/bin/env node
'use strict';

/**
 * _audit_news_sources.js
 *
 * One-shot audit: produces three structured reports of the current
 * news_sources table to drive the source-coverage expansion project.
 *
 *   1. countries_coverage.json   — per-country source counts + lists.
 *   2. cities_coverage.json      — per-city source counts + lists.
 *   3. weak_candidates.json      — heuristic flags for likely-weak
 *                                   sources (duplicates, sports/
 *                                   entertainment-only, dead, etc.).
 *
 * USA is intentionally excluded from the gap-finding views because
 * the user's brief: "exempting only the USA which dominates global
 * coverage as is."
 *
 * Run:  node _audit_news_sources.js
 * Outputs land in ./tmp/source-audit-<timestamp>/
 */

process.env.DB_POOL_MAX = '2';
require('dotenv').config({ override: true });
const pool = require('./db');
const fs = require('fs');
const path = require('path');

// Heuristic keyword lists for the weak-source flags. Conservative —
// false positives are okay because the report is a review queue, not
// an autonomous deletion; the user inspects each flag before acting.
const SPORT_KEYWORDS = [
  'sport', 'sports', 'fanatic', 'futbol', 'fútbol', 'futebol',
  'football', 'soccer', 'cricket', 'tennis', 'rugby', 'hockey',
  'baseball', 'basketball', 'golf', 'nfl', 'nba', 'nhl', 'mlb',
  'fifa', 'uefa', 'olympics', 'sportsnet', 'goal.com', 'espn',
  'bleacher', 'kickoff', 'matchday', 'transfermarkt',
];
const ENTERTAINMENT_KEYWORDS = [
  'celebrity', 'celebs', 'gossip', 'hollywood', 'bollywood',
  'tabloid', 'showbiz', 'showbuzz', 'entertainment', 'glamour',
  'redcarpet', 'paparazzi', 'tmz', 'eonline', 'usweekly',
  'people.com', 'enews', 'starmagazine',
];
const LIFESTYLE_KEYWORDS = [
  'recipe', 'cooking', 'fashion', 'beauty', 'wedding', 'horoscope',
  'astrology', 'travel-only', 'crochet', 'knitting',
];

function looksLike(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

function rootDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`[audit] starting at ${new Date().toISOString()}`);

  // ── Load full source list (active or recently-active). ──────────────
  // We include is_active=false because some sources may have been
  // muted but still exist as records that need cleanup. last_*_at
  // columns help the user judge whether a source is producing work.
  const { rows: sources } = await pool.query(`
    SELECT s.id, s.name, s.site_url, s.rss_url, s.scrape_url,
           s.source_type, s.is_active,
           s.country_id, s.city_id,
           s.popularity_tier, s.popularity_score,
           s.failure_count, s.last_failed_at, s.last_success_at,
           s.fetch_tier, s.bias, s.language,
           c.name AS country_name, c.iso_code,
           ci.name AS city_name
      FROM news_sources s
      LEFT JOIN countries c  ON c.id  = s.country_id
      LEFT JOIN cities    ci ON ci.id = s.city_id
     ORDER BY c.name NULLS LAST, ci.name NULLS LAST, s.name
  `);
  console.log(`[audit] ${sources.length} sources pulled (${((Date.now()-t0)/1000).toFixed(1)}s)`);

  // ── Country & city dimension tables for completeness. ───────────────
  const { rows: countries } = await pool.query(`
    SELECT id, name, iso_code, region, population, gdp, is_active
      FROM countries
     WHERE is_active IS DISTINCT FROM false
     ORDER BY name
  `);
  const { rows: cities } = await pool.query(`
    SELECT ci.id, ci.name, ci.country_id, c.name AS country_name, c.iso_code,
           ci.population, ci.is_capital, ci.is_active
      FROM cities ci
      JOIN countries c ON c.id = ci.country_id
     WHERE ci.is_active IS DISTINCT FROM false
     ORDER BY c.name, ci.name
  `);
  console.log(`[audit] ${countries.length} countries, ${cities.length} cities loaded`);

  // ── Index sources by country and city ───────────────────────────────
  const byCountry = new Map();   // country_id → [sources]
  const byCity    = new Map();   // city_id    → [sources]
  for (const s of sources) {
    if (s.country_id != null) {
      if (!byCountry.has(s.country_id)) byCountry.set(s.country_id, []);
      byCountry.get(s.country_id).push(s);
    }
    if (s.city_id != null) {
      if (!byCity.has(s.city_id)) byCity.set(s.city_id, []);
      byCity.get(s.city_id).push(s);
    }
  }

  // ── Country coverage report ─────────────────────────────────────────
  // For each country: how many sources do we have? List them. Flag
  // gaps. USA excluded from gap-priority but still listed for
  // duplicate detection.
  const countryReport = countries.map(c => {
    const rawSources = byCountry.get(c.id) || [];
    // Country-level sources are those with country_id but no city_id.
    // (City-level sources are listed separately below.)
    const countryLevel = rawSources.filter(s => s.city_id == null);
    return {
      country_id:   c.id,
      country_name: c.name,
      iso_code:     c.iso_code,
      region:       c.region,
      population:   c.population,
      total_sources_country_level: countryLevel.length,
      total_sources_including_city_level: rawSources.length,
      gap_priority: c.iso_code === 'US' ? 'EXCLUDED' :
                    countryLevel.length === 0 ? 'CRITICAL' :
                    countryLevel.length <= 2  ? 'HIGH'     :
                    countryLevel.length <= 5  ? 'MEDIUM'   : 'OK',
      sources: countryLevel.map(s => ({
        id: s.id,
        name: s.name,
        domain: rootDomain(s.site_url || s.rss_url || s.scrape_url),
        site_url: s.site_url,
        source_type: s.source_type,
        is_active: s.is_active,
        popularity_tier: s.popularity_tier,
        bias: s.bias,
        language: s.language,
        last_success_at: s.last_success_at,
        failure_count: s.failure_count,
      })),
    };
  });

  // ── City coverage report (excluding USA cities per spec) ────────────
  const cityReport = cities
    .filter(ci => ci.iso_code !== 'US')
    .map(ci => {
      const citySources = byCity.get(ci.id) || [];
      return {
        city_id:      ci.id,
        city_name:    ci.name,
        country_name: ci.country_name,
        iso_code:     ci.iso_code,
        is_capital:   ci.is_capital,
        population:   ci.population,
        total_sources: citySources.length,
        gap_priority: citySources.length === 0 ? 'CRITICAL' :
                      citySources.length <= 1  ? 'HIGH'     :
                      citySources.length <= 3  ? 'MEDIUM'   : 'OK',
        sources: citySources.map(s => ({
          id: s.id,
          name: s.name,
          domain: rootDomain(s.site_url || s.rss_url || s.scrape_url),
          site_url: s.site_url,
          source_type: s.source_type,
          is_active: s.is_active,
          popularity_tier: s.popularity_tier,
          last_success_at: s.last_success_at,
          failure_count: s.failure_count,
        })),
      };
    });

  // ── Weak-source candidates ──────────────────────────────────────────
  // A source is flagged if any heuristic fires. Multiple flags stack
  // so the user can sort by suspicion.
  const weak = [];
  // Domain index for duplicate detection — same root domain across
  // multiple records is a strong signal of dup, modulo intentional
  // multi-feed ingestion (e.g. one paper has separate RSS for News /
  // Sports / Opinion). The user reviews and decides.
  const domainCounts = new Map();
  for (const s of sources) {
    const d = rootDomain(s.site_url || s.rss_url || s.scrape_url);
    if (!d) continue;
    if (!domainCounts.has(d)) domainCounts.set(d, []);
    domainCounts.get(d).push(s);
  }

  for (const s of sources) {
    const flags = [];
    const domain = rootDomain(s.site_url || s.rss_url || s.scrape_url);
    const blob = `${s.name} ${s.site_url || ''} ${s.rss_url || ''} ${s.scrape_url || ''}`;

    if (looksLike(blob, SPORT_KEYWORDS))         flags.push('sports');
    if (looksLike(blob, ENTERTAINMENT_KEYWORDS)) flags.push('entertainment');
    if (looksLike(blob, LIFESTYLE_KEYWORDS))     flags.push('lifestyle');

    // Duplicate domain (≥2 records share root domain). We exclude the
    // case where one is the parent country source and the other is a
    // city-level record at the same outlet — that's intentional (a
    // city section of a national paper). But same-country same-domain
    // dups are very likely real duplicates.
    const sameDomain = domainCounts.get(domain) || [];
    if (sameDomain.length > 1) {
      const sameScope = sameDomain.filter(o =>
        o.id !== s.id &&
        o.country_id === s.country_id &&
        o.city_id === s.city_id
      );
      if (sameScope.length) flags.push('duplicate_same_scope');
      else if (sameDomain.length > 2) flags.push('domain_repeats_3plus');
    }

    // Inactive
    if (s.is_active === false) flags.push('inactive');
    // Heavy failure load (rough: >10 failures with no recent success)
    if ((s.failure_count || 0) > 10 &&
        (!s.last_success_at || (Date.now() - new Date(s.last_success_at).getTime()) > 30 * 24 * 3600 * 1000)) {
      flags.push('failing_30d+');
    }
    // No success ever, recent failures
    if (!s.last_success_at && (s.failure_count || 0) > 3) flags.push('never_succeeded');

    if (flags.length) {
      weak.push({
        id: s.id,
        name: s.name,
        domain,
        country_name: s.country_name,
        city_name: s.city_name,
        site_url: s.site_url,
        rss_url: s.rss_url,
        is_active: s.is_active,
        failure_count: s.failure_count,
        last_success_at: s.last_success_at,
        flags,
        flag_count: flags.length,
      });
    }
  }
  weak.sort((a, b) => b.flag_count - a.flag_count || a.country_name?.localeCompare(b.country_name || '') || 0);

  // ── Roll-up summary the user can scan first ─────────────────────────
  const summary = {
    generated_at: new Date().toISOString(),
    totals: {
      sources: sources.length,
      countries_with_any_source: new Set(sources.map(s => s.country_id).filter(Boolean)).size,
      cities_with_any_source:    new Set(sources.map(s => s.city_id).filter(Boolean)).size,
      flagged_weak: weak.length,
    },
    country_gap_distribution: {
      CRITICAL: countryReport.filter(c => c.gap_priority === 'CRITICAL').length,
      HIGH:     countryReport.filter(c => c.gap_priority === 'HIGH').length,
      MEDIUM:   countryReport.filter(c => c.gap_priority === 'MEDIUM').length,
      OK:       countryReport.filter(c => c.gap_priority === 'OK').length,
      EXCLUDED: countryReport.filter(c => c.gap_priority === 'EXCLUDED').length,
    },
    city_gap_distribution: {
      CRITICAL: cityReport.filter(c => c.gap_priority === 'CRITICAL').length,
      HIGH:     cityReport.filter(c => c.gap_priority === 'HIGH').length,
      MEDIUM:   cityReport.filter(c => c.gap_priority === 'MEDIUM').length,
      OK:       cityReport.filter(c => c.gap_priority === 'OK').length,
    },
    weak_flag_breakdown: (() => {
      const counts = {};
      for (const w of weak) for (const f of w.flags) counts[f] = (counts[f] || 0) + 1;
      return counts;
    })(),
  };

  // ── Write output files ──────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'tmp', `source-audit-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'),            JSON.stringify(summary,        null, 2));
  fs.writeFileSync(path.join(outDir, 'countries_coverage.json'), JSON.stringify(countryReport,  null, 2));
  fs.writeFileSync(path.join(outDir, 'cities_coverage.json'),    JSON.stringify(cityReport,     null, 2));
  fs.writeFileSync(path.join(outDir, 'weak_candidates.json'),    JSON.stringify(weak,           null, 2));

  // Markdown summary for human scanning
  const md = [];
  md.push(`# News Sources Audit — ${ts}\n`);
  md.push(`**Total sources**: ${summary.totals.sources}`);
  md.push(`**Countries with any source**: ${summary.totals.countries_with_any_source} of ${countries.length}`);
  md.push(`**Cities with any source** (ex-USA): ${summary.totals.cities_with_any_source}`);
  md.push(`**Flagged weak**: ${summary.totals.flagged_weak}\n`);

  md.push(`## Country gap distribution`);
  for (const [k, v] of Object.entries(summary.country_gap_distribution)) md.push(`- ${k}: ${v}`);

  md.push(`\n## City gap distribution (ex-USA)`);
  for (const [k, v] of Object.entries(summary.city_gap_distribution)) md.push(`- ${k}: ${v}`);

  md.push(`\n## Weak flag breakdown`);
  for (const [k, v] of Object.entries(summary.weak_flag_breakdown)) md.push(`- ${k}: ${v}`);

  // Top 30 critical/high-priority gaps to surface in the markdown
  md.push(`\n## Critical-gap countries (zero country-level sources, ex-USA)`);
  countryReport
    .filter(c => c.gap_priority === 'CRITICAL')
    .forEach(c => md.push(`- **${c.country_name}** (${c.iso_code || '—'}) · pop ${c.population || '—'}`));

  md.push(`\n## High-gap countries (1-2 country-level sources)`);
  countryReport
    .filter(c => c.gap_priority === 'HIGH')
    .forEach(c => md.push(`- **${c.country_name}** (${c.iso_code || '—'}): ${c.sources.map(s => s.name).join(', ')}`));

  md.push(`\n## Cities with zero sources (top 50 by population, ex-USA)`);
  cityReport
    .filter(c => c.gap_priority === 'CRITICAL' && c.population)
    .sort((a, b) => (b.population || 0) - (a.population || 0))
    .slice(0, 50)
    .forEach(c => md.push(`- **${c.city_name}**, ${c.country_name} · pop ${c.population}${c.is_capital ? ' · capital' : ''}`));

  md.push(`\n## Top-50 most-flagged weak candidates`);
  weak.slice(0, 50).forEach(w =>
    md.push(`- [#${w.id}] **${w.name}** (${w.domain}) — ${w.country_name || '—'}/${w.city_name || '—'} — flags: ${w.flags.join(', ')}`)
  );

  fs.writeFileSync(path.join(outDir, 'README.md'), md.join('\n') + '\n');

  console.log(`\n[audit] reports written to: ${outDir}`);
  console.log(`        - summary.json`);
  console.log(`        - countries_coverage.json (${countryReport.length} countries)`);
  console.log(`        - cities_coverage.json (${cityReport.length} cities)`);
  console.log(`        - weak_candidates.json (${weak.length} flagged)`);
  console.log(`        - README.md`);
  console.log(`\n[audit] done in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[audit] fatal:', err);
  process.exit(1);
});
