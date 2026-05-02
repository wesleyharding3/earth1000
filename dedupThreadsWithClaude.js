/**
 * dedupThreadsWithClaude.js
 *
 * Semantic duplicate pass over story_threads. The structural dedup in
 * storyThreadBuilder.js (title jaccard / containment / nation overlap)
 * catches paraphrased rewrites where tokens align. It misses cases where
 * same-story threads use different vocabulary — e.g. "Trump Claims Hormuz
 * Control" vs "Maritime Escalation Intensifies as Iran Breaks US Blockade"
 * (both the Iran-US Hormuz conflict, but title tokens barely overlap).
 *
 * This pass:
 *   1. Pulls every active/cooling thread (>= N articles).
 *   2. Clusters threads by shared primary_category + shared primary_nation
 *      (loose — any nation overlap counts).
 *   3. Sends each cluster to Claude with titles + descriptions + keywords
 *      and asks which threads cover the SAME breaking story and should merge.
 *   4. Applies merges by reusing storyThreadBuilder.dedupSimilarThreads'
 *      merge logic (article reassignment, keyword union, loser → dormant).
 *
 * By default dry-run. Pass --apply to execute merges.
 *
 * Usage:
 *   node dedupThreadsWithClaude.js                    # dry-run
 *   node dedupThreadsWithClaude.js --apply            # execute merges
 *   node dedupThreadsWithClaude.js --max-clusters=40  # cost cap
 *   node dedupThreadsWithClaude.js --min-cluster=2    # skip single-thread clusters
 */

// Cap this script's share of Postgres connections BEFORE db.js loads. Runs
// concurrently with web + worker + storyThreadBuilder; without this cap it
// would default to DB_POOL_MAX=60. The dedup loop is mostly Anthropic-bound
// with small DB queries between API calls, so 3 is plenty.
process.env.DB_POOL_MAX = "3";

// override:true — see auditThreadArticles.js for the reason.
require("dotenv").config({ override: true });
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { computeNationsFromArticles, PRIMARY_CAP, SECONDARY_CAP } = require("./nationDesignations");

// Inline (intentionally — avoids a circular require with storyThreadBuilder
// once it imports THIS module for in-cron dedup). Mirrors the canonical
// implementation's behavior: case-fix, UK→GB, drop malformed entries.
function sanitizeIsos(input) {
  if (!Array.isArray(input)) return [];
  const out = [], seen = new Set();
  for (const raw of input) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!/^[A-Za-z]{2}$/.test(s)) continue;
    let code = s.toUpperCase();
    if (code === 'UK') code = 'GB';
    if (seen.has(code)) continue;
    seen.add(code); out.push(code);
  }
  return out;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY        = !!ARGV.get('apply');
// Default model is Sonnet — semantic "same breaking story?" calls under a
// strict no-merge bar require calibrated judgment that Haiku consistently
// gets wrong (either over-merges different-but-related stories, or fails to
// merge clear paraphrases because the vocabulary differs). Sonnet is the
// right default for this prompt; Haiku is still selectable via --model
// for cost-sensitive bulk runs.
const MODEL        = ARGV.get('model') || process.env.CLAUDE_DEDUP_MODEL || 'claude-sonnet-4-5';
const MAX_CLUSTERS = parseInt(ARGV.get('max-clusters') || '40', 10);
const MIN_CLUSTER  = parseInt(ARGV.get('min-cluster') || '2', 10);
const MIN_ARTICLES = parseInt(ARGV.get('min-articles') || '2', 10);
// --only=ID1,ID2 limits --apply to merges whose LOSER id is in this set.
// Lets you dry-run, review Claude's proposed merges, then cherry-pick the
// good ones by listing loser ids. Without --only, --apply executes all
// proposed merges.
const ONLY = ARGV.get('only')
  ? new Set(String(ARGV.get('only')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean))
  : null;
// --exclude=ID1,ID2 does the inverse — blocks specific loser ids from
// being merged. Useful when you want "everything Claude proposed except
// these three obviously wrong ones."
const EXCLUDE = ARGV.get('exclude')
  ? new Set(String(ARGV.get('exclude')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean))
  : null;

async function main() {
  const t0 = Date.now();
  const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n🪢 Claude Thread Dedup — ${new Date().toISOString()}`);
  console.log(`   mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'} | model: ${MODEL} | max_clusters=${MAX_CLUSTERS}\n`);

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, keywords, primary_category,
           primary_nations, secondary_nations, importance,
           article_count, last_updated_at
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= $1
     ORDER BY primary_category, importance DESC, article_count DESC
  `, [MIN_ARTICLES]);
  console.log(`   [${el()}] Loaded ${threads.length} threads`);

  // Cluster by nation overlap + keyword / title-token overlap (NOT by
  // primary_category — that gate hid the marathon-world-record story
  // splitting across technology / politics / environment).
  const rawClusters = buildClusters(threads);
  // Slice oversized clusters so Sonnet's context stays manageable.
  const clusters = rawClusters.flatMap(c => splitOversizedCluster(c, 25));
  const ranked = clusters
    .filter(c => c.length >= MIN_CLUSTER)
    .sort((a, b) => b.length - a.length);
  console.log(`   [${el()}] Built ${ranked.length} candidate clusters (>= ${MIN_CLUSTER} threads each, ${rawClusters.length} raw → ${clusters.length} after size split)`);

  let mergeGroups = 0;
  let mergedRows  = 0;
  let claudeCalls = 0;

  for (let i = 0; i < ranked.length && claudeCalls < MAX_CLUSTERS; i++) {
    const cluster = ranked[i];
    claudeCalls++;
    const cat = cluster[0].primary_category || 'uncategorized';
    const nations = new Set(cluster.flatMap(t =>
      sanitizeIsos([...(t.primary_nations || []), ...(t.secondary_nations || [])])));
    process.stdout.write(`   [${el()}] Cluster ${i + 1}/${ranked.length} cat=${cat} nations=[${[...nations].slice(0, 6).join(',')}] threads=${cluster.length} → Claude... `);

    let groups;
    try {
      groups = await askClaude(cluster);
    } catch (err) {
      console.log(`✗ ${err.message}`);
      continue;
    }
    if (!groups.length) { console.log(`— no merges`); continue; }
    console.log(`${groups.length} merge group(s)`);

    for (const g of groups) {
      const winnerId = g.winner_id;
      const loserIds = (g.loser_ids || []).filter(id => id !== winnerId);
      if (!loserIds.length) continue;
      const winner = cluster.find(t => t.id === winnerId);
      if (!winner) continue;
      mergeGroups++;

      for (const loserId of loserIds) {
        const loser = cluster.find(t => t.id === loserId);
        if (!loser) continue;
        // ONLY / EXCLUDE cherry-pick filtering when applying.
        const skipped = APPLY && (
          (ONLY && !ONLY.has(loserId)) ||
          (EXCLUDE && EXCLUDE.has(loserId))
        );
        const prefix = skipped ? '⏭ skipped' : '✂';
        console.log(`      ${prefix}  ${loserId} "${(loser.title || '').slice(0,60)}" → ${winnerId} "${(winner.title || '').slice(0,60)}"`);
        if (APPLY && !skipped) {
          await mergeThread(winner, loser);
          mergedRows++;
        }
      }
    }
  }

  console.log(`\n${APPLY ? '✅ Applied' : '✅ Dry run'} — ${claudeCalls} Claude calls, ${mergeGroups} merge groups proposed${APPLY ? `, ${mergedRows} threads merged into winners` : ''}.`);
  await pool.end();
}

// ─── Clustering ─────────────────────────────────────────────────────────────
// Cluster threads that *might* be duplicates so Sonnet has them side-by-side.
//
// PRIOR BUG: clustering was gated on primary_category. The article scorer's
// category assignment is genuinely noisy — the "Kenya marathon world record"
// story spawned FOUR separate threads classified as `technology`, `politics`,
// `environment`, and `technology` again. Different categories meant the
// dedup pass never even compared them.
//
// CURRENT RULE: a pair shares a cluster edge when
//   (a) they overlap on at least one primary nation, AND
//   (b) they share at least 2 specific keywords  OR  3 distinctive title tokens.
//
// Connected components form clusters. The keyword/token requirement keeps
// large nations (US, UK, Iran) from collapsing every thread that mentions
// them into one giant cluster, while still surfacing same-event threads
// across mismatched categories.
//
// BIG-STORY EXCEPTION: when BOTH threads in a pair are part of a big
// breaking story (importance ≥ 8 OR article_count ≥ 50), the threshold
// drops to 1 keyword OR 2 title tokens, AND keyword matching switches
// from exact to substring (so "sanctions" hits "sanctions escalation").
// Reason: big-story threads share so many surface words that the 2/3
// thresholds + the "iran"/"war" stopwords combined to leave nearly
// nothing to match on. Multiple Iran-Hormuz threads were being missed
// — same story, different paraphrase, never clustered, never merged.
function buildClusters(threads) {
  const parent = new Map(threads.map(t => [t.id, t.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Common English stop-words to ignore when computing overlap. The list
  // used to also include topical words like "iran" and "war" — that turned
  // out to backfire: nation overlap is already a hard prerequisite, so
  // "iran" appearing in titles is a *useful* confirmatory signal, not
  // noise. Pruned + de-duplicated. If a topical word ever DOES start
  // collapsing unrelated threads, add it back here rather than gating on
  // primary_category (which has its own noise problems — see Kenya
  // marathon bug above).
  const STOPWORDS = new Set([
    // Function words / connectors
    'the','and','for','with','from','into','that','this','these','those',
    'about','over','after','before','amid','near','part','while','vs','versus',
    // Pronouns / aux verbs that survived the length>=4 filter
    'said','says','will','have','been','their','its','his','her','our',
    // News-headline filler that almost never carries topic signal
    'news','world','update','breaking','latest','daily',
  ]);
  const tokens = (s) =>
    new Set(String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t)));
  const kwSet = (t) => {
    const s = new Set();
    for (const k of (t.keywords || [])) {
      const v = String(k || '').trim().toLowerCase();
      if (!v || STOPWORDS.has(v)) continue;
      s.add(v);
    }
    return s;
  };

  // Treat a thread as part of a "big breaking story" if importance is
  // top-tier or it's already absorbed a substantial article volume. Big-
  // story pairs get a lower clustering bar — see comment block above.
  const isBigStory = t => (t.importance || 0) >= 8 || (t.article_count || 0) >= 50;

  // Pre-compute features once per thread.
  const feats = new Map();
  for (const t of threads) {
    feats.set(t.id, {
      isos:   new Set(sanitizeIsos(t.primary_nations || [])),
      kws:    kwSet(t),
      titleT: tokens(t.title),
      big:    isBigStory(t),
    });
  }

  // Substring-match version of keyword overlap. "sanctions" matches
  // "sanctions escalation"; "Strait of Hormuz" matches "Hormuz blockade"
  // (via the shorter substring). Length floor 5 prevents short common
  // fragments like "the", "for" from over-matching.
  function kwOverlapSubstring(setA, setB) {
    let count = 0;
    for (const ka of setA) {
      for (const kb of setB) {
        if (ka === kb) { count++; break; }
        if (ka.length >= 5 && kb.length >= 5 && (ka.includes(kb) || kb.includes(ka))) {
          count++; break;
        }
      }
    }
    return count;
  }

  for (let i = 0; i < threads.length; i++) {
    const a = threads[i];
    const fa = feats.get(a.id);
    if (!fa.isos.size) continue;
    for (let j = i + 1; j < threads.length; j++) {
      const b = threads[j];
      const fb = feats.get(b.id);
      if (!fb.isos.size) continue;

      // (a) Nation overlap.
      let nationHit = false;
      for (const iso of fb.isos) if (fa.isos.has(iso)) { nationHit = true; break; }
      if (!nationHit) continue;

      // (b) Specific overlap — keywords and title tokens. For big-story
      // pairs, use substring keyword matching + lower thresholds (1 / 2)
      // so paraphrased iran/ukraine/election threads actually cluster.
      const bigPair = fa.big && fb.big;
      const kwOverlap    = bigPair
        ? kwOverlapSubstring(fa.kws, fb.kws)
        : (() => { let c = 0; for (const k of fb.kws) if (fa.kws.has(k)) c++; return c; })();
      let titleOverlap = 0;
      for (const tk of fb.titleT) if (fa.titleT.has(tk)) titleOverlap++;

      const kwThresh    = bigPair ? 1 : 2;
      const titleThresh = bigPair ? 2 : 3;
      if (kwOverlap >= kwThresh || titleOverlap >= titleThresh) union(a.id, b.id);
    }
  }
  const groups = new Map();
  for (const t of threads) {
    const r = find(t.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()];
}

// Split clusters that exceed a size cap into Sonnet-sized chunks. Sonnet 4.5
// can handle ~50 thread descriptors comfortably; beyond that token cost
// climbs and recall drops. We split greedily by primary_category × nation
// so the slices stay topically tight.
function splitOversizedCluster(cluster, maxSize = 25) {
  if (cluster.length <= maxSize) return [cluster];
  // Bucket by (top-1 nation, primary_category) so each slice is a
  // category-coherent sub-group of the same nation.
  const buckets = new Map();
  for (const t of cluster) {
    const iso = (sanitizeIsos(t.primary_nations || [])[0]) || '(none)';
    const key = `${iso}::${t.primary_category || '(none)'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  // If the largest bucket is still >maxSize, fall through to greedy chunks.
  const out = [];
  for (const slice of buckets.values()) {
    for (let i = 0; i < slice.length; i += maxSize) {
      out.push(slice.slice(i, i + maxSize));
    }
  }
  return out;
}

// ─── Claude prompt ──────────────────────────────────────────────────────────
async function askClaude(cluster) {
  const threadLines = cluster.map(t =>
    `#${t.id} "${t.title || ''}"
  nations=[${sanitizeIsos([...(t.primary_nations || []), ...(t.secondary_nations || [])]).slice(0, 5).join(',')}]
  keywords=[${(t.keywords || []).slice(0, 10).join(', ')}]
  description="${(t.description || '').slice(0, 220).replace(/\s+/g, ' ')}"`
  ).join('\n\n');

  const prompt = `You are deduplicating breaking-news story threads. Each thread represents one ongoing story. Below are threads that share at least one country AND have meaningful keyword/title-token overlap; many are likely paraphrased duplicates of the same breaking event.

Return ONLY valid JSON:
{
  "merge_groups": [
    {
      "winner_id": <thread id to keep (highest-coverage canonical version)>,
      "loser_ids": [<ids to merge into winner>],
      "rationale": "one-line reason (<25 words)"
    }
  ]
}

WHAT YOU SHOULD MERGE (positive examples — these ARE duplicates):

1. **Place-name variants of the same event.** Different geographic specificity, same incident:
   • "Belfast Car Bombing at Police Station" + "Northern Ireland Car Bomb at Police Station" → MERGE
   • "Beirut Port Explosion" + "Lebanon Port Disaster" → MERGE
   • "Mumbai Train Bombing" + "India Mumbai Attack" → MERGE
   The narrower placename almost always points to the same event the broader one covers; if titles share the action+target+date, MERGE.

2. **Verb / specificity variants of the same record or achievement.** Same person, same record, different angle:
   • "Kenya's Sawe Shatters Two-Hour Marathon Barrier" + "Kenyan Runner Shatters Marathon World Record" + "Kenya Marathon Record: Sub-Two-Hour Barrier Broken" → MERGE
   • "Roman Ronaldo Hits 1000th Goal" + "Cristiano Ronaldo Reaches Career Milestone Goal" → MERGE
   If both are clearly the same person/team/record (even when one omits the name), MERGE.

3. **Death-toll / damage-update reframings of the same incident.** Same disaster, different vintage:
   • "Colombia Bombing Kills 20 Ahead of Elections" + "Colombia Bombing Death Toll Reaches 20" → MERGE
   • "Turkey Earthquake Kills 1000" + "Turkey Quake Toll Climbs to 5000" → MERGE
   These are evolving updates of one incident, not separate events.

4. **Same corporate/policy action, different framing.** Same actor, same announcement:
   • "China Blocks Meta's $2 Billion AI Startup Acquisition" + "China Blocks Meta's $2 Billion Manus AI Acquisition" → MERGE
   • "Apple Cuts iPhone Production 10%" + "Apple Reduces iPhone Output for FY25" → MERGE

5. **Same ruling / legal action, different outlet's wording.** Same court, same case:
   • "National Court overturns Ombudsman's Starlink blocking order" + "National Court clears Starlink licensing pathway" → MERGE if same ruling/case
   • "Iran Executes Mossad Agent" + "Iran Executes Two Mossad-Linked Espionage Suspects" → MERGE if same execution announcement

HARD BLOCKS — never merge these (regardless of nation/keyword overlap):

- Two DIFFERENT countries as the primary actor (e.g. Cuba energy crisis vs Venezuela energy crisis). Even if same category, NOT duplicates.
- Two DIFFERENT named officials / politicians / actors (e.g. Swalwell resignation vs DeRemer resignation). NOT duplicates.
- OPPOSITE directions of a conflict (e.g. "Ukraine drone strikes on Russian oil" vs "Russian airstrikes on Ukrainian cities"). Different sides — NOT duplicates.
- Different incidents in the same place (e.g. two separate school shootings, two separate prison raids, two separate budget passes). Same place ≠ same event.
- One thread is an umbrella / macro summary (e.g. "Global economic fallout from X war") and the other is a specific-event thread. NOT duplicates.
- Related but distinct facets (e.g. EU energy policy response vs US sanctions relaxation — same broader context, different decisions/actors). NOT duplicates.

A mega-story like the entire US-Iran war legitimately has many separate threads covering distinct events (naval blockade, ceasefire talks, executions, protests, market impact). Keep those separate — merging all into one "Iran War" thread loses information.

JUDGEMENT BAR:
- A safe merge requires the SAME action by the SAME primary actor at the SAME moment in time (or a clear update of one).
- When titles share the protagonist + action + target/effect, MERGE — even if surface vocabulary differs significantly.
- When titles share only a country/region but describe different events or actors, DO NOT merge.

WINNER SELECTION (STRICT — get this right):
- DEFAULT: pick the thread with the highest article_count. The canonical thread is the one with the broadest established coverage; downstream caches, URLs, and analytics anchor to it.
- ONLY override the article_count default when the lower-count thread has a markedly more accurate title — e.g. names the protagonist where the larger thread has a generic placeholder ("Unknown Suspect Detained" vs "Mark Carney Detained"). Stylistic differences do NOT count; "Colombia Highway Bombing Kills 20" is NOT more specific than "Colombia Bombing Kills 20 Ahead of Elections" — they describe the same event with the same specificity, so the higher article_count wins.
- Never pick a winner with article_count < 5 over a loser with article_count > 50. The asymmetry is too costly.

If no real duplicates, return { "merge_groups": [] }.

The dataset is biased toward UNDER-merging; analysts have repeatedly seen 3–4 threads about the same record-breaking marathon spread across distinct categories. When the action+actor match, lean toward MERGE.

THREADS (${cluster.length}):
${threadLines}`;

  const response = await client.messages.create({
    model: MODEL,
    // Bumped 2000 → 4000: larger clusters (now allowed because we dropped
    // the per-category gate) plus the longer prompt with positive examples
    // means richer responses. 4k stays well under Sonnet 4.5's 64k output
    // ceiling and keeps cost roughly flat per cluster.
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
  const parsed = extractJson(text);
  const groups = Array.isArray(parsed?.merge_groups) ? parsed.merge_groups : [];
  // Backstop the winner-selection rule. Sonnet occasionally picks a tiny
  // thread as winner over a much larger loser because the smaller title
  // reads marginally more specific. The downstream cost — orphaning the
  // larger thread's URL slug + analytics — outweighs any title-quality
  // gain, so we swap automatically when the imbalance is severe.
  // Triggers when:
  //   - loser has >= 5× as many articles AND
  //   - loser has >= 30 articles in absolute terms (high-coverage)
  // This catches the Colombia case (12-article winner over 164-article loser)
  // even though the previous rule's `winnerN <= 10` constraint missed it.
  const byId = new Map(cluster.map(t => [t.id, t]));
  const fixed = [];
  for (const g of groups) {
    const winnerId = parseInt(g.winner_id, 10);
    const loserIds = Array.isArray(g.loser_ids)
      ? g.loser_ids.map(x => parseInt(x, 10)).filter(Boolean)
      : [];
    if (!Number.isFinite(winnerId) || !loserIds.length) continue;
    const winner = byId.get(winnerId);
    if (!winner) {
      fixed.push({ winner_id: winnerId, loser_ids: loserIds, rationale: String(g.rationale || '').slice(0, 160) });
      continue;
    }
    const winnerN = Number(winner.article_count) || 0;
    let bestLoserN = winnerN;
    let bestLoserId = winnerId;
    for (const lid of loserIds) {
      const l = byId.get(lid);
      if (!l) continue;
      const ln = Number(l.article_count) || 0;
      if (ln >= bestLoserN * 5 && ln >= 30) {
        bestLoserN = ln; bestLoserId = lid;
      }
    }
    if (bestLoserId !== winnerId) {
      // Swap — promote the giant loser to winner; demote the original
      // winner into the loser list.
      const newLosers = [winnerId, ...loserIds.filter(id => id !== bestLoserId)];
      fixed.push({
        winner_id: bestLoserId,
        loser_ids: newLosers,
        rationale: `${String(g.rationale || '').slice(0, 120)} [auto-swapped: ${bestLoserId} has ${bestLoserN} articles vs ${winnerId}'s ${winnerN}]`,
      });
    } else {
      fixed.push({
        winner_id: winnerId,
        loser_ids: loserIds,
        rationale: String(g.rationale || '').slice(0, 160),
      });
    }
  }
  return fixed.filter(g => Number.isFinite(g.winner_id) && g.loser_ids.length);
}

// ─── Merge (mirrors storyThreadBuilder.dedupSimilarThreads semantics) ───────
async function mergeThread(winner, loser) {
  // Move loser's articles onto winner (skip dupes)
  await pool.query(`
    INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
    SELECT $1, sta.article_id, sta.relevance_score, FALSE
      FROM story_thread_articles sta
     WHERE sta.thread_id = $2
     ON CONFLICT DO NOTHING
  `, [winner.id, loser.id]);

  // Keywords still get unioned (they're a free-form bag, not a tightly-
  // capped semantic field). Nations get RECOMPUTED from the merged
  // article corpus instead — the previous blind union is what was
  // ballooning primary_nations to 7-22 entries with countries that no
  // article ever mentioned.
  const winnerKws = new Set((winner.keywords || []).map(k => String(k || '').trim().toLowerCase()).filter(Boolean));
  (loser.keywords || []).forEach(k => winnerKws.add(String(k || '').trim().toLowerCase()));
  const mergedKeywords = [...winnerKws];

  // Pull the merged article set, run it through article_locations to get
  // ground truth. computeNationsFromArticles caps at PRIMARY_CAP (4) /
  // SECONDARY_CAP (12) and ranks by distinct-article mention count.
  const { rows: artRows } = await pool.query(
    `SELECT article_id FROM story_thread_articles WHERE thread_id = $1`,
    [winner.id]
  );
  const { primary: nextPrimary, secondary: nextSecondary, mentions } =
    await computeNationsFromArticles(pool, artRows.map(r => r.article_id));

  // Safety net: if article_locations is empty for everything in the merged
  // set (extractor was offline / older articles never tagged), keep the
  // winner's existing arrays rather than blanking the thread out.
  const mergedPrimary   = mentions.length ? nextPrimary   : (winner.primary_nations   || []);
  const mergedSecondary = mentions.length ? nextSecondary : (winner.secondary_nations || []);

  await pool.query(`
    UPDATE story_threads
       SET article_count   = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
           keywords        = $2::text[],
           primary_nations = $3::text[],
           secondary_nations = $4::text[],
           importance      = GREATEST(importance, $5),
           last_updated_at = NOW()
     WHERE id = $1
  `, [winner.id, mergedKeywords, mergedPrimary, mergedSecondary, Number(loser.importance) || 0]);

  // Drop loser's join rows, mark dormant
  await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [loser.id]);
  await pool.query(`
    UPDATE story_threads
       SET status = 'dormant', article_count = 0, last_updated_at = NOW()
     WHERE id = $1
  `, [loser.id]);
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

// ─── Exported entry point for in-cron invocation ────────────────────────────
// storyThreadBuilder.js calls this at the end of its run, scoped to the
// thread IDs it just created/updated. Scoping keeps Claude cost at a
// handful of clusters per run (~$0.05-$0.10) instead of the full 19-cluster
// semantic pass (which costs ~$0.40/run and is better run manually every
// few hours).
//
// Options:
//   touchedIds : Set<number> | Array<number> — ids created/updated this run
//   maxClusters: number — hard cap on Claude calls (default 5)
//   apply      : boolean  — actually merge (default true in cron)
//   log        : console-like object for progress logs (default console)
async function runScopedDedup({ touchedIds, maxClusters = 5, apply = true, log = console } = {}) {
  const idSet = touchedIds instanceof Set ? touchedIds : new Set([...(touchedIds || [])].map(Number));
  if (!idSet.size) return { proposed: 0, merged: 0, claudeCalls: 0 };

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, keywords, primary_category,
           primary_nations, secondary_nations, importance,
           article_count, last_updated_at
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= 2
  `);
  if (!threads.length) return { proposed: 0, merged: 0, claudeCalls: 0 };

  const all = buildClusters(threads).flatMap(c => splitOversizedCluster(c, 25));
  // Keep only clusters that contain at least one touched thread, have
  // at least 2 threads total, and sort by size DESC so the biggest
  // potential-dup clusters get the budget.
  const scoped = all
    .filter(c => c.length >= 2 && c.some(t => idSet.has(Number(t.id))))
    .sort((a, b) => b.length - a.length)
    .slice(0, maxClusters);

  let proposed = 0;
  let merged   = 0;
  let claudeCalls = 0;

  for (const cluster of scoped) {
    claudeCalls++;
    const cat = cluster[0].primary_category || '?';
    log.log(`   [claude-dedup] cluster cat=${cat} threads=${cluster.length} (touched: ${cluster.filter(t => idSet.has(Number(t.id))).length})`);
    let groups;
    try { groups = await askClaude(cluster); }
    catch (err) { log.warn(`   [claude-dedup] error: ${err.message}`); continue; }

    for (const g of groups) {
      const winner = cluster.find(t => t.id === g.winner_id);
      if (!winner) continue;
      const loserIds = (g.loser_ids || []).filter(id => id !== g.winner_id);
      for (const loserId of loserIds) {
        const loser = cluster.find(t => t.id === loserId);
        if (!loser) continue;
        proposed++;
        log.log(`   [claude-dedup] ${apply ? '✂' : '[dry]'}  ${loserId} "${(loser.title || '').slice(0,60)}" → ${winner.id} "${(winner.title || '').slice(0,60)}"`);
        if (apply) {
          try { await mergeThread(winner, loser); merged++; }
          catch (err) { log.warn(`   [claude-dedup] merge failed: ${err.message}`); }
        }
      }
    }
  }

  return { proposed, merged, claudeCalls };
}

module.exports = { runScopedDedup };

// Only auto-run the CLI main() when invoked directly via
// `node dedupThreadsWithClaude.js`, never when required as a module.
if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
