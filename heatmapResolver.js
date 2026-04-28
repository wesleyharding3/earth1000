// heatmapResolver.js
//
// Shared heatmap-question-resolution logic. Used by:
//   - /api/heatmap/ask (live runtime resolution, called per-user request)
//   - briefingGenerator.js (pre-resolution at briefing-generation time so
//     each heatmap segment ships with baked-in per-country values; users
//     never trigger a Claude call at view time)
//
// Both callers share the same heatmap_qa_cache table — so a value
// produced for one consumer is immediately reusable by the other. The
// cache key is sha256(`${mode}|${normalizedQuestion}`).
//
// Public API:
//   resolveHeatmap(question, mode, opts) → {
//     question, mode, legend, unit, source_note, values, refusal,
//     source: 'claude' | 'curated', cache: 'hit' | 'miss',
//   }
//
//   opts.forceFresh?: boolean   Skip the cache lookup, force a fresh
//                                Claude call. Result still gets written
//                                back to cache (UPSERT).
//   opts.skipFillIn?: boolean   Skip the second-pass fill-in call. The
//                                briefing generator pre-resolves at idle
//                                time, so the cost-doubling fill-in is
//                                fine; live UI calls also use it. Mostly
//                                here as an escape hatch.
//
// This module does NOT enforce auth or credit gating — that responsibility
// stays at the call site (the public endpoint enforces credits; the
// briefing generator runs as a privileged background job).
//
// The Claude client is constructed lazily on first call so this module
// is safe to require in environments without ANTHROPIC_API_KEY (the
// briefing generator only resolves heatmaps when key is present).

'use strict';

const crypto = require('crypto');
const pool = require('./db');

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Hash helper (stable cache key) ──────────────────────────────────────
function _hashKey(question, mode) {
  const normalized = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
}

// ── Tools (Claude function-calling spec) ────────────────────────────────
function _buildTools() {
  return [
    // Anthropic-hosted server tool — model can call up to 6 times.
    { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
    {
      name: 'set_country_values',
      description: 'Return a per-country value map answering the user question. Call this LAST, after any web_search calls.',
      input_schema: {
        type: 'object',
        required: ['legend', 'values'],
        properties: {
          legend:      { type: 'string', description: 'Short label for the legend chip (e.g. "Muslim population %", "Press freedom rank").' },
          unit:        { type: 'string', description: 'Unit string for tooltips, e.g. "%", "rank", or empty.' },
          source_note: { type: 'string', description: 'Brief attribution naming the specific source(s) used. If you used web_search, cite the most authoritative result. Mark "AI estimate — verify before citing" only as a last resort.' },
          values: {
            type:  'array',
            description: 'Array of { iso, value } objects. ISOs MUST be drawn from the catalog provided.',
            items: {
              type:  'object',
              required: ['iso', 'value'],
              properties: {
                iso:   { type: 'string', description: '2-letter ISO 3166-1 country code (uppercase).' },
                value: { type: 'number' },
              },
            },
          },
        },
      },
    },
    {
      name: 'decline_question',
      description: 'Decline the question — use when it is biased, unanswerable, or has no meaningful per-country mapping.',
      input_schema: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', description: 'Brief, neutral explanation shown to the user.' } },
      },
    },
  ];
}

// ── System prompt (verbatim from /api/heatmap/ask, parameterised on
//    the country catalog + mode) ────────────────────────────────────────
function _buildSystemPrompt(isoCatalog, mode) {
  const modeGuidance = mode === 'percent'
    ? 'Each value is a percentage 0–100 (e.g. 87.2 means 87.2% of that country\'s population/area/whatever the question asks).'
    : mode === 'rank'
    ? 'Each value is an integer rank starting at 1 (lower = stronger). Only include the ranked countries; omit unranked ones.'
    : /* binary */ 'Each value is 0 or 1. Include only countries where the answer is 1.';

  return `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${mode}. ${modeGuidance}
- Use the set_country_values tool when the question has a meaningful per-country answer.
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Cite specific sources in source_note (e.g. "World Bank 2023" or "Wikipedia: List of mountain peaks, 2024-03"). Only use "AI estimate — verify before citing" as a last resort when no source could be verified.

Question phrasing — REQUIRED interpretation:
- If the question contains "your country", "your nation", "your state", "your homeland", or any second-person possessive pointed at a country/place, interpret it AS IF the user wrote "each country" — i.e. it is a per-country query. The user is not asking about you; they are asking the heatmap to show one value per country. Do NOT decline these questions on the grounds that you have no country of residence.
- Example rephrasings that all mean the same thing:
    "How many universities are in your country?"  →  "How many universities are in each country?"
    "What is your country's GDP?"                →  "What is each country's GDP?"
    "Is your nation in NATO?"                    →  "Is each nation in NATO?"

DATA VERIFICATION POLICY — read carefully:

You have access to a \`web_search\` tool. Speed is NOT a priority — accuracy is. A correct answer that takes 30 seconds is far better than a fast wrong one. USE web_search whenever:
- The question asks for specific numerical data (population, GDP, area, ranks, percentages) and you are not 100% certain of the current value or the full ranking.
- The question references a defined group, treaty, or membership list (NATO, OPEC, EU, NPT signatories, NPT nuclear-weapon states, BRICS, ASEAN, OECD, G20, Schengen, eurozone, Commonwealth, OPEC+) — verify the CURRENT membership before answering. Memberships change.
- The question is on a topic that drifts over time (currency unions, sanctions regimes, alliance expansions, leaders, treaty status, language official-status).
- You can think of obvious candidate countries but cannot confidently enumerate the FULL set.
- Coverage of less-Western regions (Africa, Central Asia, Pacific, Caribbean) is required and you suspect your unaided recall is biased toward the West.

You may call web_search up to 6 times per question. Use them — partial verification is better than none.

AUTHORITATIVE SOURCES BY DOMAIN (prefer these when searching; cite the one you used):
- Demographics / population: worldbank.org, population.un.org, cia.gov/the-world-factbook, census.gov/data/data-tools/idb
- Economics / GDP / trade: worldbank.org, imf.org/data, oec.world, oecd.org/statistics
- Geography / topography / terrain / peaks / rivers: usgs.gov, naturalearthdata.com, geonames.org, britannica.com, peakbagger.com
- Climate / environment / energy: iea.org, ipcc.ch, ourworldindata.org, noaa.gov, climatewatchdata.org
- Biology / biodiversity / ecology: iucnredlist.org, gbif.org, worldwildlife.org, fao.org
- Health / disease / mortality: who.int, healthdata.org (IHME), unaids.org, unicef.org/data
- Politics / governance / corruption / press freedom: freedomhouse.org, v-dem.net, transparency.org, rsf.org
- Languages / religion / culture: ethnologue.com, pewresearch.org, worldatlas.com
- Military / nuclear / arms: sipri.org, iiss.org, fas.org/issues/nuclear-weapons
- Treaties / international orgs / membership: treaties.un.org, europa.eu, nato.int, un.org/en/members
- Wikipedia (en.wikipedia.org) is acceptable as a starting point — its country-list articles are usually well-cited; verify against a primary source when stakes are high.

Cite the specific source(s) you used in source_note. Example: "Source: SIPRI 2023 Yearbook; Wikipedia (NATO members)". Never just write "Sonnet estimate" — search instead.

ACCURACY CHECKLIST — apply before responding:

1. STATE THE CRITERION. Internally restate exactly what the question asks. If it includes a numeric threshold (e.g. "over 10,000 ft", "more than 50%"), treat it as strict. If it names a defined group (EU, NATO, OPEC, NPT signatories), use the canonical membership list.

2. ENUMERATE BY CONTINENT. Walk through every continent — Africa, Asia, Europe, Americas, Oceania — and consider each region's countries. For factual binary questions, the global answer set is usually 30–100 countries. Do NOT rely on only the most famous examples; that's the #1 failure mode.

3. VERIFY EACH CANDIDATE. For each country you'd include, briefly justify why it qualifies — name the specific peak, region, language family, treaty, or feature. If you can't name a specific qualifying reason, do not include the country.

4. EXCLUDE without specific evidence. Do not include a country because it "looks mountainous", "is in that region", or "feels like it should qualify". Specific evidence required.

5. NOTE THE LIMITS in source_note. If you're uncertain about edge cases, list them by name ("excludes borderline cases: X, Y") so the user knows. If your data has a vintage, cite it.

NEVER-MISS LIST (catastrophic failures to prevent):
The following are NOT edge cases — they are the most basic answers and their absence makes the response useless. Self-check: if any of these apply to your question, the named countries MUST appear in your output.

- Population (rank or count): China, India, United States, Indonesia, Pakistan, Nigeria, Brazil, Bangladesh, Russia, Mexico are the world's ten most populous countries. Any population query that omits one of them is broken.
- GDP / economy size (rank or value): United States, China, Japan, Germany, India, United Kingdom, France, Italy, Canada, Brazil are the top-10 economies. Any GDP query missing them is broken.
- Land area: Russia, Canada, China, United States, Brazil, Australia, India, Argentina, Kazakhstan, Algeria.
- Coastline / oceans: every continent has dozens of coastal countries; never return only Western examples.
- Religion majority: Indonesia (largest Muslim country), Brazil (largest Catholic country), India (largest Hindu country) — almost always relevant.
- Nuclear weapons: USA, Russia, UK, France, China, India, Pakistan, Israel, North Korea — exactly nine, no more, no fewer.
- EU membership: 27 countries, no UK (left in 2020), no Norway / Switzerland.

For RANK mode specifically: "rank by X" means EVERY country with a non-trivial value of X should appear. Do not truncate to a top-10 unless the question explicitly says so. If asked "rank by population", every sovereign country should have a rank — China at 1 or 2, the smallest at the bottom. Returning only 20 countries when the world has 190+ is a failure.

For BINARY mode: be more inclusive than your gut suggests. If you can think of three obvious countries that match, there are probably twenty more. Walk continents.

CONFIDENCE FLOOR — 85% rule (read carefully):
- Default behaviour for PERCENT and RANK modes: every country in the catalog should appear in your output. Coverage matters — a heatmap that paints 140 of 190 countries leaves the user asking "why is China grey?" and the answer feels broken.
- If, after web_search, you have ≥85% confidence in a value for a country, INCLUDE IT — even if the value is an estimate, an interpolation from regional averages, or a published figure with mild uncertainty. This is the bar most published demographic / economic / geographic data already meets.
- ONLY OMIT a country when your confidence is below 85% AND no authoritative source exists for it. Omission is the explicit signal "insufficient data" — the client surfaces those countries with the message "insufficient data to provide accurate response".
- Concretely, for a query like "Muslim population %": you should have ≥85% confidence for nearly every sovereign country (Pew, World Bank, CIA Factbook all publish this). It is a failure to omit China, Brazil, Bolivia, etc. — those values are well-documented. Search if you're unsure.
- A blank country is NEVER preferable to a well-sourced estimate. Lazy omission is the failure mode this rule prevents.

Most users will be wronger than you think when checking — but for the cases where they are right and you're missing obvious entries, your answer becomes useless. Aim for high recall on clear positives and strict exclusion of vague matches.`;
}

// ── Cache lookup ────────────────────────────────────────────────────────
async function _cacheLookup(questionHash, mode) {
  const { rows } = await pool.query(
    `SELECT id, mode, legend, unit, source_note, values, refusal, source
       FROM heatmap_qa_cache
      WHERE question_hash = $1 AND mode = $2
      LIMIT 1`,
    [questionHash, mode]
  );
  if (!rows.length) return null;
  const row = rows[0];
  // Fire-and-forget hit accounting.
  pool.query(
    `UPDATE heatmap_qa_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = $1`,
    [row.id]
  ).catch(() => {});
  return row;
}

// ── Cache write (UPSERT) ────────────────────────────────────────────────
async function _cacheWrite(questionHash, rawQuestion, mode, payload) {
  await pool.query(
    `INSERT INTO heatmap_qa_cache
       (question_hash, question_text, mode, legend, unit, source_note, values, refusal, source, hit_count, last_hit_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'claude', 1, NOW())
     ON CONFLICT (question_hash, mode) DO UPDATE SET
       legend       = EXCLUDED.legend,
       unit         = EXCLUDED.unit,
       source_note  = EXCLUDED.source_note,
       values       = EXCLUDED.values,
       refusal      = EXCLUDED.refusal,
       hit_count    = heatmap_qa_cache.hit_count + 1,
       last_hit_at  = NOW()`,
    [questionHash, rawQuestion, mode, payload.legend, payload.unit, payload.source_note, JSON.stringify(payload.values), payload.refusal]
  );
}

// ── Country whitelist ───────────────────────────────────────────────────
async function _loadCountries() {
  const { rows } = await pool.query(
    `SELECT iso_code, name FROM countries WHERE iso_code IS NOT NULL AND length(iso_code) = 2 ORDER BY name`
  );
  const isoSet = new Set(rows.map(c => c.iso_code.toUpperCase()));
  const isoCatalog = rows.map(c => `${c.iso_code.toUpperCase()} ${c.name}`).join('\n');
  return { rows, isoSet, isoCatalog };
}

// ── First-pass Claude call ──────────────────────────────────────────────
async function _firstPass(question, mode, isoCatalog, tools) {
  const claude = _getClient();
  return claude.messages.create({
    model:       'claude-sonnet-4-5-20250929',
    max_tokens:  12000,
    system:      _buildSystemPrompt(isoCatalog, mode),
    tools,
    tool_choice: { type: 'any' },
    messages:    [{ role: 'user', content: question }],
  });
}

// ── Validate + extract first-pass tool result ───────────────────────────
function _extractFirstPass(claudeResp, mode, rawQuestion, isoSet) {
  const toolUse = (claudeResp.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) {
    const err = new Error('Model returned no tool call');
    err.code = 'NO_TOOL_CALL';
    throw err;
  }
  const payload = { legend: null, unit: null, source_note: null, values: [], refusal: null };
  if (toolUse.name === 'decline_question') {
    payload.refusal = String(toolUse.input?.reason || 'Question cannot be answered as a heatmap.');
    return { payload, seen: new Set() };
  }
  if (toolUse.name === 'set_country_values') {
    const raw = toolUse.input || {};
    payload.legend      = String(raw.legend || rawQuestion).slice(0, 120);
    payload.unit        = raw.unit ? String(raw.unit).slice(0, 16) : (mode === 'percent' ? '%' : (mode === 'rank' ? 'rank' : ''));
    payload.source_note = String(raw.source_note || 'AI estimate — verify before citing').slice(0, 240);
    const seen = new Set();
    const rawArr = Array.isArray(raw.values) ? raw.values : [];
    payload.values = rawArr
      .map(v => ({ iso: String(v.iso || '').toUpperCase().trim(), value: Number(v.value) }))
      .filter(v => {
        if (!v.iso) return false;
        if (!isoSet.has(v.iso)) return false;
        if (!Number.isFinite(v.value)) return false;
        if (seen.has(v.iso)) return false;
        seen.add(v.iso);
        return true;
      })
      .map(v => ({ iso: v.iso, value: v.value }));
    return { payload, seen };
  }
  // Unexpected tool name (model misbehaved) — treat as refusal.
  payload.refusal = `Unexpected tool: ${toolUse.name}`;
  return { payload, seen: new Set() };
}

// ── Second-pass fill-in (covers all three modes) ────────────────────────
// For percent and rank we expect near-complete coverage of all ~190
// sovereign countries — the heatmap looks broken when major countries
// (China, Brazil, etc.) are blank because the model lazily skipped them.
// Binary stays opt-in around a smaller threshold since "many countries
// match" is uncommon for binary questions.
//
// The 85%-confidence rule established in the system prompt is restated
// in the fill-in user message: estimate where you'd publish, omit
// where you would not. Omitted countries surface as "Insufficient data
// to provide accurate response" on the client.
async function _fillInPass({ payload, seen, mode, rawQuestion, countryRows, isoSet, isoCatalog, tools }) {
  // Per-mode thresholds: trigger fill-in if value count is below this.
  // percent: aim for ~140 covered (out of ~190 sovereigns) before we
  // stop — most demographic / economic / geographic queries should
  // easily clear this.
  // rank: aim for 100 — half-coverage is the floor for a usable rank map.
  // binary: 15 stays as before; binary is naturally sparse.
  const FILL_IN_THRESHOLDS = { percent: 140, rank: 100, binary: 15 };
  const fillInTarget = FILL_IN_THRESHOLDS[mode];
  if (!fillInTarget || payload.values.length === 0 || payload.values.length >= fillInTarget) return;
  if (process.env.HEATMAP_FILL_IN === 'false') return;

  try {
    const claude = _getClient();
    const isoToName = new Map(countryRows.map(c => [c.iso_code.toUpperCase(), c.name]));
    const missing = countryRows.map(c => c.iso_code.toUpperCase()).filter(iso => !seen.has(iso));
    const existingSummary = payload.values
      .slice()
      .sort((a, b) => (mode === 'rank' ? a.value - b.value : b.value - a.value))
      .map(v => `${v.iso} (${isoToName.get(v.iso) || v.iso})=${v.value}`)
      .join(', ');
    const lastRank = (mode === 'rank') ? Math.max(...payload.values.map(v => v.value || 0)) : null;

    // Mode-specific guidance for the additional countries.
    const continueGuidance = mode === 'rank'
      ? `Continue the rank sequence — your last rank was ${lastRank}, so new entries should be ranked starting at ${lastRank + 1} and continuing until you've ranked every country with a meaningful value. DO NOT REPEAT countries already in the previous answer above.`
      : mode === 'binary'
      ? 'Include ONLY countries where the answer is 1 (yes / true). DO NOT REPEAT countries already in the previous answer above.'
      : /* percent */ `Provide a percent value (0–100) for each missing country where you have ≥85% confidence in the figure. For demographic / economic / geographic questions, established sources (World Bank, Pew, CIA Factbook, IMF) cover essentially every sovereign country — search them if your unaided recall is uncertain. DO NOT REPEAT countries already in the previous answer above.`;

    const userMsg = `Your previous answer to "${rawQuestion}" (mode: ${mode}) returned only ${payload.values.length} countries:

${existingSummary}

The world has 190+ sovereign countries. Your answer is incomplete. Walk through the following countries that were NOT in your previous answer.

Missing from previous answer (${missing.length} countries):
${missing.map(iso => `${iso} ${isoToName.get(iso) || ''}`.trim()).join('\n')}

CONFIDENCE RULE — 85% floor:
For each missing country, decide: do I have at least 85% confidence in a value? An estimate from a reputable source, an interpolation from a regional aggregate, or a published figure with mild uncertainty all clear that bar. INCLUDE those.
OMIT only countries where you cannot reach 85% confidence even after a web_search. Those will appear as "insufficient data to provide accurate response" on the client — that is the explicit signal a user expects when data genuinely doesn't exist, NOT a substitute for laziness.

A blank country is NEVER preferable to a well-sourced estimate. If you can find a value via web_search, include it.

${continueGuidance}

Call set_country_values with ONLY the additional countries.`;

    const resp = await claude.messages.create({
      model:       'claude-sonnet-4-5-20250929',
      max_tokens:  8000,
      system:      _buildSystemPrompt(isoCatalog, mode),
      tools,
      tool_choice: { type: 'tool', name: 'set_country_values' },
      messages:    [{ role: 'user', content: userMsg }],
    });
    const tool = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'set_country_values');
    if (!tool) return;
    const fillRaw = tool.input || {};
    const fillArr = Array.isArray(fillRaw.values) ? fillRaw.values : [];
    let added = 0;
    for (const v of fillArr) {
      const iso = String(v.iso || '').toUpperCase().trim();
      const num = Number(v.value);
      if (!iso || !isoSet.has(iso))    continue;
      if (!Number.isFinite(num))       continue;
      if (seen.has(iso))               continue;
      seen.add(iso);
      payload.values.push({ iso, value: num });
      added++;
    }
    if (added > 0 && fillRaw.source_note) {
      const extra = String(fillRaw.source_note).slice(0, 120);
      if (!payload.source_note?.includes(extra)) {
        payload.source_note = `${payload.source_note}; +fill-in: ${extra}`.slice(0, 240);
      }
    }
  } catch (err) {
    // Fill-in failure is non-fatal — return the original answer.
    console.warn(`[heatmapResolver] fill-in failed: ${err.message}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────
async function resolveHeatmap(question, mode, opts = {}) {
  const rawQuestion = String(question || '').trim();
  if (!rawQuestion) throw Object.assign(new Error('question is required'), { code: 'BAD_INPUT' });
  if (rawQuestion.length > 280) throw Object.assign(new Error('question too long (max 280 chars)'), { code: 'BAD_INPUT' });
  const m = String(mode || 'percent').toLowerCase();
  if (!['percent', 'rank', 'binary'].includes(m)) {
    throw Object.assign(new Error('mode must be percent | rank | binary'), { code: 'BAD_INPUT' });
  }

  const questionHash = _hashKey(rawQuestion, m);

  // 1. Cache lookup (skipped if forceFresh).
  if (!opts.forceFresh) {
    const row = await _cacheLookup(questionHash, m);
    if (row) {
      return {
        question:    rawQuestion,
        mode:        row.mode,
        legend:      row.legend,
        unit:        row.unit,
        source_note: row.source_note,
        values:      row.values,
        refusal:     row.refusal,
        source:      row.source,        // 'claude' | 'curated'
        cache:       'hit',
      };
    }
  }

  // 2. Country whitelist + tool spec.
  const { rows: countryRows, isoSet, isoCatalog } = await _loadCountries();
  const tools = _buildTools();

  // 3. First-pass Claude call.
  const firstResp = await _firstPass(rawQuestion, m, isoCatalog, tools);
  const { payload, seen } = _extractFirstPass(firstResp, m, rawQuestion, isoSet);

  // 4. Optional second-pass fill-in for rank/binary truncation.
  if (!opts.skipFillIn && !payload.refusal) {
    await _fillInPass({ payload, seen, mode: m, rawQuestion, countryRows, isoSet, isoCatalog, tools });
  }

  // 5. Persist to cache (UPSERT).
  await _cacheWrite(questionHash, rawQuestion, m, payload);

  return {
    question:    rawQuestion,
    mode:        m,
    legend:      payload.legend,
    unit:        payload.unit,
    source_note: payload.source_note,
    values:      payload.values,
    refusal:     payload.refusal,
    source:      'claude',
    cache:       'miss',
  };
}

module.exports = { resolveHeatmap };
