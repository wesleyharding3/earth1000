#!/usr/bin/env node
'use strict';
// Re-test "countries with a mountain over 10000 feet" with the new
// CHECKLIST prompt that's now in server.js.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const countryLines = fs.readFileSync('/tmp/earth00-countries.txt', 'utf8')
  .split('\n').filter(Boolean).map(l => {
    const [iso, name] = l.split('|');
    return { iso, name };
  });
const isoCatalog = countryLines.map(c => `${c.iso} ${c.name}`).join('\n');

const TOOLS = [
  {
    name: 'set_country_values',
    description: 'Paint the heatmap with per-country values.',
    input_schema: {
      type: 'object', required: ['legend', 'values'],
      properties: {
        legend: { type: 'string' }, unit: { type: 'string' }, source_note: { type: 'string' },
        values: { type: 'array', items: { type: 'object', required: ['iso','value'],
          properties: { iso: { type: 'string' }, value: { type: 'number' } } } }
      }
    }
  },
  { name: 'decline_question', description: 'Use when the question has no objective per-country mapping.',
    input_schema: { type: 'object', required: ['refusal'], properties: { refusal: { type: 'string' } } } }
];

const MODE_GUIDANCE = { binary: 'Each value is 0 or 1. Include only countries where the answer is 1.' };

function sysPrompt(mode) {
  return `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${mode}. ${MODE_GUIDANCE[mode]}
- Use the set_country_values tool when the question has a meaningful per-country answer.
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Numbers are estimates — include data vintage in source_note (year, source). When uncertain, say so explicitly in source_note.

ACCURACY CHECKLIST — apply before responding:

1. STATE THE CRITERION. Internally restate exactly what the question asks. If it includes a numeric threshold (e.g. "over 10,000 ft", "more than 50%"), treat it as strict. If it names a defined group (EU, NATO, OPEC, NPT signatories), use the canonical membership list.

2. ENUMERATE BY CONTINENT. Walk through every continent — Africa, Asia, Europe, Americas, Oceania — and consider each region's countries. For factual binary questions, the global answer set is usually 30–100 countries. Do NOT rely on only the most famous examples; that's the #1 failure mode.

3. VERIFY EACH CANDIDATE. For each country you'd include, briefly justify why it qualifies — name the specific peak, region, language family, treaty, or feature. If you can't name a specific qualifying reason, do not include the country.

4. EXCLUDE without specific evidence. Do not include a country because it "looks mountainous", "is in that region", or "feels like it should qualify". Specific evidence required.

5. NOTE THE LIMITS in source_note. If you're uncertain about edge cases, list them by name ("excludes borderline cases: X, Y") so the user knows. If your data has a vintage, cite it.

Most users will be wronger than you think when checking — but for the cases where they are right and you're missing obvious entries, your answer becomes useless. Aim for high recall on clear positives and strict exclusion of vague matches.`;
}

async function ask(model, system, question) {
  const t0 = Date.now();
  const res = await client.messages.create({
    model, max_tokens: 4096, system,
    messages: [{ role: 'user', content: question }],
    tools: TOOLS, tool_choice: { type: 'any' },
  });
  const ms = Date.now() - t0;
  const tool = res.content.find(b => b.type === 'tool_use');
  if (!tool || tool.name === 'decline_question') return { ms, declined: true, refusal: tool?.input?.refusal };
  return {
    ms,
    legend: tool.input.legend,
    source_note: tool.input.source_note,
    isos: [...new Set((tool.input.values || []).map(v => String(v.iso || '').toUpperCase()))].sort(),
  };
}

const QUESTIONS = [
  'Which countries have a mountain over 10000 feet (3048m)?',
  'Which countries border an ocean?',
  'Which countries are landlocked?',
  'Which countries have a Muslim-majority population?',
];

(async () => {
  for (const q of QUESTIONS) {
    console.log(`\n========================================`);
    console.log(`Q: ${q}`);
    console.log(`========================================`);
    const r = await ask('claude-sonnet-4-5-20250929', sysPrompt('binary'), q).catch(e => ({ error: e.message }));
    if (r.error) { console.log(`ERROR: ${r.error}`); continue; }
    if (r.declined) { console.log(`DECLINED: ${r.refusal}`); continue; }
    console.log(`legend: ${r.legend}`);
    console.log(`source_note: ${r.source_note || '(none)'}`);
    console.log(`countries (${r.isos.length}): ${r.isos.join(', ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
