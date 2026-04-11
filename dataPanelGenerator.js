/**
 * dataPanelGenerator.js
 *
 * Generates data analytics panels (charts/graphs) for briefing segments and
 * story threads. Uses Claude Sonnet to choose the best data source + indicators
 * for each story, then fetches REAL data from the chosen adapter. Falls back
 * to a Claude-composed estimate (clearly flagged) if no adapter fits.
 *
 * Two CLI-facing helpers are exported for briefingGenerator's --pick mode:
 *   pickPanelsInteractive(segment, opts)  — present a Claude-proposed menu of
 *                                            chart options + a fully custom mode.
 *
 * Public API:
 *   generatePanelsForSegment(segment, threadCtx, { min, max, anthropic })
 *   generatePanelsForThread(thread,            { min, max, anthropic })
 *   savePanels(pool, panels, scope)            — persists to data_panels table
 *   loadPanels(pool, scope)                    — reads back, ordered
 *   pickPanelsInteractive(...)                 — readline UI
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const sources   = require('./dataSources');

const VALID_CHART_TYPES = ['line','bar','stacked_bar','area','pie','scatter'];

function makeClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ───────────────────────────────────────────────────────────────────────────
// Claude prompt: pick a source + query for one story
// ───────────────────────────────────────────────────────────────────────────
async function proposePanelsWithClaude(client, story, { count = 2, usedPanels = [] } = {}) {
  const catalog = sources.buildCatalogForPrompt();

  const usedBlock = usedPanels.length
    ? `\nALREADY USED IN THIS BRIEFING (DO NOT repeat these — pick a different adapter+indicator combination):\n${usedPanels.map(p => `- ${p.adapter}: ${p.title}`).join('\n')}\n`
    : '';

  const prompt = `You are a data journalist choosing analytics panels for a news briefing segment.

STORY:
${JSON.stringify({
  title:           story.title,
  voiceover:       story.voiceover,
  entities:        story.entities,
  primary_country: story.primary_country,
  deep_context:    story.deep_context,
}, null, 2)}

You may propose up to ${count} panels. Each panel must DEEPEN the story with real, sourced data — only propose a panel if the chart materially adds to the reader's understanding. It is acceptable to return fewer panels (or zero) if no chart genuinely helps.
${usedBlock}
DATA SOURCES AVAILABLE (each with a curated indicator catalog you must pick from):
${JSON.stringify(catalog, null, 2)}

Choose the adapter, indicator, and query parameters that best illuminate the story.

Return ONLY valid JSON in this exact shape (no prose):
{
  "panels": [
    {
      "title":      "Short chart title (max 60 chars)",
      "subtitle":   "Optional 1-line context",
      "caption":    "1-2 sentence explanation tying the chart to the story",
      "chart_type": "line|bar|stacked_bar|area|pie|scatter",
      "adapter":    "worldbank|owid|eia|fred|comtrade|acled|gdelt|usgs|noaa",
      "query": {
        // Adapter-specific parameters drawn from the indicator catalog above.
        // For worldbank:  { indicator: '<id>', countries: ['Iran','Saudi Arabia',...], years: [2015..2024] }
        // For owid:       { indicator: '<slug>', countries: ['Mexico'], year_min: 2010 }
        // For eia:        { indicator: '<series>', limit: 24 }
        // For fred:       { indicator: '<series>', limit: 60 }
        // For comtrade:   { indicator: '<hsCode>', reporter: 'Iran', partner: 'China', flow: 'X', years: [2019..2024] }
        // For acled:      { indicator: 'all', country: 'Mexico', months: 18 }
        // For gdelt:      { indicator: 'volume', query: 'Strait of Hormuz', span: '6months' }
        // For usgs:       { indicator: 'sig-30d' }
        // For noaa:       { indicator: 'temp-anomaly-land-ocean', year_min: 1980 }
      }
    }
  ]
}

RULES:
- The chart_type must match the data: line/area for time series, bar for category comparisons, stacked_bar for breakdowns, pie for share-of-total, scatter for correlations.
- Only propose adapters in the available list above. NEVER invent indicators.
- Country names must be standard English atlas names (Iran, Saudi Arabia, United States, etc).
- Be concise: titles <60 chars, captions <240 chars.
- Do NOT propose the same adapter+indicator combination that has already been used in this briefing.
- If the story is genuinely not chart-friendly (pure human-interest, single-event spot news), return { "panels": [] }.`;

  const resp = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 1500,
    messages:   [{ role: 'user', content: prompt }],
  });
  const text  = resp.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    let panels = Array.isArray(parsed.panels) ? parsed.panels : [];
    // Hard dedup: reject proposals that match already-used adapter+indicator
    if (usedPanels.length) {
      const usedKeys = new Set(usedPanels.map(p => `${p.adapter}:${p.indicator || ''}`));
      panels = panels.filter(p => !usedKeys.has(`${p.adapter}:${p.query?.indicator || ''}`));
    }
    return panels;
  } catch (_) { return []; }
}

// ───────────────────────────────────────────────────────────────────────────
// Claude composed-fallback: invent a small dataset when no adapter fits.
// Always tagged generated_by='ai_composed' so the frontend can mark it.
// ───────────────────────────────────────────────────────────────────────────
async function composeFallbackPanel(client, story) {
  const prompt = `You are a data journalist. The story below has no obvious matching public dataset, but a small illustrative chart would still help readers. Compose ONE chart from your training-data knowledge. Be honest about uncertainty.

STORY:
${JSON.stringify({
  title:     story.title,
  voiceover: story.voiceover,
  entities:  story.entities,
}, null, 2)}

Return ONLY valid JSON:
{
  "title": "...", "subtitle": "...", "caption": "Explain what this shows + WHERE the figures come from",
  "chart_type": "line|bar|stacked_bar|area|pie|scatter",
  "data": {
    "labels": ["..."],
    "series": [{ "name": "...", "values": [1,2,3] }],
    "unit":   "..."
  },
  "source_name": "Approximate source label (e.g. 'IEA estimates, training data')",
  "source_url":  null
}`;
  const resp = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });
  const m = resp.content[0].text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!VALID_CHART_TYPES.includes(obj.chart_type)) obj.chart_type = 'bar';
    return obj;
  } catch (_) { return null; }
}

// ───────────────────────────────────────────────────────────────────────────
// Validate + materialize one Claude proposal into a saveable panel object.
// On adapter failure, optionally fall back to composed mode.
// ───────────────────────────────────────────────────────────────────────────
async function materializePanel(client, proposal, story, { allowFallback = true } = {}) {
  const adapter = sources.getAdapter(proposal.adapter);
  if (adapter) {
    try {
      const data = await adapter.fetch(proposal.query || {});
      if (data && Array.isArray(data.series) && data.series.length) {
        return {
          title:        String(proposal.title || '').slice(0, 120),
          subtitle:     proposal.subtitle ? String(proposal.subtitle).slice(0, 200) : null,
          caption:      proposal.caption  ? String(proposal.caption).slice(0, 400)  : null,
          chart_type:   VALID_CHART_TYPES.includes(proposal.chart_type) ? proposal.chart_type : 'line',
          data:         data,
          source_name:  adapter.label,
          source_url:   data.source_url || null,
          generated_by: 'ai_real',
          adapter:      adapter.name,
          query:        proposal.query || {},
        };
      }
    } catch (err) {
      console.warn(`   ⚠ adapter ${adapter.name} failed: ${err.message}`);
    }
  }
  if (!allowFallback) return null;
  // Fallback — Claude composes
  const composed = await composeFallbackPanel(client, story).catch(() => null);
  if (!composed) return null;
  return {
    title:        composed.title || proposal.title || 'Context',
    subtitle:     composed.subtitle || null,
    caption:      composed.caption || proposal.caption || null,
    chart_type:   composed.chart_type || 'bar',
    data:         composed.data || {},
    source_name:  composed.source_name || 'AI estimate',
    source_url:   composed.source_url || null,
    generated_by: 'ai_composed',
    adapter:      null,
    query:        proposal.query || null,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public: generate N panels for a briefing segment
// ───────────────────────────────────────────────────────────────────────────
async function generatePanelsForSegment(segment, threadCtx, opts = {}) {
  const { min = 0, max = 2, anthropic, usedPanels = [] } = opts;
  const client  = anthropic || makeClient();
  const story   = {
    title:           threadCtx?.title || segment.thread_title,
    voiceover:       segment.voiceover_text || segment.voiceover,
    entities:        segment.entities || [],
    primary_country: segment.primary_country,
    deep_context:    threadCtx?.deepContext,
  };

  const proposals = await proposePanelsWithClaude(client, story, { count: max, usedPanels }).catch(e => {
    console.warn(`   ⚠ panel proposal failed: ${e.message}`);
    return [];
  });

  const panels = [];
  for (const p of proposals.slice(0, max)) {
    const panel = await materializePanel(client, p, story, { allowFallback: panels.length < min });
    if (panel) panels.push(panel);
    if (panels.length >= max) break;
  }
  return panels;
}

// ───────────────────────────────────────────────────────────────────────────
// Public: generate panels for an entire story thread (lazy on first view)
// ───────────────────────────────────────────────────────────────────────────
async function generatePanelsForThread(thread, opts = {}) {
  const { min = 2, max = 5, anthropic } = opts;
  const client = anthropic || makeClient();
  const story = {
    title:    thread.title,
    voiceover: (thread.articles || []).slice(0, 4).map(a => a.translated_title || a.title).join(' • '),
    entities:  [],
    deep_context: thread.deepContext,
  };
  const proposals = await proposePanelsWithClaude(client, story, { count: max }).catch(e => {
    console.warn(`   ⚠ thread panel proposal failed: ${e.message}`);
    return [];
  });
  const panels = [];
  for (const p of proposals.slice(0, max)) {
    const panel = await materializePanel(client, p, story, { allowFallback: panels.length < min });
    if (panel) panels.push(panel);
    if (panels.length >= max) break;
  }
  return panels;
}

// ───────────────────────────────────────────────────────────────────────────
// Persistence
// ───────────────────────────────────────────────────────────────────────────
async function savePanels(pool, panels, scope) {
  // scope: { type: 'briefing_segment'|'thread', id, segmentIndex? }
  if (!panels || !panels.length) return;
  if (scope.type === 'briefing_segment') {
    await pool.query(
      `DELETE FROM data_panels WHERE scope_type='briefing_segment' AND scope_id=$1 AND segment_index=$2`,
      [scope.id, scope.segmentIndex]
    );
  } else if (scope.type === 'thread') {
    await pool.query(
      `DELETE FROM data_panels WHERE scope_type='thread' AND scope_id=$1`,
      [scope.id]
    );
  }
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    await pool.query(`
      INSERT INTO data_panels
        (scope_type, scope_id, segment_index, ord, title, subtitle, caption,
         chart_type, data, source_name, source_url, generated_by, adapter, query)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb)
    `, [
      scope.type, scope.id, scope.segmentIndex ?? null, i,
      p.title, p.subtitle || null, p.caption || null,
      p.chart_type, JSON.stringify(p.data || {}),
      p.source_name || null, p.source_url || null,
      p.generated_by || 'ai_real',
      p.adapter || null,
      JSON.stringify(p.query || {}),
    ]);
  }
}

async function loadPanels(pool, scope) {
  if (scope.type === 'briefing_segment') {
    const { rows } = await pool.query(
      `SELECT * FROM data_panels
       WHERE scope_type='briefing_segment' AND scope_id=$1
       ORDER BY segment_index, ord`,
      [scope.id]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT * FROM data_panels
     WHERE scope_type='thread' AND scope_id=$1
     ORDER BY ord`,
    [scope.id]
  );
  return rows;
}

// ───────────────────────────────────────────────────────────────────────────
// Interactive picker — used by briefingGenerator --force --pick.
//
// Two modes per story:
//   1. PRESET   — Claude proposes a menu of N panel options; user picks which to keep
//   2. CUSTOM   — fully manual entry: chart type, title, labels, series values, source
//
// `rl` is a shared readline interface owned by the caller (briefingGenerator).
// ───────────────────────────────────────────────────────────────────────────
async function pickPanelsInteractive(segment, threadCtx, opts) {
  const { rl, anthropic, max = 5, usedPanels = [] } = opts;
  const client = anthropic || makeClient();
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  const accepted = [];

  function printPanelSummary(p, idx) {
    console.log(`\n  ─ Panel ${idx} ─`);
    console.log(`    title       : ${p.title}`);
    if (p.subtitle) console.log(`    subtitle    : ${p.subtitle}`);
    console.log(`    chart_type  : ${p.chart_type}`);
    console.log(`    source      : ${p.source_name || '(none)'} ${p.generated_by === 'ai_composed' ? '⚠ ESTIMATE' : ''}`);
    if (p.data?.labels) console.log(`    labels (${p.data.labels.length}): ${p.data.labels.slice(0, 8).join(', ')}${p.data.labels.length > 8 ? '…' : ''}`);
    if (p.data?.series) {
      p.data.series.slice(0, 3).forEach(s => {
        const vs = (s.values || []).slice(0, 6).map(v => v == null ? '–' : Number(v).toPrecision(3)).join(', ');
        console.log(`    series      : ${s.name} → [${vs}${s.values?.length > 6 ? '…' : ''}]`);
      });
    }
    if (p.caption) console.log(`    caption     : ${p.caption}`);
  }

  console.log('\n  ╭─ DATA PANELS ───────────────────────────────────╮');
  console.log(`  │  Story: ${(segment.thread_title || '').slice(0, 46).padEnd(46)} │`);
  console.log('  ├─────────────────────────────────────────────────┤');
  console.log('  │  p — preset menu (Claude proposes N options)    │');
  console.log('  │  c — custom panel (manual entry)                │');
  console.log('  │  s — skip; no panels for this story             │');
  console.log('  │  done — finish editing (keep accepted panels)   │');
  console.log('  ╰─────────────────────────────────────────────────╯');

  while (accepted.length < max) {
    const cmd = (await ask(`  panels[${accepted.length}/${max}]> `)).trim().toLowerCase();
    if (!cmd) continue;
    if (cmd === 'done' || cmd === 's' || cmd === 'skip') break;

    if (cmd === 'p' || cmd === 'preset') {
      const story = {
        title:           threadCtx?.title || segment.thread_title,
        voiceover:       segment.voiceover_text,
        entities:        segment.entities,
        primary_country: segment.primary_country,
        deep_context:    threadCtx?.deepContext,
      };
      console.log('  …asking Claude to propose options…');
      const proposals = await proposePanelsWithClaude(client, story, { count: 4, usedPanels }).catch(() => []);
      if (!proposals.length) { console.log('  ✗ Claude returned no proposals'); continue; }

      // Materialise all proposals first so the menu shows real data
      const materialised = [];
      for (const p of proposals) {
        const mp = await materializePanel(client, p, story, { allowFallback: false });
        if (mp) materialised.push(mp);
      }
      if (!materialised.length) { console.log('  ✗ All adapter fetches failed'); continue; }

      console.log('\n  CLAUDE PROPOSALS:');
      materialised.forEach((p, i) => printPanelSummary(p, i + 1));

      const sel = (await ask('\n  Pick numbers to keep (comma-separated, blank to cancel): ')).trim();
      if (!sel) continue;
      const idxs = sel.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0 && n < materialised.length);
      for (const idx of idxs) {
        if (accepted.length >= max) break;
        accepted.push(materialised[idx]);
        console.log(`  ✓ Added: ${materialised[idx].title}`);
      }

    } else if (cmd === 'c' || cmd === 'custom') {
      console.log('\n  CUSTOM PANEL — fill in fields. Blank to skip optional fields.');
      const title = (await ask('  title: ')).trim();
      if (!title) { console.log('  ✗ title required'); continue; }
      const subtitle = (await ask('  subtitle: ')).trim() || null;
      const caption  = (await ask('  caption: ')).trim() || null;
      let chart_type = (await ask(`  chart_type (${VALID_CHART_TYPES.join('|')}): `)).trim().toLowerCase();
      if (!VALID_CHART_TYPES.includes(chart_type)) chart_type = 'bar';
      const labelsRaw = (await ask('  labels (comma-separated, e.g. 2019,2020,2021,2022,2023): ')).trim();
      const labels = labelsRaw.split(',').map(s => s.trim()).filter(Boolean);

      const series = [];
      while (true) {
        const sname = (await ask(`  series[${series.length}] name (blank to finish): `)).trim();
        if (!sname) break;
        const valsRaw = (await ask(`  series[${series.length}] values (comma-separated, ${labels.length} expected): `)).trim();
        const values = valsRaw.split(',').map(s => s.trim() === '' ? null : parseFloat(s));
        series.push({ name: sname, values });
      }
      if (!series.length) { console.log('  ✗ at least 1 series required'); continue; }

      const unit       = (await ask('  unit (e.g. "barrels/day", "%", blank to skip): ')).trim() || null;
      const sourceName = (await ask('  source_name (e.g. "World Bank", "Manual"): ')).trim() || 'Manual';
      const sourceUrl  = (await ask('  source_url (blank ok): ')).trim() || null;

      const panel = {
        title, subtitle, caption, chart_type,
        data: { labels, series, unit },
        source_name: sourceName,
        source_url:  sourceUrl,
        generated_by: 'manual',
        adapter: null, query: null,
      };
      printPanelSummary(panel, accepted.length + 1);
      const ok = (await ask('  keep? [Y/n]: ')).trim().toLowerCase();
      if (ok !== 'n' && ok !== 'no') {
        accepted.push(panel);
        console.log(`  ✓ Added custom panel: ${title}`);
      }

    } else {
      console.log('  Commands: p (preset)  c (custom)  s (skip)  done');
    }
  }

  console.log(`\n  ✓ ${accepted.length} panel(s) accepted for "${segment.thread_title || 'segment'}"\n`);
  return accepted;
}

module.exports = {
  generatePanelsForSegment,
  generatePanelsForThread,
  savePanels,
  loadPanels,
  pickPanelsInteractive,
  VALID_CHART_TYPES,
};
