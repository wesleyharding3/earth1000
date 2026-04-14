/**
 * auditJunkTimelines.js
 *
 * Three-pass audit that:
 *   1. PURGE  — remove generic "topic bucket" timelines that aren't real arcs
 *   2. MERGE  — deterministically collapse near-duplicate titles (synonym matching)
 *   3. SEED   — ensure critical geopolitical arcs exist (Gaza, West Bank, etc.)
 *
 * Usage:
 *   node auditJunkTimelines.js                — dry-run
 *   node auditJunkTimelines.js --apply        — actually modify the DB
 */

require("dotenv").config();
const pool = require("./db");

const APPLY = process.argv.includes("--apply");

// ═══════════════════════════════════════════════════════════════════════════════
//  PASS 1: Generic topic-bucket detection
// ═══════════════════════════════════════════════════════════════════════════════

// Words that are purely abstract category labels — not geopolitical signals
const ABSTRACT_NOUNS = new Set([
  "policy","policies","reform","reforms","development","developments",
  "transition","transitions","standards","framework","frameworks",
  "infrastructure","system","systems","strengthening","expansion",
  "protection","regulation","regulations","modernization","initiative",
  "initiatives","challenges","response","investment","investments",
  "governance","administration","sector","industry","production",
  "management","reduction","commitments","negotiations","connectivity",
  "security","innovation","transformation","cooperation","acceleration",
]);

// Compound adjectives that turn a real noun into a generic bucket
const GENERIC_PREFIXES = new Set([
  "global","regional","international","national","worldwide","transnational",
  "multilateral","cross-border","bilateral",
]);

// These full titles are known junk — mark for removal
const JUNK_TITLE_EXACT = new Set([
  "cultural heritage protection",
  "cybersecurity standards",
  "cost of living crisis",
  "global cost of living crisis",
  "global monetary policy",
  "renewable energy transition",
  "green energy transition",
  "global energy transition",
  "extreme weather response systems",
  "regional infrastructure development",
  "global health system strengthening",
  "natural disasters & climate impacts",
  "climate-related natural disasters",
  "global labor negotiations",
  "global labor strikes wave",
  "global economic slowdown",
  "global energy security",
  "renewable energy infrastructure expansion",
  "global food security",
  "extreme weather and natural disasters",
  "global agricultural production crisis",
  "carbon emissions reduction",
  "global hydrogen energy",
  "global data security breaches",
  "global semiconductor investment surge",
  "digital government transition",
  "faith-based ai technology",
  "ai in newsrooms and education",
  "cybersecurity data breaches",
  "ai infrastructure and power",
  "quantum computing development",
  "indo-pacific digital infrastructure",
  "african digital infrastructure",
  "global organized crime",
  "global protest movements",
  "global climate crisis",
  "space exploration",
  "media freedom & regulation",
  "sub-saharan african governance",
  "southern african economic stress",
  "east african rail connectivity",
  "papua new guinea climate commitments",
]);

// Regex patterns that detect generic topic buckets
const JUNK_PATTERNS = [
  /^global\s+\w+\s+(crisis|policy|security|transition|reform|system|investment)/i,
  /^regional\s+\w+\s+(development|cooperation|infrastructure)/i,
  /^\w+\s+energy\s+(transition|infrastructure|expansion|security)/i,
  /^(extreme|natural|climate)\s+\w+\s+(response|disaster|impact)/i,
  /^(cyber|digital|quantum)\s+\w+\s+(standard|breach|development|transition|infrastructure)/i,
  /^(african|indo-pacific|sub-saharan)\s+\w+\s+(infrastructure|governance|reform|stress)/i,
  /^(ai|artificial intelligence)\s+(in|for|and)\s+/i,
  /^global\s+(organized|protest|labor|data|semiconductor)/i,
];

// Concrete signals that RESCUE a title from being flagged as a bucket
const CONCRETE_RESCUE = /\b(war|conflict|invasion|blockade|siege|bombing|strike|ceasefire|genocide|coup|election|assassination|sanction|arrest|trial|negotiation|summit|treaty|indictment|attack|missile|nuclear|chemical|detention)\b/i;

// Country-specific concrete signals
const COUNTRY_RESCUE = /\b(gaza|ukraine|russia|iran|israel|china|taiwan|north korea|venezuela|syria|yemen|myanmar|sudan|ethiopia|libya|haiti|cuba|hungary|turkey|india|pakistan)\b/i;

function isGenericBucket(title) {
  const lower = title.toLowerCase().trim();

  // Exact match
  if (JUNK_TITLE_EXACT.has(lower)) return true;

  // Pattern match
  for (const pat of JUNK_PATTERNS) {
    if (pat.test(lower)) {
      // But rescue if it mentions a concrete conflict/event or a specific country
      if (CONCRETE_RESCUE.test(lower) || COUNTRY_RESCUE.test(lower)) return false;
      return true;
    }
  }

  // Heuristic: if title is 3+ words and >=60% are abstract/generic terms
  const words = lower.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  if (words.length >= 3) {
    const abstractCount = words.filter(w => ABSTRACT_NOUNS.has(w) || GENERIC_PREFIXES.has(w)).length;
    if (abstractCount / words.length >= 0.5) {
      if (!CONCRETE_RESCUE.test(lower) && !COUNTRY_RESCUE.test(lower)) return true;
    }
  }

  return false;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  PASS 2: Deterministic synonym-based dedup
// ═══════════════════════════════════════════════════════════════════════════════

// Synonym groups — words within a group are treated as identical
const SYNONYM_GROUPS = [
  ["negotiation","negotiations","talks","dialogue","discussions","diplomacy"],
  ["ceasefire","cease-fire","truce","armistice"],
  ["escalation","intensification","surge","buildup"],
  ["crisis","turmoil","upheaval","chaos","unrest"],
  ["war","conflict","combat","hostilities","warfare","military","armed"],
  ["transition","succession","changeover","handover"],
  ["realignment","reset","shift","pivot","recalibration","restructuring"],
  ["expansion","growth","development","buildup"],
  ["reform","reforms","overhaul"],
  ["collapse","meltdown","implosion","breakdown"],
];

// Title words to ignore during similarity comparison — too generic to help
const TITLE_STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","at","to","for","from","by",
  "with","its","s","direct","bilateral","face","new","ongoing","latest",
]);

// Build lookup: word → canonical (first word in group)
const SYNONYM_MAP = new Map();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0];
  for (const word of group) {
    SYNONYM_MAP.set(word.toLowerCase(), canonical);
  }
}

function canonicalize(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !TITLE_STOPWORDS.has(w))
    .map(w => SYNONYM_MAP.get(w) || w)
    .sort()
    .join(' ');
}

function titleSimilarity(a, b) {
  const wordsA = new Set(canonicalize(a).split(' '));
  const wordsB = new Set(canonicalize(b).split(' '));
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union ? overlap / union : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PASS 3: Critical arc seeding
// ═══════════════════════════════════════════════════════════════════════════════

const CRITICAL_ARCS = [
  {
    title: "Gaza Genocide & Israeli Occupation",
    scope: "gaza_genocide_occupation",
    description: "Ongoing Israeli military operations in Gaza causing mass civilian casualties, displacement of over 2 million Palestinians, destruction of hospitals, schools, and infrastructure, and the humanitarian catastrophe designated by international courts and organizations as constituting genocide. Includes settler violence and territorial expansion in the West Bank.",
    primary_category: "conflict",
    geographic_scope: "regional",
    importance: 10,
    keywords: ["gaza","palestine","israel","genocide","occupation","hamas","idf","rafah","khan younis","west bank","settler","displacement","humanitarian","international court of justice","ceasefire","blockade","famine","unrwa"],
    match_keywords: ["gaza","palestine","palestinian","west bank","settler","rafah","khan younis","jabalia","nuseirat","deir al-balah","idf","hamas","unrwa","nakba"],
  },
  {
    title: "West Bank Settler Violence & Annexation",
    scope: "west_bank_settler_violence",
    description: "Escalating Israeli settler attacks on Palestinian communities in the occupied West Bank, backed by military operations and de facto annexation policies. Includes demolitions, land seizures, checkpoint restrictions, and international sanctions against settler leaders.",
    primary_category: "conflict",
    geographic_scope: "regional",
    importance: 9,
    keywords: ["west bank","settler","palestine","israel","occupation","annexation","demolition","checkpoint","jenin","nablus","hebron","ramallah","tulkarm"],
    match_keywords: ["west bank","settler","settlement","annexation","jenin","nablus","hebron","tulkarm","occupation"],
  },
];


// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🔍 Timeline Audit — ${new Date().toISOString()}`);
  console.log(`   Mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // Load all active timelines
  const { rows: timelines } = await pool.query(`
    SELECT id, title, scope, description, primary_category, geographic_scope,
           importance, keywords, article_count, status
    FROM story_timelines
    WHERE status IN ('active','cooling')
    ORDER BY importance DESC, article_count DESC
  `);
  console.log(`   Loaded ${timelines.length} active/cooling timelines\n`);

  // ─── PASS 1: Purge generic buckets ──────────────────────────────────────────
  console.log(`═══ PASS 1: Generic Bucket Purge ═══`);
  const junkIds = [];
  for (const tl of timelines) {
    if (isGenericBucket(tl.title)) {
      console.log(`   🗑  [${tl.id}] "${tl.title}" (${tl.article_count} arts, imp:${tl.importance})`);
      junkIds.push(tl.id);
    }
  }
  console.log(`   → ${junkIds.length} generic bucket(s) to remove\n`);

  // ─── PASS 2: Synonym dedup ─────────────────────────────────────────────────
  console.log(`═══ PASS 2: Synonym Dedup ═══`);
  const remaining = timelines.filter(t => !junkIds.includes(t.id));
  const mergeGroups = [];
  const merged = new Set();

  for (let i = 0; i < remaining.length; i++) {
    if (merged.has(remaining[i].id)) continue;
    const group = [remaining[i]];

    for (let j = i + 1; j < remaining.length; j++) {
      if (merged.has(remaining[j].id)) continue;
      const sim = titleSimilarity(remaining[i].title, remaining[j].title);
      if (sim >= 0.55) {
        group.push(remaining[j]);
        merged.add(remaining[j].id);
      }
    }

    if (group.length > 1) {
      // Keep the one with most articles
      group.sort((a, b) => (b.article_count || 0) - (a.article_count || 0));
      const keeper = group[0];
      const losers = group.slice(1);
      merged.add(keeper.id); // mark keeper as used so it doesn't appear in another group
      mergeGroups.push({ keeper, losers });
    }
  }

  for (const g of mergeGroups) {
    console.log(`   ✓ KEEP  [${g.keeper.id}] "${g.keeper.title}" (${g.keeper.article_count} arts)`);
    for (const l of g.losers) {
      const sim = titleSimilarity(g.keeper.title, l.title);
      console.log(`     ⮕ merge [${l.id}] "${l.title}" (${l.article_count} arts, sim=${sim.toFixed(2)})`);
    }
  }
  console.log(`   → ${mergeGroups.length} merge group(s)\n`);

  // ─── PASS 3: Critical arc seeding ──────────────────────────────────────────
  console.log(`═══ PASS 3: Critical Arc Seeding ═══`);
  const existingTitles = new Set(remaining.map(t => t.title.toLowerCase()));
  const existingScopes = new Set(remaining.map(t => (t.scope || '').toLowerCase()));
  const arcsToSeed = [];

  for (const arc of CRITICAL_ARCS) {
    // Check if something similar already exists
    let found = false;
    for (const tl of remaining) {
      if (junkIds.includes(tl.id)) continue;
      const sim = titleSimilarity(arc.title, tl.title);
      if (sim >= 0.45 || existingScopes.has(arc.scope)) {
        found = true;
        console.log(`   ℹ  "${arc.title}" already covered by [${tl.id}] "${tl.title}" (sim=${sim.toFixed(2)})`);
        break;
      }
      // Also check keyword overlap
      const tlKws = new Set((tl.keywords || []).map(k => k.toLowerCase()));
      const arcMatchKws = arc.match_keywords || [];
      const kwOverlap = arcMatchKws.filter(k => tlKws.has(k)).length;
      if (kwOverlap >= 4) {
        found = true;
        console.log(`   ℹ  "${arc.title}" has ${kwOverlap} keyword matches with [${tl.id}] "${tl.title}"`);
        break;
      }
    }
    if (!found) {
      arcsToSeed.push(arc);
      console.log(`   🌱 SEED: "${arc.title}" (imp:${arc.importance})`);
    }
  }
  console.log(`   → ${arcsToSeed.length} arc(s) to seed\n`);

  // ─── APPLY ──────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log(`   (dry-run — pass --apply to execute)\n`);
    await pool.end();
    return;
  }

  console.log(`═══ Applying Changes ═══`);

  // 1. Purge junk (set status = 'dormant' and importance = 0 so they stop appearing)
  if (junkIds.length) {
    const { rowCount } = await pool.query(`
      UPDATE story_timelines
      SET status = 'dormant', importance = 0
      WHERE id = ANY($1::int[])
    `, [junkIds]);
    console.log(`   ✓ Marked ${rowCount} generic bucket(s) as dormant`);
  }

  // 2. Merge duplicates
  for (const g of mergeGroups) {
    const keepId = g.keeper.id;
    const loserIds = g.losers.map(l => l.id);

    try {
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");

        // Move articles from losers → keeper
        const { rows: moveCount } = await dbClient.query(`
          WITH moved AS (
            INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
            SELECT $1, article_id, parabolic_weight, relevance_score, is_anchor, added_at
            FROM story_timeline_articles
            WHERE timeline_id = ANY($2::int[])
            ON CONFLICT DO NOTHING
            RETURNING article_id
          )
          SELECT COUNT(*)::int AS n FROM moved
        `, [keepId, loserIds]);

        // Union keywords
        await dbClient.query(`
          UPDATE story_timelines kt
          SET keywords = ARRAY(
            SELECT DISTINCT unnest(
              COALESCE(kt.keywords, ARRAY[]::text[]) ||
              COALESCE((
                SELECT ARRAY_AGG(kw) FROM (
                  SELECT unnest(keywords) AS kw FROM story_timelines WHERE id = ANY($2::int[])
                ) sub
              ), ARRAY[]::text[])
            )
          )
          WHERE kt.id = $1
        `, [keepId, loserIds]);

        // Delete losers
        await dbClient.query(`DELETE FROM story_timeline_articles WHERE timeline_id = ANY($1::int[])`, [loserIds]);
        await dbClient.query(`DELETE FROM story_timelines WHERE id = ANY($1::int[])`, [loserIds]);

        // Recompute article count
        await dbClient.query(`
          UPDATE story_timelines SET
            article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
            last_updated_at = NOW()
          WHERE id = $1
        `, [keepId]);

        await dbClient.query("COMMIT");
        console.log(`   ✓ Merged ${loserIds.length} timeline(s) into [${keepId}] "${g.keeper.title}" (+${moveCount[0].n} arts)`);
      } catch (e) {
        await dbClient.query("ROLLBACK");
        console.error(`   ⚠ Merge into [${keepId}] failed: ${e.message}`);
      } finally {
        dbClient.release();
      }
    } catch (e) {
      console.error(`   ⚠ Connection error for merge [${keepId}]: ${e.message}`);
    }
  }

  // 3. Seed critical arcs
  for (const arc of arcsToSeed) {
    try {
      const { rows } = await pool.query(`
        INSERT INTO story_timelines
          (title, description, scope, primary_category, geographic_scope,
           importance, keywords, article_count, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'active')
        RETURNING id
      `, [
        arc.title, arc.description, arc.scope,
        arc.primary_category, arc.geographic_scope,
        arc.importance, arc.keywords
      ]);
      console.log(`   ✓ Seeded [${rows[0].id}] "${arc.title}" (imp:${arc.importance})`);

      // Now backfill articles matching the arc's keywords
      const kwPatterns = (arc.match_keywords || arc.keywords).slice(0, 15);
      const orClauses = kwPatterns.map((_, i) => `a.title ILIKE '%' || $${i + 2} || '%' OR (a.translated_title IS NOT NULL AND a.translated_title ILIKE '%' || $${i + 2} || '%')`);
      const { rows: articles } = await pool.query(`
        SELECT a.id, a.published_at
        FROM news_articles a
        WHERE (${orClauses.join(' OR ')})
          AND a.published_at > NOW() - INTERVAL '90 days'
        ORDER BY a.published_at DESC
        LIMIT 500
      `, [rows[0].id, ...kwPatterns]);

      if (articles.length) {
        const values = articles.map((a, i) =>
          `($1, $${i * 2 + 2}, $${i * 2 + 3}, 0.5, false, NOW())`
        );
        const params = [rows[0].id];
        for (const a of articles) {
          params.push(a.id);
          const ageH = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
          params.push(Math.max(0.1, 1 / (1 + Math.exp(0.012 * (ageH - 24)))).toFixed(5));
        }

        // Batch insert with simpler approach
        for (const a of articles) {
          const ageH = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
          const weight = Math.max(0.1, 1 / (1 + Math.exp(0.012 * (ageH - 24)))).toFixed(5);
          await pool.query(`
            INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
            VALUES ($1, $2, $3, 0.5, false, NOW())
            ON CONFLICT DO NOTHING
          `, [rows[0].id, a.id, weight]);
        }

        // Update article count
        await pool.query(`
          UPDATE story_timelines SET
            article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
            last_updated_at = NOW()
          WHERE id = $1
        `, [rows[0].id]);

        console.log(`     └─ backfilled ${articles.length} articles`);
      }
    } catch (e) {
      console.error(`   ⚠ Failed to seed "${arc.title}": ${e.message}`);
    }
  }

  console.log(`\n   ✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
