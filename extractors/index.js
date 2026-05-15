/**
 * extractors/index.js — registry + dispatch for the Map-This source
 * extractor toolchain.
 *
 * Each extractor module exports:
 *   - toolDef: object — Anthropic tool definition (name, description, input_schema)
 *   - run(spec, resolveName, env): function — server-side execution; returns
 *       { values: [{iso, value, ...}], source_note, row_count, error? }
 *
 * This module:
 *   - aggregates all toolDefs into a single array Claude sees
 *   - dispatches name → run() with the resolver + env
 *   - wraps results in a consistent shape for the heatmapResolver loop
 *
 * To add a new extractor:
 *   1. Drop a new file in extractors/ exporting { toolDef, run }
 *   2. Add a require + entry below
 *   3. That's it — heatmapResolver picks it up automatically.
 */

'use strict';

const wikipediaTable = require('./wikipediaTable');
const worldBankApi   = require('./worldBankApi');
const oecdApi        = require('./oecdApi');
const whoGhoApi      = require('./whoGhoApi');
const ciaFactbook    = require('./ciaFactbook');

// Order matters for the prompt — Claude reads tool descriptions in
// order. Put the broadest / fastest / most-reliable first.
const REGISTRY = [
  worldBankApi,    // clean JSON, fastest, broadest economic/demographic
  wikipediaTable,  // most coverage overall; broad fallback
  whoGhoApi,       // health-specific
  oecdApi,         // policy / education / OECD-only metrics
  ciaFactbook,     // canonical fallback for geography/government fields
];

function getToolDefs() {
  return REGISTRY.map(m => m.toolDef);
}

function getExtractorByName(name) {
  return REGISTRY.find(m => m.toolDef.name === name) || null;
}

/**
 * Execute an extractor by name. Returns a uniform { ok, payload, error }.
 * - ok=true with payload when extraction succeeded
 * - ok=false with error when something went wrong (network, parse, etc.)
 *
 * Callers should pass error back to Claude as the tool_result content
 * so Claude can retry with a different source.
 */
async function runExtractor(name, spec, resolveName, env = {}) {
  const ext = getExtractorByName(name);
  if (!ext) return { ok: false, error: `Unknown extractor: ${name}` };
  try {
    const result = await ext.run(spec, resolveName, env);
    if (result?.error) return { ok: false, error: result.error, partial: result };
    return { ok: true, payload: result };
  } catch (err) {
    return { ok: false, error: `Extractor ${name} threw: ${err.message}` };
  }
}

/**
 * Hint string injected into the system prompt — gives Claude the
 * routing guidance for when to pick each extractor. Generated from the
 * tool descriptions so adding a new extractor automatically extends
 * the routing doc.
 */
function buildRoutingGuide() {
  const lines = [
    'EXTRACTOR ROUTING — pick the right tool for the question type:',
    '',
  ];
  REGISTRY.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.toolDef.name}`);
    lines.push(`   ${m.toolDef.description.split('. ').slice(0, 2).join('. ')}.`);
    lines.push('');
  });
  lines.push(
    'Decision policy:',
    '- For quantitative country rankings (numeric, comparable across countries) you MUST call an extractor before calling set_country_values.',
    '- If the first extractor returns < 30 rows or returns error, retry with a different source or refine the spec.',
    '- If NO extractor matches the question (e.g. cultural opinion, hypothetical, no canonical source), call set_country_values with confidence_tier="estimate" and source_note explicitly noting "AI estimate — no authoritative source available".',
    '- NEVER fabricate values. If you cannot find a verified value for a country, omit it.',
  );
  return lines.join('\n');
}

module.exports = {
  REGISTRY,
  getToolDefs,
  getExtractorByName,
  runExtractor,
  buildRoutingGuide,
};
