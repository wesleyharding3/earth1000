#!/usr/bin/env node
/**
 * Create 20 curator-seeded manual Lines across military / economic /
 * diplomatic / regional buckets. For each seed:
 *
 *   1. Claude Haiku generates a Wikipedia-style title, short description,
 *      keywords, primary + secondary nations, and importance.
 *   2. POST /api/admin/timelines → creates the Line (is_manual = TRUE).
 *   3. POST /api/admin/timelines/:id/backfill-articles?days=180 → pulls
 *      the last six months of matching coverage.
 *   4. Prints a sanity-check row per Line showing attachment count.
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required for the title + description step
 *   API_BASE           — defaults to http://localhost:3999
 */
'use strict';

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set.'); process.exit(1);
}

const API_BASE       = process.env.API_BASE       || 'http://localhost:3999';
const BACKFILL_DAYS  = parseInt(process.env.BACKFILL_DAYS, 10) || 180;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Seed topics ────────────────────────────────────────────────────────
// Intentionally rough — Claude will refine names, descriptions, and pick
// keywords + nations. Keep seeds short; they're just prompts for Claude.
const SEEDS = [
  // MILITARY
  { bucket: 'military',   seed: 'Ecuador internal armed conflict — Noboa government crackdown on gangs and prison networks' },
  { bucket: 'military',   seed: 'Burkina Faso Islamist insurgency — JNIM and ISGS expansion in the Sahel' },
  { bucket: 'military',   seed: 'Myanmar civil war — NUG, ethnic armed organizations, and junta collapse' },
  { bucket: 'military',   seed: 'Mali Wagner entanglement and PMC transition after the Prigozhin fallout' },
  { bucket: 'military',   seed: 'Armenia-Azerbaijan post-Karabakh tensions and border disputes' },

  // ECONOMIC
  { bucket: 'economic',   seed: 'BRICS expansion and de-dollarization — common currency, payment systems, new members' },
  { bucket: 'economic',   seed: 'Mercosur-EU trade agreement — South American negotiations, France objections' },
  { bucket: 'economic',   seed: 'Petrodollar erosion and global central-bank gold accumulation' },
  { bucket: 'economic',   seed: 'Semiconductor decoupling — US export controls, China indigenous chip push, Taiwan' },
  { bucket: 'economic',   seed: 'Red Sea shipping disruption — Houthi attacks impact on global trade routes' },

  // DIPLOMATIC
  { bucket: 'diplomatic', seed: 'Saudi Arabia-Israel normalization — Abraham Accords expansion and regional integration' },
  { bucket: 'diplomatic', seed: 'Global South realignment — China Belt and Road, Russia outreach, multipolar world' },
  { bucket: 'diplomatic', seed: 'Iran nuclear deal revival — JCPOA talks, uranium enrichment, sanctions negotiations' },
  { bucket: 'diplomatic', seed: 'Arctic territorial and resource claims — Russia, Canada, Denmark, US militarization' },
  { bucket: 'diplomatic', seed: 'Vatican peace diplomacy — papal initiatives on Ukraine, Gaza, South Sudan' },

  // REGIONAL
  { bucket: 'regional',   seed: 'El Salvador under Bukele — megaprison state model and regional influence' },
  { bucket: 'regional',   seed: 'Germany CDU return — Friedrich Merz coalition, post-Scholz governance' },
  { bucket: 'regional',   seed: 'Indonesia Prabowo presidency — economic policy and ASEAN alignment' },
  { bucket: 'regional',   seed: 'Argentina Milei reforms — libertarian austerity, dollarization, labor protests' },
  { bucket: 'regional',   seed: 'Nigeria Sahel spillover — northern banditry, Boko Haram, ECOWAS tensions' },
];

// ─── Claude prompt ──────────────────────────────────────────────────────
async function generateLineDefinition(seed, bucket) {
  const prompt =
`You are helping curate a news-aggregation platform's "Lines" — umbrella
story topics that collect articles over time. Given the seed topic below,
produce a Line definition in JSON.

SEED TOPIC:
  bucket: ${bucket}
  description: ${seed}

Rules:
  - Title: Wikipedia article title style. Clear, factual, a dash of
    seasoning but NOT a breaking news headline. No colons, no em-dashes,
    no action verbs like "Faces" / "Seeks" / "Slams". 4–8 words typically.
    Examples of good titles:
       "2024 Ecuadorian security crisis"
       "Sahel jihadist insurgency"
       "Myanmar civil war (2021–present)"
       "Saudi Arabia-Israel normalization"
       "El Salvador gang crackdown"
  - Description: 2 sentences, encyclopedic tone. Frames what the Line
    COVERS, not a breaking-news angle.
  - Keywords: 8-14 comma-separated strings. Mix proper nouns (Maduro,
    Abiy Ahmed, Mercosur) + thematic terms (blackouts, austerity,
    de-dollarization) + place names (Khartoum, Ouagadougou). These are
    what articles will match against.
  - Primary nations: 1-3 ISO-2 codes of the countries this story is
    fundamentally about. Strict.
  - Secondary nations: 0-8 ISO-2 codes of supporting / affected /
    commenting countries.
  - Category: exactly one of: conflict, diplomacy, economy, politics,
    military, science, environment, climate, culture.
  - Importance: integer 1-10 reflecting global significance.

Return ONLY this JSON, no prose, no markdown fences:
{
  "title": "...",
  "description": "...",
  "keywords": ["...", "..."],
  "primary_nations": ["XX"],
  "secondary_nations": ["YY", "ZZ"],
  "category": "politics",
  "importance": 7
}`;

  const r = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = r.content?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude returned no JSON: ' + raw.slice(0, 200));
  return JSON.parse(match[0]);
}

// ─── API helpers ────────────────────────────────────────────────────────
async function createLine(def) {
  const r = await fetch(`${API_BASE}/api/admin/timelines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name:              def.title,
      description:       def.description,
      primary_category:  def.category,
      importance:        def.importance,
      keywords:          def.keywords,
      primary_nations:   def.primary_nations,
      secondary_nations: def.secondary_nations,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data.timeline;
}

async function backfillLine(id, days) {
  const r = await fetch(
    `${API_BASE}/api/admin/timelines/${id}/backfill-articles?days=${days}`,
    { method: 'POST' }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n┌─ Creating ${SEEDS.length} manual Lines via ${API_BASE}`);
  console.log(`│  backfill window: ${BACKFILL_DAYS} days per Line`);
  console.log(`└─\n`);

  const results = [];
  for (let i = 0; i < SEEDS.length; i++) {
    const { bucket, seed } = SEEDS[i];
    const n = `${String(i + 1).padStart(2, '0')}/${SEEDS.length}`;
    process.stdout.write(`[${n}] ${bucket.padEnd(10)} · thinking…   `);

    try {
      // 1. Claude generates the Line definition
      const def = await generateLineDefinition(seed, bucket);
      process.stdout.write(`\r[${n}] ${bucket.padEnd(10)} · "${def.title.slice(0, 50)}"\n`);

      // 2. Create via the API
      const created = await createLine(def);
      const id = created.id;
      process.stdout.write(`       ↳ created #${id}  p=[${def.primary_nations.join(',')}]  s=[${def.secondary_nations.join(',')}]\n`);

      // 3. Backfill
      const bf = await backfillLine(id, BACKFILL_DAYS);
      process.stdout.write(`       ↳ backfill: scanned ${bf.scanned}, qualified ${bf.qualified}, attached ${bf.attached}\n\n`);

      results.push({ ok: true, id, title: def.title, bucket, ...bf });

      // Light throttle to be kind to Claude rate limits
      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      process.stdout.write(`\n       ✗ ERROR: ${err.message}\n\n`);
      results.push({ ok: false, error: err.message, seed, bucket });
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║ SUMMARY                                                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  const okResults = results.filter(r => r.ok);
  const errors    = results.filter(r => !r.ok);
  console.log(`  ✓ created:  ${okResults.length}`);
  console.log(`  ✗ errors:   ${errors.length}`);
  if (okResults.length) {
    const totalAttached = okResults.reduce((s, r) => s + (r.attached || 0), 0);
    const withHits      = okResults.filter(r => (r.attached || 0) > 0).length;
    console.log(`  📎 total articles attached: ${totalAttached} across ${withHits} Lines`);
  }

  console.log('\nPer-Line attachment counts:');
  for (const r of okResults) {
    const flag = (r.attached || 0) === 0 ? ' ⚠' : '  ';
    console.log(`${flag} #${String(r.id).padEnd(4)}  [${r.bucket.padEnd(10)}]  attached ${String(r.attached || 0).padStart(3)}  ${r.title}`);
  }
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(`  ✗ [${e.bucket}] ${e.seed.slice(0, 60)} → ${e.error}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
