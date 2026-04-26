#!/usr/bin/env node
'use strict';
// Quick simulation of /api/heatmap/ask using the EXACT prompt structure
// from server.js (lines 11168-11187). Tests Haiku 4.5 vs Sonnet 4.5
// on a battery of geographic questions to see which model recalls
// completely.

require('dotenv').config({ path: '/Users/wesleyharding3/Desktop/earth00/.env' });
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk').default;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load the same country list the production endpoint uses
const countryLines = fs.readFileSync('/tmp/earth00-countries.txt', 'utf8')
  .split('\n').filter(Boolean).map(l => {
    const [iso, name] = l.split('|');
    return { iso, name };
  });
const isoCatalog = countryLines.map(c => `${c.iso} ${c.name}`).join('\n');
const validIsos = new Set(countryLines.map(c => c.iso));

const SET_COUNTRY_VALUES_TOOL = {
  name: 'set_country_values',
  description: 'Paint the heatmap with per-country values.',
  input_schema: {
    type: 'object',
    required: ['legend', 'values'],
    properties: {
      legend: { type: 'string' },
      unit: { type: 'string' },
      source_note: { type: 'string' },
      values: {
        type: 'array',
        items: {
          type: 'object',
          required: ['iso', 'value'],
          properties: {
            iso: { type: 'string' },
            value: { type: 'number' }
          }
        }
      }
    }
  }
};

const DECLINE_TOOL = {
  name: 'decline_question',
  description: 'Use when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous.',
  input_schema: {
    type: 'object',
    required: ['refusal'],
    properties: { refusal: { type: 'string' } }
  }
};

const MODE_GUIDANCE = {
  binary: 'Each value is 0 or 1. Include only countries where the answer is 1.',
  percent: 'Each value is a percentage 0–100.',
  rank: 'Each value is an integer rank starting at 1.'
};

function buildSystem(mode) {
  return `You answer geographic questions for a globe-based news intelligence dashboard. Your output paints a heatmap.

Available countries (use ONLY these 2-letter ISO codes):
${isoCatalog}

Output rules:
- Mode: ${mode}. ${MODE_GUIDANCE[mode]}
- Use the set_country_values tool when the question has a meaningful per-country answer.
- Use the decline_question tool when the question is biased, value-loaded, has no objective per-country mapping, or asks for something dangerous. Be concise and neutral about the reason.
- Numbers are estimates — include data vintage in source_note (year, source). When uncertain, say so explicitly in source_note.
- Do not include countries you have no information about.`;
}

async function ask(model, question, mode = 'binary') {
  const t0 = Date.now();
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    system: buildSystem(mode),
    messages: [{ role: 'user', content: question }],
    tools: [SET_COUNTRY_VALUES_TOOL, DECLINE_TOOL],
    tool_choice: { type: 'any' },
  });
  const ms = Date.now() - t0;

  const toolCall = res.content.find(b => b.type === 'tool_use');
  if (!toolCall) return { model, ms, error: 'no tool call', raw: res.content };

  if (toolCall.name === 'decline_question') {
    return { model, ms, declined: true, refusal: toolCall.input.refusal };
  }

  const values = toolCall.input.values || [];
  const inWhitelist = values.filter(v => validIsos.has(String(v.iso || '').toUpperCase()));
  const dropped    = values.filter(v => !validIsos.has(String(v.iso || '').toUpperCase()));

  return {
    model,
    ms,
    legend: toolCall.input.legend,
    source_note: toolCall.input.source_note,
    countCalled: values.length,
    countValid: inWhitelist.length,
    countDropped: dropped.length,
    droppedIsos: dropped.map(d => d.iso),
    isos: inWhitelist.map(v => String(v.iso).toUpperCase()).sort(),
  };
}

const TESTS = [
  { q: 'Which countries have a desert in them?', mode: 'binary' },
  { q: 'Which countries border an ocean?', mode: 'binary' },
  { q: 'Which countries are landlocked?', mode: 'binary' },
  { q: 'Which countries have nuclear weapons?', mode: 'binary' },
  { q: 'Which countries are members of the European Union?', mode: 'binary' },
  { q: 'Which countries have a Muslim-majority population?', mode: 'binary' },
];

(async () => {
  for (const test of TESTS) {
    console.log('\n========================================');
    console.log(`Q: ${test.q}`);
    console.log('========================================');

    const [haiku, sonnet] = await Promise.all([
      ask('claude-haiku-4-5-20251001', test.q, test.mode).catch(e => ({ error: e.message })),
      ask('claude-sonnet-4-5-20250929', test.q, test.mode).catch(e => ({ error: e.message })),
    ]);

    for (const [label, r] of [['HAIKU 4.5', haiku], ['SONNET 4.5', sonnet]]) {
      console.log(`\n[${label}] ${r.ms}ms`);
      if (r.error)    { console.log(`  ERROR: ${r.error}`); continue; }
      if (r.declined) { console.log(`  DECLINED: ${r.refusal}`); continue; }
      console.log(`  legend: ${r.legend}`);
      console.log(`  source_note: ${r.source_note || '(none)'}`);
      console.log(`  countries returned: ${r.countCalled} (${r.countValid} valid, ${r.countDropped} dropped)`);
      if (r.countDropped > 0) console.log(`  dropped ISOs: ${r.droppedIsos.join(', ')}`);
      console.log(`  ISOs: ${r.isos.join(', ')}`);
    }

    // Diff: countries one returned but the other didn't
    if (haiku.isos && sonnet.isos) {
      const h = new Set(haiku.isos), s = new Set(sonnet.isos);
      const onlyHaiku  = haiku.isos.filter(x => !s.has(x));
      const onlySonnet = sonnet.isos.filter(x => !h.has(x));
      if (onlyHaiku.length || onlySonnet.length) {
        console.log(`\n  DIFF:`);
        if (onlyHaiku.length)  console.log(`    Only Haiku  (${onlyHaiku.length}):  ${onlyHaiku.join(', ')}`);
        if (onlySonnet.length) console.log(`    Only Sonnet (${onlySonnet.length}): ${onlySonnet.join(', ')}`);
      } else {
        console.log(`\n  DIFF: identical sets`);
      }
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
