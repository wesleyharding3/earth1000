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
const extractors = require('./extractors');
const { loadResolver: loadIsoNameResolver } = require('./extractors/_isoMatch');
const { ALPHA3_TO_ALPHA2 } = require('./isoCountryCodes');

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Lazy-init the name resolver — same Pool, shared cache across all
// extractions for the lifetime of the process. Re-uses the project's
// `countries` table + alias map (see extractors/_isoMatch.js).
let _isoNameResolver = null;
async function _getIsoNameResolver() {
  if (_isoNameResolver) return _isoNameResolver;
  _isoNameResolver = await loadIsoNameResolver(pool);
  return _isoNameResolver;
}

// ── Hash helper (stable cache key) ──────────────────────────────────────
function _hashKey(question, mode) {
  const normalized = String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${mode}|${normalized}`).digest('hex');
}

// ── Tools (Claude function-calling spec) ────────────────────────────────
//
// The tool list is composed of:
//   1. web_search           — Anthropic-hosted, for source/URL/indicator-code DISCOVERY only
//   2. Extractor tools      — server-side parsers (Wikipedia, World Bank, OECD, WHO, Factbook)
//                              that return STRUCTURED data with verified values. Defined in
//                              extractors/. Claude routes by reading their descriptions.
//   3. set_country_values   — terminal: the final per-country heatmap data
//   4. decline_question     — terminal: refusal
//
// The tool-execution loop runs Claude in multi-turn mode: extractor tool
// calls are executed server-side, results fed back, and Claude continues
// until it calls a terminal tool. See _runToolLoop below.
function _buildTools() {
  return [
    // 1. Discovery: search engine for finding the right source URL or
    //    indicator code. NOT for extracting values directly — extractors
    //    do that. The system prompt makes this distinction explicit.
    { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
    // 2. Source extractors — registered in extractors/index.js.
    ...extractors.getToolDefs(),
    // 3-4. Terminal tools (unchanged):
    {
      name: 'set_country_values',
      description: 'Return a per-country value map answering the user question. Call this LAST, after any extractor tool returns its structured data. For quantitative ranking questions you MUST extract from a source first (extract_wikipedia_table / query_world_bank_indicator / etc.); this tool is the terminal call that bakes the verified ranking into the heatmap response.',
      input_schema: {
        type: 'object',
        required: ['legend', 'values', 'confidence_tier'],
        properties: {
          legend:      { type: 'string', description: 'Short label for the legend chip (e.g. "Muslim population %", "Press freedom rank").' },
          unit:        { type: 'string', description: 'Unit string for tooltips, e.g. "%", "rank", or empty.' },
          source_note: { type: 'string', description: 'Brief attribution naming the specific source(s) used. When an extractor was called, INCLUDE the source URL or indicator code returned in its source_note. Only write "AI estimate — verify before citing" when no extractor matched and you had to estimate.' },
          confidence_tier: {
            type: 'string',
            enum: ['extracted', 'estimate'],
            description: 'REQUIRED. "extracted" when values came verbatim from an extractor tool result (Wikipedia / WB / WHO / OECD / Factbook). "estimate" when no authoritative source was found and you fell back to your own knowledge. NEVER call this "extracted" without an extractor call in the conversation history.',
          },
          values: {
            type:  'array',
            description: 'Array of { iso, value } objects. ISOs MUST be drawn from the catalog provided. For "extracted" tier, values MUST match the extractor result (you may sort / convert units / filter for the answer set, but you may not invent or substitute values).',
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
      description: 'Decline the question. Categorise the decline via `kind` so the system can pick the right next step. If you decline because the question is well-formed but you cannot reach the 85% confidence floor on enough countries to make a useful heatmap, set kind="low_data" — the system will then re-prompt you for a best-effort ESTIMATE that the user is told may contain errors.',
      input_schema: {
        type: 'object',
        required: ['reason', 'kind'],
        properties: {
          reason: { type: 'string', description: 'Brief, neutral explanation shown to the user.' },
          kind: {
            type: 'string',
            enum: ['biased', 'no_mapping', 'dangerous', 'low_data', 'other'],
            description: 'Category of decline. "biased" = value-loaded / opinion-laden. "no_mapping" = the question has no objective per-country answer. "dangerous" = harmful content. "low_data" = the question IS well-formed and HAS a per-country mapping, but you do not have enough confident data — system will re-prompt you for an estimate. "other" = anything else.',
          },
        },
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
    ? 'Each value is an integer rank starting at 1 (rank 1 = strongest / largest / "winner" per the user\'s question). CRITICAL: when an extractor returns raw measurements (meters, dollars, people, etc.), you MUST sort them in the order implied by the question and assign integers 1..N — DO NOT forward raw values as the rank. Example: for "Countries by elevation range" the extractor returns meters per country. Sort descending (largest range first), assign rank 1 to the largest, rank 2 to the second-largest, etc. The set_country_values "value" field MUST be the assigned rank integer, not the original meters.'
    : /* binary */ 'Each value is 0 or 1. Include only countries where the answer is 1.';

  return `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${mode}. ${modeGuidance}
- For QUANTITATIVE questions (numeric values, rankings, percentages) you MUST first call an EXTRACTOR TOOL to fetch verified data from an authoritative source. NEVER call set_country_values with quantitative values that did not come from an extractor's tool_result.
- For non-quantitative questions (cultural, opinion, hypothetical) where no extractor would apply, call set_country_values with confidence_tier="estimate" and source_note declaring "AI estimate — no authoritative source available".
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Cite the EXTRACTED source's URL or indicator code in source_note (the extractor returns this in its source_note — copy it verbatim).

${extractors.buildRoutingGuide()}

WORKFLOW for every quantitative question:
1. Identify which extractor matches the question (World Bank for economic/development indicators; Wikipedia for geographic/cultural rankings; WHO for health; OECD for OECD-specific; Factbook for canonical geography fallback).
2. If you need to discover the right URL / indicator code first, call web_search ONCE — but only to identify the source, not to extract values from search snippets.
3. Call the matching extractor with the correct parameters.
4. Read the structured values returned in the extractor's tool_result.
5. Sort / filter / format per the mode (rank: 1..N by value; percent: pass through; binary: keep only matching entries).
6. Call set_country_values with confidence_tier="extracted" and the source_note from the extractor result.
7. If the extractor returns < 30 rows or errored, retry with a different extractor BEFORE falling back to estimate mode.

ENFORCEMENT — strict rules (do not violate):
- For ANY quantitative question (numeric values, rankings, percentages, counts) you MUST attempt at least ONE extractor tool call before you may call set_country_values OR decline_question.
- decline_question with kind="low_data" is FORBIDDEN unless you have ALREADY called at least one extractor and it returned fewer than 30 useful rows (or errored). Without a prior extractor attempt, "I don't have enough data" is wrong — you haven't looked yet.
- decline_question with kind="biased" / "no_mapping" / "dangerous" remains allowed on the first turn for questions that obviously fit those categories (e.g. "best food", "most beautiful country").
- Calling set_country_values with confidence_tier="extracted" REQUIRES that an extractor tool_result is in your immediate prior context with the values you used. If you set "extracted" without an extractor result, the system will reject your answer.
- "Countries by [physical / economic / demographic feature]" — elevation, area, GDP, population, life expectancy, etc. — ALWAYS has an extractor. Skipping straight to estimate or decline on these is a correctness failure.

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

// ── First-pass tool-execution loop ──────────────────────────────────────
// Multi-turn conversation: Claude can call extractor tools, server-side
// runs them, results fed back, repeat until Claude calls a terminal
// tool (set_country_values or decline_question). MAX_TURNS guards
// against pathological loops where Claude keeps requesting extractions.
//
// The final Anthropic response (the one with the terminal tool_use) is
// returned so the existing _extractFirstPass logic can pull the result.
const MAX_TURNS = 10;
const TOOL_RESULT_MAX_BYTES = 80_000;   // cap each tool_result content to keep context manageable

function _trimToolResultPayload(payload) {
  // Keep values (the data) and source_note. Trim skipped to a short
  // summary so the context isn't blown out on tables with many
  // unresolved country names.
  const trimmed = {
    values: payload?.values || [],
    row_count: payload?.row_count ?? (payload?.values?.length ?? 0),
    source_note: payload?.source_note || '',
    skipped_count: payload?.skipped_count ?? (Array.isArray(payload?.skipped) ? payload.skipped.length : 0),
  };
  if (Array.isArray(payload?.skipped) && payload.skipped.length) {
    trimmed.skipped_sample = payload.skipped.slice(0, 5);
  }
  let json = JSON.stringify(trimmed);
  if (json.length > TOOL_RESULT_MAX_BYTES) {
    // Drop value entries beyond the cap. Each value is small but with
    // 200+ rows the total can get big.
    const keep = Math.max(50, Math.floor(trimmed.values.length / 2));
    trimmed.values = trimmed.values.slice(0, keep);
    trimmed.values_truncated = true;
    json = JSON.stringify(trimmed);
  }
  return json;
}

async function _runToolLoop(question, mode, isoCatalog, tools, resolveName, env) {
  const claude = _getClient();
  const messages = [{ role: 'user', content: question }];
  let lastResp = null;
  // Union of all country ISOs returned by extractor tool_results across
  // every turn. Used downstream to enforce: if Claude claims
  // confidence_tier='extracted', it can only include countries that
  // actually appeared in an extractor's output (no hallucinated entries).
  const extractedIsos = new Set();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await claude.messages.create({
      model:       'claude-sonnet-4-5-20250929',
      max_tokens:  12000,
      system:      _buildSystemPrompt(isoCatalog, mode),
      tools,
      messages,
    });
    lastResp = resp;

    const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');

    const terminalTool = toolUses.find(b => b.name === 'set_country_values' || b.name === 'decline_question');
    if (terminalTool) return { resp, extractedIsos };

    if (!toolUses.length || resp.stop_reason !== 'tool_use') {
      return { resp, extractedIsos };
    }

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === 'web_search') continue;

      const ext = extractors.getExtractorByName(tu.name);
      if (!ext) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Unknown tool: ${tu.name}. Available extractor tools: ${extractors.REGISTRY.map(e => e.toolDef.name).join(', ')}.`,
          is_error: true,
        });
        continue;
      }
      const result = await extractors.runExtractor(tu.name, tu.input || {}, resolveName, env);
      if (!result.ok) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: `Extractor error: ${result.error}`,
          is_error: true,
        });
      } else {
        // Collect ISOs from this extractor's output. Each extractor's
        // result.payload.values is an array of { iso, value, ... }.
        const isos = Array.isArray(result.payload?.values) ? result.payload.values : [];
        for (const v of isos) {
          if (v?.iso) extractedIsos.add(String(v.iso).toUpperCase());
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: _trimToolResultPayload(result.payload),
          is_error: false,
        });
      }
    }

    if (!toolResults.length) {
      messages.push({ role: 'user', content: 'Continue.' });
    } else {
      messages.push({ role: 'user', content: toolResults });
    }
  }

  console.warn(`[heatmapResolver] tool loop hit MAX_TURNS=${MAX_TURNS} without a terminal tool call`);
  return { resp: lastResp, extractedIsos };
}

// ── Validate + extract first-pass tool result ───────────────────────────
function _extractFirstPass(claudeResp, mode, rawQuestion, isoSet, extractedIsos = null) {
  const toolUse = (claudeResp.content || []).find(b => b.type === 'tool_use');
  if (!toolUse) {
    const err = new Error('Model returned no tool call');
    err.code = 'NO_TOOL_CALL';
    throw err;
  }
  const payload = { legend: null, unit: null, source_note: null, values: [], refusal: null, refusalKind: null };
  if (toolUse.name === 'decline_question') {
    payload.refusal = String(toolUse.input?.reason || 'Question cannot be answered as a heatmap.');
    payload.refusalKind = String(toolUse.input?.kind || 'other').toLowerCase();
    return { payload, seen: new Set() };
  }
  if (toolUse.name === 'set_country_values') {
    const raw = toolUse.input || {};
    payload.legend      = String(raw.legend || rawQuestion).slice(0, 120);
    payload.unit        = raw.unit ? String(raw.unit).slice(0, 16) : (mode === 'percent' ? '%' : (mode === 'rank' ? 'rank' : ''));
    payload.source_note = String(raw.source_note || 'AI estimate — verify before citing').slice(0, 240);
    payload.confidence_tier = (raw.confidence_tier === 'extracted') ? 'extracted' : 'estimate';
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

    // Strict-extracted enforcement. Two failure modes to catch:
    //   A) Claude claims 'extracted' BUT no extractor returned any
    //      values (all failed / weren't called). Downgrade to 'estimate'.
    //   B) Claude claims 'extracted' AND extractor returned values,
    //      but Claude padded with countries not in the extractor set.
    //      Filter values to the extractor's verified ISO set.
    if (payload.confidence_tier === 'extracted') {
      if (!extractedIsos || extractedIsos.size === 0) {
        // (A) No extractor data backing the claim — downgrade.
        console.warn(`[heatmapResolver] downgrading 'extracted' → 'estimate': no extractor returned any values`);
        payload.confidence_tier = 'estimate';
        payload.source_note = `⚠ AI estimate (extractor returned no data). ${payload.source_note}`.slice(0, 240);
      } else {
        // (B) Filter to extractor-verified ISOs.
        const before = payload.values.length;
        payload.values = payload.values.filter(v => extractedIsos.has(v.iso));
        const dropped = before - payload.values.length;
        if (dropped > 0) {
          console.warn(`[heatmapResolver] strict filter dropped ${dropped}/${before} values not in extractor results`);
          const note = ` [${dropped} unverified value${dropped === 1 ? '' : 's'} dropped]`;
          payload.source_note = (payload.source_note + note).slice(0, 240);
        }
        seen.clear();
        for (const v of payload.values) seen.add(v.iso);
      }
    }

    // Safety net for rank-mode: if Claude forwarded raw extractor values
    // (meters, dollars, people, etc.) instead of converting to 1..N
    // integers, auto-rank server-side. Heuristic: a properly-ranked
    // response has integer values where max <= 2*N (small slack for
    // ties). Anything beyond that is almost certainly raw measurements.
    if (mode === 'rank' && payload.values.length >= 5) {
      const N = payload.values.length;
      const maxVal = Math.max(...payload.values.map(v => v.value));
      const allIntegers = payload.values.every(v => Number.isInteger(v.value));
      if (!allIntegers || maxVal > N * 2) {
        // Auto-rank descending (largest raw value → rank 1).
        // Note: this assumes "bigger = better" per the user's question,
        // which is the common case for ranking questions. Edge cases
        // (e.g. "ranked by lowest temperature") would need Claude to
        // pre-invert; for now we accept the common-case auto-rank.
        const sorted = [...payload.values].sort((a, b) => b.value - a.value);
        payload.values = sorted.map((v, i) => ({ iso: v.iso, value: i + 1 }));
        payload.source_note = `${payload.source_note} (auto-ranked server-side)`.slice(0, 240);
      }
    }
    // Same safety for percent-mode: detect values clearly outside 0-100
    // that look like raw measurements, and skip (don't render misleading
    // values as percents). Caller can choose to retry with stricter prompt.
    if (mode === 'percent' && payload.values.length) {
      const outOfRange = payload.values.filter(v => v.value < -1 || v.value > 101).length;
      if (outOfRange > payload.values.length * 0.2) {
        // More than 20% of values are clearly not percentages — log and
        // mark the response as suspect via a source_note prefix.
        console.warn(`[heatmapResolver] percent-mode result has ${outOfRange}/${payload.values.length} out-of-range values — likely raw measurements, not percents`);
        payload.source_note = `⚠ Values may not be percentages. ${payload.source_note}`.slice(0, 240);
      }
    }

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

// ── Estimate fallback (low-data refusals only) ─────────────────────────
// When the first pass declines with kind='low_data' — the question is
// well-formed but Claude couldn't reach the 85% confidence floor — we
// re-prompt with the confidence requirement explicitly DROPPED, forcing
// the model to produce its best estimate. The result is tagged with a
// prominent "ESTIMATE — may contain errors" prefix in source_note so
// the user knows the values are not authoritative.
//
// We do NOT do this for other decline kinds (biased / no_mapping /
// dangerous) — those should stay declined.
async function _estimateFallbackPass(rawQuestion, mode, isoCatalog, isoSet, tools) {
  const claude = _getClient();
  const userMsg = `Your previous strict-pass answer to "${rawQuestion}" (mode: ${mode}) was declined with kind="low_data" — meaning the question is well-formed and HAS a per-country mapping, but you couldn't reach the 85% confidence floor on enough countries.

The user has now been told that the next response is an ESTIMATE and may contain errors. Drop the 85% confidence floor entirely. Provide your best estimate for as many countries as you can — interpolations from regional averages, low-confidence published figures, and informed guesses are all acceptable as long as you have ANY reasonable basis.

Use web_search aggressively (up to 6 calls) to find ANY data, even imperfect or partial. Estimate the rest from regional patterns or known anchors.

Call set_country_values. Do NOT call decline_question on this attempt — the user has already accepted that the answer will be an estimate.`;

  const resp = await claude.messages.create({
    model:       'claude-sonnet-4-5-20250929',
    max_tokens:  12000,
    system:      _buildSystemPrompt(isoCatalog, mode),
    tools,
    tool_choice: { type: 'tool', name: 'set_country_values' },
    messages:    [{ role: 'user', content: userMsg }],
  });
  const toolUse = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'set_country_values');
  if (!toolUse) return null;

  const raw = toolUse.input || {};
  const payload = {
    legend:      String(raw.legend || rawQuestion).slice(0, 120),
    unit:        raw.unit ? String(raw.unit).slice(0, 16) : (mode === 'percent' ? '%' : (mode === 'rank' ? 'rank' : '')),
    source_note: String(raw.source_note || 'AI estimate — verify before citing').slice(0, 240),
    values:      [],
    refusal:     null,
    refusalKind: null,
  };
  const seen = new Set();
  const arr = Array.isArray(raw.values) ? raw.values : [];
  for (const v of arr) {
    const iso = String(v.iso || '').toUpperCase().trim();
    const num = Number(v.value);
    if (!iso || !isoSet.has(iso))    continue;
    if (!Number.isFinite(num))       continue;
    if (seen.has(iso))               continue;
    seen.add(iso);
    payload.values.push({ iso, value: num });
  }
  if (!payload.values.length) return null;
  return { payload, seen };
}

// Prepend the estimate caveat to source_note so the front-end's existing
// note surface (#semHeatAskNote, italic warm-amber) declares it. Capped
// at 240 chars total to fit the column.
function _markAsEstimate(payload) {
  const prefix = '⚠ ESTIMATE — may contain errors. ';
  const existing = payload.source_note || '';
  if (existing.startsWith(prefix)) return;
  payload.source_note = `${prefix}${existing}`.slice(0, 240);
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
      // Detect estimate from the source_note prefix that _markAsEstimate
      // wrote on the original miss-path resolve. No schema change needed.
      const isEstimate = typeof row.source_note === 'string' &&
                          row.source_note.startsWith('⚠ ESTIMATE — may contain errors.');
      return {
        question:    rawQuestion,
        mode:        row.mode,
        legend:      row.legend,
        unit:        row.unit,
        source_note: row.source_note,
        values:      row.values,
        refusal:     row.refusal,
        is_estimate: isEstimate,
        source:      row.source,        // 'claude' | 'curated'
        cache:       'hit',
      };
    }
  }

  // 2. Country whitelist + tool spec + name resolver.
  const { rows: countryRows, isoSet, isoCatalog } = await _loadCountries();
  const tools = _buildTools();
  const resolveName = await _getIsoNameResolver();
  const extractorEnv = { isoAlpha3ToAlpha2: ALPHA3_TO_ALPHA2 };

  // 3. Multi-turn tool-execution loop. Claude calls extractor tools
  //    server-side (Wikipedia / WB / WHO / OECD / Factbook), we run
  //    them and feed structured results back. The loop exits when
  //    Claude calls a terminal tool (set_country_values or
  //    decline_question). See _runToolLoop for the protocol.
  const { resp: firstResp, extractedIsos } = await _runToolLoop(rawQuestion, m, isoCatalog, tools, resolveName, extractorEnv);
  let { payload, seen } = _extractFirstPass(firstResp, m, rawQuestion, isoSet, extractedIsos);

  // 4. Estimate fallback — only when first pass declined with kind='low_data'.
  // Other decline kinds (biased / no_mapping / dangerous) stay declined.
  let isEstimate = false;
  if (payload.refusal && payload.refusalKind === 'low_data') {
    try {
      const fallback = await _estimateFallbackPass(rawQuestion, m, isoCatalog, isoSet, tools);
      if (fallback) {
        payload = fallback.payload;
        seen    = fallback.seen;
        isEstimate = true;
        _markAsEstimate(payload);
      }
      // If fallback returned null, the original refusal stands.
    } catch (err) {
      console.warn(`[heatmapResolver] estimate fallback failed: ${err.message}`);
      // Original refusal stands.
    }
  }

  // 5. Optional second-pass fill-in for rank/binary truncation.
  // Skip on estimate path — fill-in's prompt re-asserts the 85% confidence
  // floor, which contradicts the estimate intent.
  // ALSO skip on extracted path — fill-in asks Claude to estimate
  // missing countries from memory, which is exactly the hallucination
  // we just stripped via the strict filter above. Letting it run would
  // re-pollute the answer with the same wrong values we dropped.
  // Accuracy > coverage: a 60-country verified ranking beats a 195-
  // country half-verified one.
  if (!opts.skipFillIn && !payload.refusal && !isEstimate && payload.confidence_tier !== 'extracted') {
    await _fillInPass({ payload, seen, mode: m, rawQuestion, countryRows, isoSet, isoCatalog, tools });
  }

  // After all passes (including fill-in for non-extracted paths), re-run
  // the rank-mode auto-rank if values were added by the fill-in pass.
  // Otherwise rank values can have gaps (e.g. 1, 2, 3, 5, 8) after the
  // strict filter dropped some entries — fix by re-normalizing to 1..N.
  if (mode === 'rank' && payload.values.length >= 5 && !payload.refusal) {
    const allIntegers = payload.values.every(v => Number.isInteger(v.value));
    if (allIntegers) {
      const sorted = [...payload.values].sort((a, b) => a.value - b.value);
      payload.values = sorted.map((v, i) => ({ iso: v.iso, value: i + 1 }));
    }
  }

  // 6. Persist to cache (UPSERT). The estimate caveat is encoded in
  // source_note so cache replays preserve the declaration without a
  // schema change to heatmap_qa_cache.
  await _cacheWrite(questionHash, rawQuestion, m, payload);

  return {
    question:         rawQuestion,
    mode:             m,
    legend:           payload.legend,
    unit:             payload.unit,
    source_note:      payload.source_note,
    values:           payload.values,
    refusal:          payload.refusal,
    is_estimate:      isEstimate,
    confidence_tier:  payload.confidence_tier || (isEstimate ? 'estimate' : 'extracted'),
    source:           'claude',
    cache:            'miss',
  };
}

module.exports = { resolveHeatmap };
