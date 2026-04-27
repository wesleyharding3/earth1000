/**
 * heatmap-ask-debug.js
 *
 * Reproduces /api/heatmap/ask's exact Claude call so we can see why a
 * specific country gets omitted. After the normal call, runs a *second*
 * call asking Claude to explain why any country in a watch-list was missing
 * (or to confirm it intentionally included it).
 *
 * Usage:
 *   node scripts/heatmap-ask-debug.js \
 *     --q "How many universities are in your country?" \
 *     --mode percent \
 *     --watch CN,KP,CD
 *
 * Prereqs: .env with ANTHROPIC_API_KEY + DATABASE_URL.
 *
 * Read-only against the DB; spends Anthropic credits (Sonnet + web_search).
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const ARGV = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => {
  if (!a.startsWith('--')) return null;
  const k = a.replace(/^--/, '');
  const eq = k.indexOf('=');
  if (eq >= 0) return [k.slice(0, eq), k.slice(eq + 1)];
  const next = arr[i + 1];
  return [k, next && !String(next).startsWith('--') ? next : true];
}).filter(Boolean));

const QUESTION = String(ARGV.q || ARGV.question || 'How many universities are in your country?');
const MODE     = String(ARGV.mode || 'percent').toLowerCase();
const WATCH    = String(ARGV.watch || 'CN,KP,CD').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

if (!['percent', 'rank', 'binary'].includes(MODE)) {
  console.error('Bad mode. Use percent | rank | binary');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const Anth = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function main() {
  // 1. Country whitelist — copied from server.js:11194
  const { rows: countryRows } = await pool.query(
    `SELECT iso_code, name FROM countries
      WHERE iso_code IS NOT NULL AND length(iso_code) = 2
      ORDER BY name`
  );
  const isoSet = new Set(countryRows.map(c => c.iso_code.toUpperCase()));
  const isoCatalog = countryRows.map(c => `${c.iso_code.toUpperCase()} ${c.name}`).join('\n');

  // Sanity-check the watch list against the whitelist FIRST. If any watch
  // ISO isn't in the whitelist, Claude can never include it — that's a
  // pure DB issue, not a Claude issue.
  console.log(`\n=== Whitelist sanity ===`);
  console.log(`Total whitelisted countries: ${isoSet.size}`);
  for (const iso of WATCH) {
    console.log(`  ${iso}: ${isoSet.has(iso) ? 'in whitelist' : '*** NOT IN WHITELIST (Claude can\'t emit this) ***'}`);
  }

  // 2. Mode guidance — copied from server.js:11202
  const modeGuidance = MODE === 'percent'
    ? "Each value is a percentage 0–100 (e.g. 87.2 means 87.2% of that country's population/area/whatever the question asks)."
    : MODE === 'rank'
    ? 'Each value is an integer rank starting at 1 (lower = stronger). Only include the ranked countries; omit unranked ones.'
    : 'Each value is 0 or 1. Include only countries where the answer is 1.';

  // 3. Tools — copied from server.js (web_search + set_country_values + decline_question)
  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
    {
      name: 'set_country_values',
      description: 'Return a per-country value map answering the user question. Call this LAST, after any web_search calls.',
      input_schema: {
        type: 'object',
        required: ['legend', 'values'],
        properties: {
          legend:      { type: 'string' },
          unit:        { type: 'string' },
          source_note: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object',
              required: ['iso', 'value'],
              properties: { iso: { type: 'string' }, value: { type: 'number' } },
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
        properties: { reason: { type: 'string' } },
      },
    },
  ];

  // 4. System prompt — verbatim from server.js
  const systemPrompt = `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${MODE}. ${modeGuidance}
- Use the set_country_values tool when the question has a meaningful per-country answer.
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Cite specific sources in source_note. Only use "AI estimate — verify before citing" as a last resort when no source could be verified.

Question phrasing — REQUIRED interpretation:
- If the question contains "your country", "your nation", "your state", "your homeland", or any second-person possessive pointed at a country/place, interpret it AS IF the user wrote "each country" — i.e. it is a per-country query. The user is not asking about you; they are asking the heatmap to show one value per country. Do NOT decline these questions on the grounds that you have no country of residence.

DATA VERIFICATION POLICY — read carefully:

You have access to a \`web_search\` tool. Speed is NOT a priority — accuracy is. A correct answer that takes 30 seconds is far better than a fast wrong one. USE web_search whenever the question asks for specific numerical data and you are not 100% certain of the current value.

You may call web_search up to 6 times per question. Use them — partial verification is better than none.

NEVER-MISS LIST (catastrophic failures to prevent):
- Population (rank or count): China, India, United States, Indonesia, Pakistan, Nigeria, Brazil, Bangladesh, Russia, Mexico are the world's ten most populous countries. Any population query that omits one of them is broken.
- GDP / economy size (rank or value): United States, China, Japan, Germany, India, United Kingdom, France, Italy, Canada, Brazil are the top-10 economies. Any GDP query missing them is broken.
- Land area: Russia, Canada, China, United States, Brazil, Australia, India, Argentina, Kazakhstan, Algeria.

For RANK mode specifically: "rank by X" means EVERY country with a non-trivial value of X should appear.

For BINARY mode: be more inclusive than your gut suggests.

Aim for high recall on clear positives and strict exclusion of vague matches.`;

  // 5. The actual call
  console.log(`\n=== Asking Claude ===`);
  console.log(`Q: "${QUESTION}"  mode=${MODE}`);
  const t0 = Date.now();
  const resp = await Anth.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 12000,
    system: systemPrompt,
    tools,
    tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: QUESTION }],
  });
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s, ${resp.usage?.input_tokens || '?'} in / ${resp.usage?.output_tokens || '?'} out)`);

  // 6. Inspect the response — count web_search calls + extract the final tool use
  const content = resp.content || [];
  const searches = content.filter(b => b.type === 'server_tool_use' && b.name === 'web_search');
  console.log(`web_search calls: ${searches.length}`);
  searches.forEach((s, i) => {
    console.log(`  [${i + 1}] q=${JSON.stringify(s.input?.query || '')}`);
  });

  const toolUse = content.find(b => b.type === 'tool_use');
  if (!toolUse) {
    console.log('\nNo final tool call — Claude returned only text:');
    console.log(content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    process.exit(0);
  }

  if (toolUse.name === 'decline_question') {
    console.log('\nDECLINED:', toolUse.input?.reason);
    process.exit(0);
  }

  if (toolUse.name !== 'set_country_values') {
    console.log('\nUnexpected tool name:', toolUse.name);
    process.exit(1);
  }

  const raw = toolUse.input || {};
  const rawValues = Array.isArray(raw.values) ? raw.values : [];
  const seen = new Set();
  const droppedNaN = [], droppedUnknownIso = [], droppedDup = [];
  const kept = [];
  for (const v of rawValues) {
    const iso = String(v.iso || '').toUpperCase().trim();
    const num = Number(v.value);
    if (!iso) { droppedUnknownIso.push('(empty)'); continue; }
    if (!isoSet.has(iso)) { droppedUnknownIso.push(`${iso}=${v.value}`); continue; }
    if (!Number.isFinite(num)) { droppedNaN.push(`${iso}=${JSON.stringify(v.value)}`); continue; }
    if (seen.has(iso)) { droppedDup.push(iso); continue; }
    seen.add(iso);
    kept.push({ iso, value: num });
  }

  console.log(`\n=== Result ===`);
  console.log(`legend:      ${raw.legend}`);
  console.log(`unit:        ${raw.unit}`);
  console.log(`source_note: ${raw.source_note}`);
  console.log(`raw=${rawValues.length}  kept=${kept.length}  dropped_unknown_iso=${droppedUnknownIso.length}  dropped_nan=${droppedNaN.length}  dropped_dup=${droppedDup.length}`);
  if (droppedUnknownIso.length) console.log(`unknown ISOs: [${droppedUnknownIso.join(', ')}]`);
  if (droppedNaN.length)        console.log(`NaN values:   [${droppedNaN.join(', ')}]`);
  if (droppedDup.length)        console.log(`duplicates:   [${droppedDup.join(', ')}]`);

  // 7. Watch-list audit
  console.log(`\n=== Watch list ===`);
  const watchReport = WATCH.map(iso => {
    const inKept = kept.find(k => k.iso === iso);
    const inRaw  = rawValues.find(v => String(v.iso || '').toUpperCase() === iso);
    return { iso, inKept: !!inKept, value: inKept?.value, droppedReason: inRaw && !inKept ? 'whitelist-or-NaN' : null };
  });
  for (const w of watchReport) {
    if (w.inKept)              console.log(`  ${w.iso}: present (value=${w.value})`);
    else if (w.droppedReason)  console.log(`  ${w.iso}: emitted but dropped (${w.droppedReason})`);
    else                       console.log(`  ${w.iso}: *** OMITTED by Claude ***`);
  }

  // 7b. Fill-in pass (matches server.js logic). Only triggers for rank/binary
  // when the kept count is suspiciously low.
  const FILL_IN_THRESHOLDS = { rank: 50, binary: 15 };
  const fillInTarget = FILL_IN_THRESHOLDS[MODE];
  if (fillInTarget != null && kept.length > 0 && kept.length < fillInTarget) {
    console.log(`\n=== Fill-in pass (kept=${kept.length} < target=${fillInTarget}) ===`);
    const isoToName = new Map(countryRows.map(c => [c.iso_code.toUpperCase(), c.name]));
    const missing = countryRows
      .map(c => c.iso_code.toUpperCase())
      .filter(iso => !seen.has(iso));
    const existingSummary = kept
      .slice()
      .sort((a, b) => (MODE === 'rank' ? a.value - b.value : b.value - a.value))
      .map(v => `${v.iso} (${isoToName.get(v.iso) || v.iso})=${v.value}`)
      .join(', ');
    const lastRank = (MODE === 'rank') ? Math.max(...kept.map(v => v.value || 0)) : null;
    const fillInUserMsg = `Your previous answer to "${QUESTION}" (mode: ${MODE}) returned only ${kept.length} countries:

${existingSummary}

The world has 190+ sovereign countries. Your answer is incomplete. Walk through the following countries that were NOT in your previous answer, and identify which of them have a non-trivial value for the question. Use web_search if needed.

Missing from previous answer (${missing.length} countries):
${missing.map(iso => `${iso} ${isoToName.get(iso) || ''}`.trim()).join('\n')}

${MODE === 'rank'
  ? `Continue the rank sequence — your last rank was ${lastRank}, so new entries should be ranked starting at ${lastRank + 1}. DO NOT REPEAT countries already in the previous answer above.`
  : 'Include ONLY countries where the answer is 1 (yes / true). DO NOT REPEAT countries already in the previous answer above.'}

Call set_country_values with ONLY the additional countries.`;

    const t1 = Date.now();
    const fillInResp = await Anth.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8000,
      system: systemPrompt,
      tools,
      tool_choice: { type: 'tool', name: 'set_country_values' },
      messages: [{ role: 'user', content: fillInUserMsg }],
    });
    console.log(`(${((Date.now() - t1) / 1000).toFixed(1)}s, ${fillInResp.usage?.input_tokens || '?'} in / ${fillInResp.usage?.output_tokens || '?'} out)`);

    const fillInTool = (fillInResp.content || []).find(b => b.type === 'tool_use' && b.name === 'set_country_values');
    if (fillInTool) {
      const fillArr = Array.isArray(fillInTool.input?.values) ? fillInTool.input.values : [];
      let added = 0, isoRej = 0, nanRej = 0, dupRej = 0;
      const newAdds = [];
      for (const v of fillArr) {
        const iso = String(v.iso || '').toUpperCase().trim();
        const num = Number(v.value);
        if (!iso || !isoSet.has(iso)) { isoRej++; continue; }
        if (!Number.isFinite(num))    { nanRej++; continue; }
        if (seen.has(iso))            { dupRej++; continue; }
        seen.add(iso);
        kept.push({ iso, value: num });
        newAdds.push({ iso, value: num });
        added++;
      }
      console.log(`fill-in raw=${fillArr.length} added=${added} dup=${dupRej} bad_iso=${isoRej} nan=${nanRej} → total=${kept.length}`);
      if (newAdds.length) {
        const sample = newAdds.slice(0, 20).map(v => `${v.iso}=${v.value}`).join(', ');
        console.log(`first additions: ${sample}${newAdds.length > 20 ? ` ... +${newAdds.length - 20} more` : ''}`);
      }

      // Re-run watch list against the merged result
      console.log(`\n=== Watch list (after fill-in) ===`);
      for (const iso of WATCH) {
        const found = kept.find(k => k.iso === iso);
        if (found) console.log(`  ${iso}: present (value=${found.value})`);
        else       console.log(`  ${iso}: still OMITTED`);
      }
    } else {
      console.log('fill-in returned no tool call');
    }
  }

  // 8. If any watch-list country was OMITTED by Claude, ask Claude why.
  const omitted = watchReport.filter(w => !w.inKept && !w.droppedReason).map(w => w.iso);
  if (omitted.length) {
    console.log(`\n=== Asking Claude to explain ${omitted.length} omission(s) ===`);
    // Friendly names from the catalog so the explanation is human-readable
    const isoToName = new Map(countryRows.map(c => [c.iso_code.toUpperCase(), c.name]));
    const omittedNamed = omitted.map(iso => `${iso} ${isoToName.get(iso) || ''}`.trim());
    const explainPrompt = `Earlier you answered the question "${QUESTION}" (mode: ${MODE}) and emitted ${kept.length} country values via set_country_values. The following countries were NOT included in your answer:

${omittedNamed.join('\n')}

For EACH of these, explain in 1-3 sentences:
  • Was the omission intentional? (e.g. genuinely no data, you couldn't verify)
  • Or was it an oversight? (you should have included it)
  • If intentional, what would the value have been if you'd included it?

Be candid — this is a debugging exercise to improve recall on later queries. Reply as plain text, one country per paragraph, prefixed by the ISO code.`;
    const explainResp = await Anth.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      system: 'You are debugging a previous tool-using response. Answer plainly, no tools needed.',
      messages: [{ role: 'user', content: explainPrompt }],
    });
    const txt = (explainResp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    console.log(txt);
  }

  await pool.end();
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
