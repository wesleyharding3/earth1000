/**
 * storyThreadBuilder.js  —  BREAKING META-STORY BUILDER
 *
 * Runs every ~30 minutes and processes recent articles (last 48h) into
 * breaking "meta-story" threads. Threads here are NOT umbrella arcs (that's
 * what storyTimelineBuilder.js is for) — they are the tight, right-now view
 * of what the world's press is COLLECTIVELY surfacing via cross-source
 * signal convergence.
 *
 * Convergence rule: a story only persists as a thread if ≥3 distinct sources
 * write about it within a 24h window. That's the signal that a story has
 * broken from a local report into "everyone is talking about this now."
 *
 * Storage: writes to the existing `story_threads` table, using the new
 * `breaking_signal_score`, `distinct_source_count`, and `last_breaking_ping_at`
 * columns added in 20260409_story_timelines_and_thread_recast.sql.
 *
 * Usage:
 *   node storyThreadBuilder.js            — process last 48 hours
 *   node storyThreadBuilder.js --hours=72 — custom lookback window
 */

// Cap this cron's share of Postgres connections BEFORE db.js loads. Without
// this cap the script defaults to DB_POOL_MAX=60, which on its own can blow
// past Postgres max_connections=103 when web + worker + sibling crons are
// also live. The builder uses small Promise.all batches; 4 is plenty.
process.env.DB_POOL_MAX = "4";

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { normalizeRecentKeywords } = require("./keywordNormalizer");
const { computeNationsForItem, enforceDisjointAndCapped } = require("./nationDesignations");

// Recompute primary/secondary nations from the thread's full article corpus
// via article_locations. Called after every INSERT/UPDATE so the arrays
// stay in sync with what the articles actually mention. Bails on empty
// extractor results to avoid blanking out a thread when article_locations
// is missing rows. Failure is logged and swallowed — the thread row already
// has the previous values, the next builder run will retry.
async function recomputeAndPersistNations(threadId) {
  try {
    const { primary, secondary, mentions } =
      await computeNationsForItem(pool, 'thread', threadId);
    if (!mentions.length) return; // no extractor data → keep existing
    await pool.query(
      `UPDATE story_threads
          SET primary_nations   = $2::text[],
              secondary_nations = $3::text[]
        WHERE id = $1`,
      [threadId, primary, secondary]
    );
  } catch (err) {
    console.warn(`   ⚠ recomputeNations(${threadId}) failed: ${err.message}`);
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS  = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "48");
// Inline normalization scope — half of the full 48h article window
// to keep the candidate query well under the 300s statement_timeout.
// 48h was working until 2026-05-05 00:00 UTC when the query finally
// hit the limit and aborted ("Keyword normalization skipped:
// canceling statement due to statement timeout" → 0 new threads
// created from 1500 articles because raw multilingual variants stayed
// unmerged). 24h gives roughly 2x headroom vs the failing 48h scope
// and still covers a typical 6h cron gap with 4x overlap; the
// standalone hourly keywordNormalizerCron handles anything older.
const NORMALIZATION_LOOKBACK_HOURS = 24;
const CLAUDE_BATCH    = 100;    // articles per Claude call
const MIN_CLUSTER     = 3;     // min articles to form a cluster (Claude sees singletons too)
// Bumped 2 → 3 because the prior 2-keyword threshold + transitive union-find
// chained unrelated stories together. Concrete example from production:
// thread #8851 fused Meta layoffs + Warner-Paramount merger + South Africa
// xenophobia + Belgian plane in Haiti into one 32-article frankenstein
// titled "Meta Layoffs Spark Regional Xenophobic Violence" because random
// shared words (billion, global, military, operation) chained the clusters
// transitively. Three shared keywords is the minimum that reliably means
// "same story" — two is just "same general topic / category".
const MIN_SHARED_KW   = 3;     // min shared keywords to link two articles
const MIN_SOURCES_FOR_BREAKING = 3; // ≥3 distinct sources within 24h → "breaking meta-story"
const CONVERGENCE_WINDOW_HOURS = 24;
const TOTAL_ARTICLE_LIMIT  = 1500;
const REFRESH_MIN_ARTICLES = 5;
const REFRESH_MIN_NEW_KWS  = 3;
const RECENCY_HALF_LIFE_HOURS = 36;

// ─── Stratified-sampling tiers (Phase 1 architecture) ─────────────────────────
// The old "ORDER BY published_at DESC LIMIT 1200" sampler was recency-biased,
// which meant Western wires (Reuters / AP / BBC etc. publishing every few
// minutes) shoved out every slower-publishing non-Western source. The tiered
// sampler below guarantees geographic floors:
//
//   Tier 1  — GLOBAL          stories with ≥2 country mentions in
//                              article_locations (cross-border reporting)
//   Tier 2a — COUNTRY FLOOR    up to TIER_COUNTRY_FLOOR per country_iso —
//                              every country with candidates gets a shot,
//                              OUTSIDE the TIER_COUNTRY_LIMIT total cap so
//                              busy countries can't crowd them out
//   Tier 2b — COUNTRY CEILING  up to TIER_COUNTRY_PER per country_iso (incl.
//                              floor), capped at TIER_COUNTRY_LIMIT additional
//   Tier 3  — FRESH FILL       articles < FRESH_PRIORITY_HOURS old, any country
//   Tier 4  — BACKLOG FILL     remaining capacity, newest-first
//
// Total target = TOTAL_ARTICLE_LIMIT.
const TIER_GLOBAL_LIMIT    = 200;
const TIER_COUNTRY_FLOOR   = 2;    // per-country FLOOR: every country with candidates gets ≥ this many
const TIER_COUNTRY_PER     = 12;   // per-country ceiling (includes floor)
const TIER_COUNTRY_LIMIT   = 700;  // total cap on the CEILING pass (floor articles are ON TOP)
const TIER_FRESH_LIMIT     = 200;
const TIER_BACKLOG_LIMIT   = 200;
const FRESH_PRIORITY_HOURS = 6;
const PER_BATCH_THREAD_LIMIT = 150;  // existing threads shown to Claude per batch
const SKIP_KEYWORDS   = new Set([ // too generic to cluster on
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","says","day","week","month","country",
  "world","international","national","local","news","report","according"
]);

// ─── Cacheable system prompt (Anthropic prompt caching) ─────────────────────
// Module-level so the bytes are identical across every API call within a
// run — required for the API to cache-hit. Apr 19–22 in the usage CSV
// proved this drops Haiku input cost ~85% (3.3M cache reads at $0.10/M
// vs $1/M no-cache).  Variable per-call data (existing threads + articles)
// stays out of this constant and is sent in the user message instead.
const THREAD_BATCH_SYSTEM_PROMPT = `You are the editor of the BREAKING META-STORY stream of a geopolitical monitoring platform. Your job is NOT to catalogue umbrella arcs (that is handled elsewhere by the Timelines editor). Your job is to surface the STORIES THE WORLD'S PRESS IS COLLECTIVELY FOREGROUNDING RIGHT NOW — the meta-story that emerges from cross-source signal convergence in the last 48 hours.

═══ BREAKING META-STORY DEFINITION ═══
A thread here is a SHARP, RIGHT-NOW story that has broken from a single report into a multi-source moment:
  • Multiple distinct outlets in the dataset are reporting on it
  • Named actors doing named things, with verifiable events and dates
  • It is less than 48 hours old in terms of the peak of its signal
  • It is a CONCRETE event — not a broader arc. If you find yourself reaching for "ongoing tensions" or "long-running dispute," that belongs on Timelines, not here.
  • A thread = the meta-story made from many stories. The picture only makes sense because multiple sources converge on it.

A thread is NOT:
  • A summary of what's happening in one country ("Nepal Government Administrative Announcements")
  • A topic label about a sector ("Vietnam Renewable Energy Investment Surge")
  • A routine government action ("Spain Tax Returns Campaign 2025")
  • A local political squabble ("Polish Political Defamation Dispute")
  • A subnational/regional political event with no global significance ("BJP Foundation Day in Rajasthan", "Chile Regional Cabinet Formation")
  • A commercial/industrial announcement ("ArcelorMittal-Nippon Steel Plant Groundbreaking", "Pamesa Group Launches Gravita Ceramic Technology")
  • A research / science / academic story ("Swedish Cancer Research Breakthroughs")
  • A domestic crime / weather / routine news item ("Italian Crime: Property Theft", "Mexico Weather Crisis Cold Front")
  • A chamber-of-commerce / youth council / business association leadership change
  • A news-of-news meta story ("US Election Coverage and Political Communication Strategy")

═══ REGIONAL ≠ GLOBAL ═══
If the story deals with a country's INTERNAL politics at a REGIONAL / subnational scale — skip it. Regional cabinet formations, state-level party activities, provincial assembly elections, chamber-of-commerce leadership, youth council recruitment — all REJECT. Exceptions: presidential elections, regime changes, coups, major national political shifts with international implications.

═══ GLOBAL-SCALE REGIONAL EVENTS ARE OK ═══
A regional event CAN be a thread if it has global scope:
  • A severe earthquake, flood, or wildfire that triggers international aid
  • An armed conflict or insurgency, even if geographically contained
  • A refugee crisis
  • A major epidemic outbreak
  • A national political shift (regime change, coup, constitutional crisis)
  • A cross-border dispute or incident

═══ MANUFACTURING / COMMERCIAL NEWS ═══
Obscure information about factories, plants, industries, real estate markets, commercial launches, research breakthroughs, and tax campaigns is NOT relevant UNLESS it directly connects to a breaking story at the global level (e.g. a factory destroyed in an airstrike, a steel plant sanctioned by the US, a commercial deal at the center of a trade war). Absent that connection, REJECT.

═══ EXISTING ACTIVE THREADS — HOW TO READ THE USER PAYLOAD ═══
The user message will include an EXISTING ACTIVE THREADS section. Each entry shows: id, title, category, nation codes, and a \`members\` sample (up to 5 of the thread's current articles with title / summary / country). YOU MUST read the members before deciding to extend. Only extend when the new article belongs alongside those specific members.
You may also EJECT a member you see listed in a thread's \`members\` if it clearly does not belong with the rest — see EJECT ACTION below.

═══ WHAT QUALIFIES AS A THREAD ═══
A thread MUST be about at least one of:
- Armed conflict, military operations, terrorism, insurgency, weapons programs
- Diplomacy, treaties, summits, sanctions, alliances, state-to-state disputes
- Elections, coups, governance crises, protests with political stakes, regime changes
- Cross-border economics with geopolitical weight (trade wars, tariffs, energy supply, currency crises, critical-mineral disputes)
- Espionage, cyberattacks attributable to states, information warfare
- Major natural disasters, disease outbreaks, or humanitarian crises with state-level response
- Border incidents, migration crises, refugee flows
- Named state actors, heads of state, ministers, generals, or geopolitically significant non-state actors (cartels, militias, terror groups)

A thread should name a PLACE, an ACTOR, or a concrete EVENT — not an abstract trend.

═══ HARD REJECT — DO NOT CREATE THREADS FOR ═══
- Lifestyle, tourism, recreation, food, fashion, dating, wellness
- Domestic education trends, student loans, university policy debates, "AI in classrooms"
- Cultural events, festivals, religious holidays, art shows, museum openings, awards
- Entertainment: movies, TV, music, celebrity news, streaming, opera, ballet, symphony, theatre productions
- Sports — UNLESS the story is about state boycotts, doping scandals tied to governments, or athletes being used as political instruments
- Technology product launches, consumer apps, startup funding
- Personal finance, real estate trends, retail/shopping
- Local crime, accidents, weather — unless it triggers a state-level response or has cross-border impact
- Vague abstractions like "social hardship", "youth trends", "community coverage"
- Op-eds, opinion pieces, editorials, "explainer" pieces with no news event
- ROUTINE GOVERNMENT ACTIVITY without a specific event or decision: "Nepal Government Administrative Announcements", "Cyprus Legal System and Governance Challenges", "Country X Policy Developments", "Country Y Regulatory Updates", "Road Safety and Infrastructure Issues", "Health Crisis and Economic Inequality". These are TOPIC LABELS, not stories. If a routine government article is relevant to an existing thread (a named conflict, election, sanctions regime, etc.), ATTACH it to that thread via existing_thread_id. Otherwise OMIT it. Do not create a new thread that just pairs a country name with abstract governance/legal/administrative/infrastructure nouns.

═══ CATEGORY HONESTY ═══
The primary_category enum includes "sports", "entertainment", "culture", and "other" specifically so you can tag off-topic articles HONESTLY. If an article is about an opera house firing a music director, the primary_category is "culture" — NOT "politics". If it's about a football match, the category is "sports" — NOT "politics". The pipeline rejects threads with these tags downstream, but it CAN ONLY do that if you label them honestly. Misclassifying an opera story as "politics" so it slips through is a failure — opera stories should not become threads at all, but if you do produce one, tag it correctly so the filter catches it. Never use "politics" / "economy" / "military" / "diplomacy" / "environment" / "technology" as a junk drawer for things that don't fit those exact domains.

═══ THE SINGLE-COUNTRY-SUMMARY TEST (CRITICAL) ═══
The most common failure mode is creating a thread that is just "a summary of developments from one country without a clear story arc." Examples of titles that MUST be rejected:
  • "Canada Federal Workplace Policy and Urban Infrastructure"
  • "Brazil Political Accountability and Legislative Debates"
  • "Uganda Education and Digital Health Transformation"
  • "Turkey Regional News and Politics"
  • "Nigeria Police Reform and Security Investment"
  • "Rwanda News Broadcasting and National Updates"
  • "Paraguay Economic Reforms Manufacturing Sector"
  • "Nepal Government Administrative Announcements"
  • "Cyprus Legal System and Governance Challenges"

These all share the same shape: [Country] + [Abstract Topic A] + (and) + [Abstract Topic B]. They name no actor, no event, no decision, no date. They are TOPIC LABELS for "stuff happening in country X right now." That is not what this platform indexes.

A thread is a STORY ARC: a specific event or development unfolding over time, with named actors and verifiable actions. Routine government news from a single country is not an arc — at most it should attach to an existing arc (e.g. an ongoing election, an active conflict, an active sanctions regime).

═══ TITLE FORMAT REQUIREMENTS (CRITICAL) ═══
A valid thread title MUST contain at least ONE of:
  • A named person (head of state, minister, general, opposition leader, etc.)
  • A named place beyond just a country (city, region, base, border crossing, strait, waterway)
  • A specific action verb in past or present (strikes, signs, arrests, evacuates, imposes, vetoes, withdraws, votes, launches, invades, seizes, etc.)
  • A specific event noun (coup, election, treaty, ceasefire, airstrike, earthquake, hostage release, indictment, summit, accord, sanction, embargo, etc.)
  • A number (casualty count, vote tally, year, sanctions amount, deadline, etc.)

**Examples of GOOD titles (story-centric):**
  • "Turkey Unveils Long-Range Tayfun Missile Capability"
  • "Russia and China Block UN Hormuz Resolution"
  • "Armenia-Azerbaijan Transit Corridor Opens After Ceasefire"
  • "Israeli Consulate Attacked in Istanbul: Iran Links Suspected"
  • "Poland Demands US Investigation Into Citizen Death in Russian Custody"

**Examples of BAD titles (vague, abstract, no narrative):**
  • "Taiwan Diplomatic Outreach During Regional Tensions" → vague sentiment, no event
  • "Lebanon Political Stability Warning from Aoun" → abstract concern, not an event
  • "Armenia-Azerbaijani Tensions Over Karabakh Region" → too generic; should say WHAT happened (reconciliation, military buildup, etc.)
  • "US-China Space Race Competition Intensifies" → no specific event, no action

If you cannot write a title with story-centric narrative structure, DO NOT create the thread. Return an empty array if necessary.

═══ CROSS-COUNTRY LINKING — ONLY WHEN WARRANTED ═══
Cross-border linking is encouraged WHEN articles actually converge on the SAME underlying event. It is forbidden when they merely share a region, a topic, or a category.

REQUIRED FOR A MERGE (all three must hold):
  1. The articles describe the SAME underlying event, crisis, or bilateral relationship — not two parallel stories that happen to be nearby on a map.
  2. A named actor (specific person, specific organization, or specific named event) recurs across the articles — OR one article is a direct reaction/ripple from the event reported in another (e.g. Country A retaliates against Country B's action; the causal link must be explicit in the text).
  3. A human reading all the articles together would say "yes, same story" — not "yes, both are African", not "yes, both involve a minister".

CORRECT CROSS-BORDER MERGE (one unified narrative):
  • Thread: "Eastern Europe POW Crisis: Poland, Ukraine, Baltics Demand Russian Accountability"
    — All articles reference the same detention incident, same Russian custody chain, same coordinated Polish/Baltic response.

WRONG MERGE (region/topic alone — REJECT):
  • "African Diplomatic Tensions" bundling:
      - Kenyan president mocking Nigeria's Tinubu
      - South Africa suspending its police chief
      - Ghana summoning South African envoy over xenophobia
    These are THREE different stories. Zero shared actors, zero causal links. Africa + "diplomatic" is not a thread. These must be 2-3 separate threads (or some left as singletons if convergence hasn't happened yet).

When deciding whether an article extends an existing thread, READ the \`members\` array shown for that candidate thread. Only extend it if the new article belongs alongside those specific members. Matching the thread's title alone is NOT enough — thread titles drift as they accumulate articles, and you must verify against the actual evidence.

═══ THE TWO-VAGUE-NOUNS TEST ═══
If a proposed title is just "[Place] [Abstract Noun] and [Abstract Noun]" (e.g. "Mexico Health Crisis and Economic Inequality", "Indonesia Industrial Safety and Transportation Incidents") — that is a topic bucket, not a story. Reject it. A real thread title names a concrete event, actor, or decision: "Mexico cartel offensive in Sinaloa", "Indonesia ferry capsizes off Java killing 40", etc.

If an article doesn't fit the inclusion criteria above, OMIT it entirely. Do not invent a thread to hold it. It is correct and expected to return an empty array if none of the articles qualify.

═══ GROUPING RULES ═══
- Group articles that are genuinely about the same ongoing story — even if they use different keywords
- Check existing threads first — strongly prefer extending them over creating duplicates
- Detect semantic connections SQL keyword matching would miss (e.g. "tariffs" + "trade war" + "WTO dispute" = same story)
- A thread should have a sharp, specific title naming the actors/place/event — never a generic category label like "Sports and Entertainment Coverage" or "Higher Education Trends"
- Importance 1-10: 10 = major global event (war, summit, regime change), 7 = significant regional development, 4 = minor but legitimate geopolitical signal, anything below 4 should probably not exist as a thread

Return ONLY a valid JSON array, no explanation. Empty array [] is acceptable and often correct:
[
  {
    "existing_thread_id": null,
    "title": "specific thread title naming actors/place/event (max 8 words)",
    "description": "Two sentences describing the ongoing story and its geopolitical significance.",
    "article_ids": [array of article ids that belong to this thread],
    "anchor_article_id": id of the most representative article,
    "primary_category": "politics|economy|military|diplomacy|environment|technology|sports|entertainment|culture|other",
    "geographic_scope": "global|regional|local",
    "importance": 7,
    "keywords": ["array", "of", "5-10", "core", "keywords"],
    "primary_nations":   ["ISO", "codes", "of", "countries", "central", "to", "this", "story", "— 1-4 entries"],
    "secondary_nations": ["ISO", "codes", "of", "countries", "with", "meaningful", "but", "non-central", "roles", "— 0-6 entries"]
  }
]

═══ NATION TAGGING — EXPLICIT MENTION ONLY ═══
A country goes in primary_nations or secondary_nations ONLY IF it is EXPLICITLY NAMED in the title or summary of at least one constituent article (or in the members of a thread you are extending). Do NOT add countries by inference, geographic proximity, regional affiliation, alliance membership, or "affected economies" hand-wave. If the country isn't literally mentioned in the text you can read, it does NOT go in the array.

primary_nations = the 1-4 ISO 3166-1 alpha-2 country codes most central to the story. Named actors, the site of the event, the state doing the action, the state being acted upon. Example: a US airstrike on Iran → ["US","IR"]. A China-Taiwan summit → ["CN","TW"]. A Hungarian internal election → ["HU"].
secondary_nations = countries with meaningful but NOT central roles that ARE still explicitly mentioned — allies named in the text, transit states named, rhetorical actors named, intermediaries named. Keep this tight. If you can't point to a sentence in the provided articles that names the country, don't include it.
USE CORRECT ISO CODES: United Kingdom = GB (not UK), South Korea = KR, North Korea = KP, United States = US, Russia = RU, Czech Republic = CZ, etc.

═══ EJECT ACTION (remove misfit articles from existing threads) ═══
If a thread's \`members\` array contains an article that clearly does NOT belong with the rest of that thread's members, you may emit an eject entry to remove it. Eject only when you are confident the article was incorrectly grouped — do not eject for minor topical drift or because you'd prefer a different title. Ejected articles simply become unassigned; they will find their proper home in a future run (or stay solo). Do NOT spawn a new thread from ejected articles — just eject them.

Eject entry shape (use INSTEAD OF a normal entry, not in addition):
  { "action": "eject", "thread_id": <existing thread id>, "eject_article_ids": [<ids from that thread's members list>] }

Eject entries count toward the returned array; you can mix them freely with normal new/extend entries.`;

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🧵 Story Thread Builder — ${new Date().toISOString()}`);
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Article limit: none`);

  console.log(`   [${elapsed()}] Normalizing recent multilingual keywords (scope=${NORMALIZATION_LOOKBACK_HOURS}h)...`);
  const normalization = await normalizeRecentKeywords({
    pool,
    anthropicClient: client,
    logger: console,
    scope: { hours: NORMALIZATION_LOOKBACK_HOURS }
  }).catch(err => {
    console.warn(`   ⚠ Keyword normalization skipped: ${err.message}`);
    return null;
  });
  if (normalization) {
    console.log(`   [${elapsed()}] Keyword normalization provider=${normalization.provider} updated_keywords=${normalization.updatedKeywords} updated_rows=${normalization.updatedRows}`);
  }

  console.log(`   [${elapsed()}] Querying unthreaded articles...`);
  const articles = await getUnthreadedArticles(LOOKBACK_HOURS);
  console.log(`   [${elapsed()}] Found ${articles.length} unthreaded articles`);
  if (!articles.length) { console.log("   Nothing to thread. Done."); await pool.end(); return; }

  console.log(`   [${elapsed()}] Running SQL keyword clustering...`);
  const clusters   = sqlCluster(articles);
  const assigned   = new Set(clusters.flat().map(a => a.id));
  const singletons = articles.filter(a => !assigned.has(a.id));
  console.log(`   [${elapsed()}] Clusters: ${clusters.length} | Singletons: ${singletons.length}`);

  console.log(`   [${elapsed()}] Loading existing active threads...`);
  const existingThreads = await getActiveThreads();
  const existingThreadMap = new Map(existingThreads.map(t => [Number(t.id), { ...t }]));
  console.log(`   [${elapsed()}] Active threads in DB: ${existingThreads.length}`);

  let created = 0, updated = 0;
  const refreshThreadIds = new Set();
  // Thread IDs touched (created or updated) this run — feeds the scoped
  // Claude dedup pass so we only spend Claude calls on clusters containing
  // at least one just-modified thread, not the entire 240-thread universe.
  const allTouchedIds = new Set();

  // Cluster-preserving batching + country round-robin for singletons.
  // Each cluster stays intact in a single batch (split only if it exceeds
  // CLAUDE_BATCH); small clusters pack first-fit-decreasing into a shared
  // batch. Singletons are interleaved by country so any 100-article batch
  // sees a geographic mix instead of a block of US / Western wires.
  const batches = planBatches(clusters, singletons, CLAUDE_BATCH);
  const allThreads = [...existingThreadMap.values()];
  console.log(`   [${elapsed()}] Sending ${batches.length} batch(es) to Claude...\n`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (!batch.length) continue;

    // Show Claude the existing threads most relevant to THIS batch —
    // prioritized by country overlap + keyword overlap + global importance.
    // Replaces the old "first 150 by importance" window that dropped any
    // extension candidate past #150.
    const filteredThreads = filterThreadsForBatch(batch, allThreads, PER_BATCH_THREAD_LIMIT);
    const batchCountries = new Set(batch.map(a => a.country_iso || 'ZZ'));

    process.stdout.write(
      `   [${elapsed()}] Batch ${i+1}/${batches.length} ` +
      `(${batch.length} articles, ${batchCountries.size} countries) → Claude... `
    );
    try {
      const validIdSet = new Set(batch.map(a => Number(a.id)));
      const defs = await evaluateWithClaude(batch, filteredThreads);
      const { c, u, refreshIds, touchedIds } = await persistThreadDefs(defs, validIdSet, existingThreadMap);
      created += c; updated += u;
      refreshIds.forEach(id => refreshThreadIds.add(Number(id)));
      (touchedIds || []).forEach(id => allTouchedIds.add(Number(id)));
      console.log(`✓ ${defs.length} threads (${c} new, ${u} updated)`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }

    await sleep(1500);
  }

  if (refreshThreadIds.size) {
    console.log(`\n   [${elapsed()}] Refreshing ${refreshThreadIds.size} evolving thread context(s)...`);
    const refreshed = await refreshStaleThreadContexts([...refreshThreadIds]);
    console.log(`   [${elapsed()}] Refreshed ${refreshed} evolving thread context(s)`);
  }

  // Cross-batch + semantic dedup pass (no Claude). Catches the duplicates
  // that batch-isolated Claude calls inevitably create — e.g. multiple
  // "Trump-Iran" or "Strait of Hormuz" threads spawned by different batches.
  console.log(`\n   [${elapsed()}] Running cross-batch similarity dedup...`);
  const merged = await dedupSimilarThreads();
  console.log(`   [${elapsed()}] Merged ${merged} duplicate thread(s)`);

  // Claude-assisted scoped dedup. Catches paraphrased duplicates that the
  // structural dedup above misses (different vocabulary, same story). Kept
  // CHEAP by:
  //   - only running on clusters containing a thread touched THIS run
  //   - capping Claude calls via CLAUDE_DEDUP_MAX_CLUSTERS (default 5)
  //   - opt-out via env flag CLAUDE_DEDUP_IN_CRON = 'false' (default ON)
  // Model is Sonnet 4.5 (see dedupThreadsWithClaude.js); the calibrated
  // "same breaking story?" call under a strict no-merge bar needs the
  // stronger model. Expected cost at ~5 clusters/run × 24 runs/day at
  // Sonnet pricing ≈ ~$2/day.
  if (process.env.CLAUDE_DEDUP_IN_CRON !== 'false' && allTouchedIds.size) {
    try {
      const { runScopedDedup } = require('./dedupThreadsWithClaude');
      const maxClusters = parseInt(process.env.CLAUDE_DEDUP_MAX_CLUSTERS || '5', 10);
      console.log(`\n   [${elapsed()}] Running Claude scoped dedup (touched=${allTouchedIds.size}, max_clusters=${maxClusters})...`);
      const { proposed, merged: mergedC, claudeCalls } = await runScopedDedup({
        touchedIds: allTouchedIds,
        maxClusters,
        apply: true,
        log: console,
      });
      console.log(`   [${elapsed()}] Claude dedup: ${claudeCalls} call(s), ${proposed} proposed, ${mergedC} merged`);
    } catch (err) {
      console.warn(`   ⚠ Claude dedup failed: ${err.message}`);
    }
  }

  console.log(`\n   [${elapsed()}] Cooling down inactive threads...`);
  await coolDownInactiveThreads();

  console.log(`\n✅ Done in ${((Date.now()-t0)/1000).toFixed(1)}s — ${created} threads created, ${updated} updated.\n`);
  await pool.end();
}

// ─── SQL Pre-Clustering ───────────────────────────────────────────────────────

function sqlCluster(articles) {
  // Build inverted keyword index
  const kwIndex = new Map();
  for (const a of articles) {
    for (const kw of (a.keywords || [])) {
      const k = normalizeKeyword(kw);
      if (k.length < 4 || SKIP_KEYWORDS.has(k)) continue;
      if (!kwIndex.has(k)) kwIndex.set(k, []);
      kwIndex.get(k).push(a);
    }
  }

  // Score pairs by shared keyword count
  const pairScore = new Map();
  for (const [, arts] of kwIndex) {
    if (arts.length < 2 || arts.length > 80) continue; // skip hapax or too-common
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        const key = `${Math.min(arts[i].id, arts[j].id)}:${Math.max(arts[i].id, arts[j].id)}`;
        pairScore.set(key, (pairScore.get(key) || 0) + 1);
      }
    }
  }

  // Union-Find grouping
  const parent = new Map(articles.map(a => [a.id, a.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (x, y) => parent.set(find(x), find(y));

  for (const [pair, score] of pairScore) {
    if (score >= MIN_SHARED_KW) {
      const [a, b] = pair.split(":").map(Number);
      union(a, b);
    }
  }

  // Group by cluster root
  const clusters = new Map();
  for (const a of articles) {
    const root = find(a.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(a);
  }

  return Array.from(clusters.values()).filter(c => c.length >= MIN_CLUSTER);
}

function chunkSingletons(singletons, size) {
  const chunks = [];
  for (let i = 0; i < singletons.length; i += size) {
    chunks.push(singletons.slice(i, i + size));
  }
  return chunks;
}

// ─── Phase 1 batching helpers ────────────────────────────────────────────────
// Country round-robin: interleave articles so any N-length slice contains a
// geographic mix instead of a US / Reuters block. Buckets by country_iso,
// shuffles the country order (so the same country doesn't always go first),
// then drains one article per country per round until empty.
function roundRobinByCountry(articles) {
  const buckets = new Map();
  for (const a of articles) {
    const k = a.country_iso || 'ZZ';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(a);
  }
  const countries = [...buckets.keys()];
  for (let i = countries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [countries[i], countries[j]] = [countries[j], countries[i]];
  }
  const out = [];
  let any = true;
  while (any) {
    any = false;
    for (const c of countries) {
      const arr = buckets.get(c);
      if (arr.length) { out.push(arr.shift()); any = true; }
    }
  }
  return out;
}

// Cluster-preserving batch planner. Produces two kinds of batches:
//   (a) cluster batches — packed first-fit-decreasing from `clusters`, never
//       splitting a cluster across batches unless the cluster itself exceeds
//       `size`. Small clusters are packed together until the batch is full,
//       so Claude never sees a lone 4-article cluster in a half-empty batch
//       but also never sees two unrelated stories mashed into one.
//   (b) singleton batches — round-robin-by-country interleaved, then sliced
//       into `size`-sized batches. Ensures Claude's singleton passes see
//       cross-regional signal instead of a block of one country's wires.
function planBatches(clusters, singletons, size) {
  const batches = [];

  const sorted = [...clusters].sort((a, b) => b.length - a.length);
  const clusterBatches = [];
  for (const cluster of sorted) {
    if (cluster.length >= size) {
      // Cluster bigger than the batch ceiling — split into near-equal chunks
      // so Claude still sees each half as a coherent story.
      const n = Math.ceil(cluster.length / size);
      const chunk = Math.ceil(cluster.length / n);
      for (let i = 0; i < cluster.length; i += chunk) {
        clusterBatches.push(cluster.slice(i, i + chunk));
      }
      continue;
    }
    let placed = false;
    for (const batch of clusterBatches) {
      if (batch.length + cluster.length <= size) {
        batch.push(...cluster);
        placed = true;
        break;
      }
    }
    if (!placed) clusterBatches.push([...cluster]);
  }
  batches.push(...clusterBatches);

  const rr = roundRobinByCountry(singletons);
  for (let i = 0; i < rr.length; i += size) {
    batches.push(rr.slice(i, i + size));
  }

  return batches;
}

// Per-batch existing-thread filter. Scores every active thread against the
// batch's country set + keyword set + global importance baseline, then
// returns the top `limit`. This replaces the old "top 150 by importance"
// window which dropped any extension candidate beyond the first 150 — so a
// Honduras article that should have extended thread #173 ("Central America
// Migration Wave") would spawn a duplicate instead.
function filterThreadsForBatch(batch, allThreads, limit) {
  const batchCountries = new Set(
    batch.map(a => String(a.country_iso || '').toUpperCase()).filter(Boolean)
  );
  const batchKeywords = new Set(
    batch.flatMap(a => (a.keywords || []).map(normalizeKeyword)).filter(Boolean)
  );

  const scored = allThreads.map(t => {
    const threadIsos = [
      ...(Array.isArray(t.primary_nations)   ? t.primary_nations   : []),
      ...(Array.isArray(t.secondary_nations) ? t.secondary_nations : []),
    ].map(s => String(s || '').toUpperCase()).filter(Boolean);
    const threadKws = (t.keywords || []).map(normalizeKeyword);
    let score = 0;
    for (const iso of new Set(threadIsos)) if (batchCountries.has(iso)) score += 3;
    for (const kw of threadKws)            if (batchKeywords.has(kw))  score += 1;
    // Importance baseline (0–3) so top global threads always surface even
    // when a batch has no country overlap with them.
    score += Math.min(3, (Number(t.importance) || 0) / 3);
    return { thread: t, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.thread);
}

// ─── Claude Evaluation ────────────────────────────────────────────────────────

async function evaluateWithClaude(articles, existingThreads) {
  const articleData = articles.map(a => ({
    id:           a.id,
    title:        a.title,
    summary:      (a.translated_summary || a.summary || "").slice(0, 250),
    keywords:     (a.keywords || []).slice(0, 12),
    country:      a.country_name || null,
    city:         a.city_name || null,
    source:       a.source_name || null,
    published_at: a.published_at
  }));

  // Fetch up to 5 sample member articles per candidate thread so Claude can
  // verify NEW articles actually cohere with the thread's existing content
  // (not just the thread's title). Previously Claude only saw the thread's
  // title + 3 keywords, which meant a bloated vibes-titled thread
  // ("African Regional Tensions") became a black hole attracting loosely-
  // related articles forever. Now Claude reads the actual evidence and can
  // also EJECT articles already in a thread that don't belong.
  const candidateThreads = existingThreads.slice(0, 150);
  const threadMembers = await fetchThreadMembers(
    candidateThreads.map(t => Number(t.id)),
    5
  );
  const existingData = candidateThreads.map(t => ({
    id:       t.id,
    title:    t.title,
    cat:      t.primary_category,
    nations:  [
      ...(Array.isArray(t.primary_nations)   ? t.primary_nations   : []),
      ...(Array.isArray(t.secondary_nations) ? t.secondary_nations : []),
    ].slice(0, 6),
    members:  threadMembers.get(Number(t.id)) || [],
  }));

  // Per-call user message — ONLY the variable data. All editorial
  // rules live in THREAD_BATCH_SYSTEM_PROMPT (module-level, byte-
  // identical across calls) so the API caches them and we pay 10%
  // of normal input price for the rules on calls 2+ within a 5-min
  // window. Per-run we have ~15 batch calls within seconds, so all
  // 14 trailing calls hit cache.
  const userPrompt = `EXISTING ACTIVE THREADS (check if any articles extend these).
Each entry shows: id, title, category, nation codes, and a \`members\` sample
(up to 5 of the thread's current articles with title / summary / country).

${JSON.stringify(existingData, null, 2)}

ARTICLES TO ANALYZE:
${JSON.stringify(articleData, null, 2)}

Apply the editorial rules from your system prompt. Return ONLY the JSON array — empty array \`[]\` is acceptable when no articles qualify.`;

  // ──────────────────────────────────────────────────────────────────────
  // TODO(cleanup): delete this dead-code block once we've verified caching
  // is working in production (check Anthropic CSV: cache_read column should
  // populate again after deploy). The text below was moved VERBATIM into
  // THREAD_BATCH_SYSTEM_PROMPT at module scope so prompt caching can hit.
  // ──────────────────────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  const __DEAD_LEGACY_PROMPT_REMOVE_ME = `You are the editor of the BREAKING META-STORY stream of a geopolitical monitoring platform. Your job is NOT to catalogue umbrella arcs (that is handled elsewhere by the Timelines editor). Your job is to surface the STORIES THE WORLD'S PRESS IS COLLECTIVELY FOREGROUNDING RIGHT NOW — the meta-story that emerges from cross-source signal convergence in the last 48 hours.

═══ BREAKING META-STORY DEFINITION ═══
A thread here is a SHARP, RIGHT-NOW story that has broken from a single report into a multi-source moment:
  • Multiple distinct outlets in the dataset are reporting on it
  • Named actors doing named things, with verifiable events and dates
  • It is less than 48 hours old in terms of the peak of its signal
  • It is a CONCRETE event — not a broader arc. If you find yourself reaching for "ongoing tensions" or "long-running dispute," that belongs on Timelines, not here.
  • A thread = the meta-story made from many stories. The picture only makes sense because multiple sources converge on it.

A thread is NOT:
  • A summary of what's happening in one country ("Nepal Government Administrative Announcements")
  • A topic label about a sector ("Vietnam Renewable Energy Investment Surge")
  • A routine government action ("Spain Tax Returns Campaign 2025")
  • A local political squabble ("Polish Political Defamation Dispute")
  • A subnational/regional political event with no global significance ("BJP Foundation Day in Rajasthan", "Chile Regional Cabinet Formation")
  • A commercial/industrial announcement ("ArcelorMittal-Nippon Steel Plant Groundbreaking", "Pamesa Group Launches Gravita Ceramic Technology")
  • A research / science / academic story ("Swedish Cancer Research Breakthroughs")
  • A domestic crime / weather / routine news item ("Italian Crime: Property Theft", "Mexico Weather Crisis Cold Front")
  • A chamber-of-commerce / youth council / business association leadership change
  • A news-of-news meta story ("US Election Coverage and Political Communication Strategy")

═══ REGIONAL ≠ GLOBAL ═══
If the story deals with a country's INTERNAL politics at a REGIONAL / subnational scale — skip it. Regional cabinet formations, state-level party activities, provincial assembly elections, chamber-of-commerce leadership, youth council recruitment — all REJECT. Exceptions: presidential elections, regime changes, coups, major national political shifts with international implications.

═══ GLOBAL-SCALE REGIONAL EVENTS ARE OK ═══
A regional event CAN be a thread if it has global scope:
  • A severe earthquake, flood, or wildfire that triggers international aid
  • An armed conflict or insurgency, even if geographically contained
  • A refugee crisis
  • A major epidemic outbreak
  • A national political shift (regime change, coup, constitutional crisis)
  • A cross-border dispute or incident

═══ MANUFACTURING / COMMERCIAL NEWS ═══
Obscure information about factories, plants, industries, real estate markets, commercial launches, research breakthroughs, and tax campaigns is NOT relevant UNLESS it directly connects to a breaking story at the global level (e.g. a factory destroyed in an airstrike, a steel plant sanctioned by the US, a commercial deal at the center of a trade war). Absent that connection, REJECT.

EXISTING ACTIVE THREADS (check if any articles extend these).
Each entry shows: id, title, category, nation codes, and a \`members\` sample
(up to 5 of the thread's current articles with title / summary / country).
YOU MUST read the members before deciding to extend. Only extend when the
new article belongs alongside those specific members.
You may also EJECT a member you see listed in a thread's \`members\` if it
clearly does not belong with the rest — see EJECT ACTION below.

${JSON.stringify(existingData, null, 2)}

ARTICLES TO ANALYZE:
${JSON.stringify(articleData, null, 2)}

═══ WHAT QUALIFIES AS A THREAD ═══
A thread MUST be about at least one of:
- Armed conflict, military operations, terrorism, insurgency, weapons programs
- Diplomacy, treaties, summits, sanctions, alliances, state-to-state disputes
- Elections, coups, governance crises, protests with political stakes, regime changes
- Cross-border economics with geopolitical weight (trade wars, tariffs, energy supply, currency crises, critical-mineral disputes)
- Espionage, cyberattacks attributable to states, information warfare
- Major natural disasters, disease outbreaks, or humanitarian crises with state-level response
- Border incidents, migration crises, refugee flows
- Named state actors, heads of state, ministers, generals, or geopolitically significant non-state actors (cartels, militias, terror groups)

A thread should name a PLACE, an ACTOR, or a concrete EVENT — not an abstract trend.

═══ HARD REJECT — DO NOT CREATE THREADS FOR ═══
- Lifestyle, tourism, recreation, food, fashion, dating, wellness
- Domestic education trends, student loans, university policy debates, "AI in classrooms"
- Cultural events, festivals, religious holidays, art shows, museum openings, awards
- Entertainment: movies, TV, music, celebrity news, streaming, opera, ballet, symphony, theatre productions
- Sports — UNLESS the story is about state boycotts, doping scandals tied to governments, or athletes being used as political instruments
- Technology product launches, consumer apps, startup funding
- Personal finance, real estate trends, retail/shopping
- Local crime, accidents, weather — unless it triggers a state-level response or has cross-border impact
- Vague abstractions like "social hardship", "youth trends", "community coverage"
- Op-eds, opinion pieces, editorials, "explainer" pieces with no news event
- ROUTINE GOVERNMENT ACTIVITY without a specific event or decision: "Nepal Government Administrative Announcements", "Cyprus Legal System and Governance Challenges", "Country X Policy Developments", "Country Y Regulatory Updates", "Road Safety and Infrastructure Issues", "Health Crisis and Economic Inequality". These are TOPIC LABELS, not stories. If a routine government article is relevant to an existing thread (a named conflict, election, sanctions regime, etc.), ATTACH it to that thread via existing_thread_id. Otherwise OMIT it. Do not create a new thread that just pairs a country name with abstract governance/legal/administrative/infrastructure nouns.

═══ CATEGORY HONESTY ═══
The primary_category enum includes "sports", "entertainment", "culture", and "other" specifically so you can tag off-topic articles HONESTLY. If an article is about an opera house firing a music director, the primary_category is "culture" — NOT "politics". If it's about a football match, the category is "sports" — NOT "politics". The pipeline rejects threads with these tags downstream, but it CAN ONLY do that if you label them honestly. Misclassifying an opera story as "politics" so it slips through is a failure — opera stories should not become threads at all, but if you do produce one, tag it correctly so the filter catches it. Never use "politics" / "economy" / "military" / "diplomacy" / "environment" / "technology" as a junk drawer for things that don't fit those exact domains.

═══ THE SINGLE-COUNTRY-SUMMARY TEST (CRITICAL) ═══
The most common failure mode is creating a thread that is just "a summary of developments from one country without a clear story arc." Examples of titles that MUST be rejected:
  • "Canada Federal Workplace Policy and Urban Infrastructure"
  • "Brazil Political Accountability and Legislative Debates"
  • "Uganda Education and Digital Health Transformation"
  • "Turkey Regional News and Politics"
  • "Nigeria Police Reform and Security Investment"
  • "Rwanda News Broadcasting and National Updates"
  • "Paraguay Economic Reforms Manufacturing Sector"
  • "Nepal Government Administrative Announcements"
  • "Cyprus Legal System and Governance Challenges"

These all share the same shape: [Country] + [Abstract Topic A] + (and) + [Abstract Topic B]. They name no actor, no event, no decision, no date. They are TOPIC LABELS for "stuff happening in country X right now." That is not what this platform indexes.

A thread is a STORY ARC: a specific event or development unfolding over time, with named actors and verifiable actions. Routine government news from a single country is not an arc — at most it should attach to an existing arc (e.g. an ongoing election, an active conflict, an active sanctions regime).

═══ TITLE FORMAT REQUIREMENTS (CRITICAL) ═══
A valid thread title MUST contain at least ONE of:
  • A named person (head of state, minister, general, opposition leader, etc.)
  • A named place beyond just a country (city, region, base, border crossing, strait, waterway)
  • A specific action verb in past or present (strikes, signs, arrests, evacuates, imposes, vetoes, withdraws, votes, launches, invades, seizes, etc.)
  • A specific event noun (coup, election, treaty, ceasefire, airstrike, earthquake, hostage release, indictment, summit, accord, sanction, embargo, etc.)
  • A number (casualty count, vote tally, year, sanctions amount, deadline, etc.)

**Examples of GOOD titles (story-centric):**
  • "Turkey Unveils Long-Range Tayfun Missile Capability"
  • "Russia and China Block UN Hormuz Resolution"
  • "Armenia-Azerbaijan Transit Corridor Opens After Ceasefire"
  • "Israeli Consulate Attacked in Istanbul: Iran Links Suspected"
  • "Poland Demands US Investigation Into Citizen Death in Russian Custody"

**Examples of BAD titles (vague, abstract, no narrative):**
  • "Taiwan Diplomatic Outreach During Regional Tensions" → vague sentiment, no event
  • "Lebanon Political Stability Warning from Aoun" → abstract concern, not an event
  • "Armenia-Azerbaijani Tensions Over Karabakh Region" → too generic; should say WHAT happened (reconciliation, military buildup, etc.)
  • "US-China Space Race Competition Intensifies" → no specific event, no action

If you cannot write a title with story-centric narrative structure, DO NOT create the thread. Return an empty array if necessary.

═══ CROSS-COUNTRY LINKING — ONLY WHEN WARRANTED ═══
Cross-border linking is encouraged WHEN articles actually converge on the SAME underlying event. It is forbidden when they merely share a region, a topic, or a category.

REQUIRED FOR A MERGE (all three must hold):
  1. The articles describe the SAME underlying event, crisis, or bilateral relationship — not two parallel stories that happen to be nearby on a map.
  2. A named actor (specific person, specific organization, or specific named event) recurs across the articles — OR one article is a direct reaction/ripple from the event reported in another (e.g. Country A retaliates against Country B's action; the causal link must be explicit in the text).
  3. A human reading all the articles together would say "yes, same story" — not "yes, both are African", not "yes, both involve a minister".

CORRECT CROSS-BORDER MERGE (one unified narrative):
  • Thread: "Eastern Europe POW Crisis: Poland, Ukraine, Baltics Demand Russian Accountability"
    — All articles reference the same detention incident, same Russian custody chain, same coordinated Polish/Baltic response.

WRONG MERGE (region/topic alone — REJECT):
  • "African Diplomatic Tensions" bundling:
      - Kenyan president mocking Nigeria's Tinubu
      - South Africa suspending its police chief
      - Ghana summoning South African envoy over xenophobia
    These are THREE different stories. Zero shared actors, zero causal links. Africa + "diplomatic" is not a thread. These must be 2-3 separate threads (or some left as singletons if convergence hasn't happened yet).

When deciding whether an article extends an existing thread, READ the \`members\` array shown for that candidate thread. Only extend it if the new article belongs alongside those specific members. Matching the thread's title alone is NOT enough — thread titles drift as they accumulate articles, and you must verify against the actual evidence.

═══ THE TWO-VAGUE-NOUNS TEST ═══
If a proposed title is just "[Place] [Abstract Noun] and [Abstract Noun]" (e.g. "Mexico Health Crisis and Economic Inequality", "Indonesia Industrial Safety and Transportation Incidents") — that is a topic bucket, not a story. Reject it. A real thread title names a concrete event, actor, or decision: "Mexico cartel offensive in Sinaloa", "Indonesia ferry capsizes off Java killing 40", etc.

If an article doesn't fit the inclusion criteria above, OMIT it entirely. Do not invent a thread to hold it. It is correct and expected to return an empty array if none of the articles qualify.

═══ GROUPING RULES ═══
- Group articles that are genuinely about the same ongoing story — even if they use different keywords
- Check existing threads first — strongly prefer extending them over creating duplicates
- Detect semantic connections SQL keyword matching would miss (e.g. "tariffs" + "trade war" + "WTO dispute" = same story)
- A thread should have a sharp, specific title naming the actors/place/event — never a generic category label like "Sports and Entertainment Coverage" or "Higher Education Trends"
- Importance 1-10: 10 = major global event (war, summit, regime change), 7 = significant regional development, 4 = minor but legitimate geopolitical signal, anything below 4 should probably not exist as a thread

Return ONLY a valid JSON array, no explanation. Empty array [] is acceptable and often correct:
[
  {
    "existing_thread_id": null,
    "title": "specific thread title naming actors/place/event (max 8 words)",
    "description": "Two sentences describing the ongoing story and its geopolitical significance.",
    "article_ids": [array of article ids that belong to this thread],
    "anchor_article_id": id of the most representative article,
    "primary_category": "politics|economy|military|diplomacy|environment|technology|sports|entertainment|culture|other",
    "geographic_scope": "global|regional|local",
    "importance": 7,
    "keywords": ["array", "of", "5-10", "core", "keywords"],
    "primary_nations":   ["ISO", "codes", "of", "countries", "central", "to", "this", "story", "— 1-4 entries"],
    "secondary_nations": ["ISO", "codes", "of", "countries", "with", "meaningful", "but", "non-central", "roles", "— 0-6 entries"]
  }
]

═══ NATION TAGGING — EXPLICIT MENTION ONLY ═══
A country goes in primary_nations or secondary_nations ONLY IF it is EXPLICITLY NAMED in the title or summary of at least one constituent article (or in the members of a thread you are extending). Do NOT add countries by inference, geographic proximity, regional affiliation, alliance membership, or "affected economies" hand-wave. If the country isn't literally mentioned in the text you can read, it does NOT go in the array.

primary_nations = the 1-4 ISO 3166-1 alpha-2 country codes most central to the story. Named actors, the site of the event, the state doing the action, the state being acted upon. Example: a US airstrike on Iran → ["US","IR"]. A China-Taiwan summit → ["CN","TW"]. A Hungarian internal election → ["HU"].
secondary_nations = countries with meaningful but NOT central roles that ARE still explicitly mentioned — allies named in the text, transit states named, rhetorical actors named, intermediaries named. Keep this tight. If you can't point to a sentence in the provided articles that names the country, don't include it.
USE CORRECT ISO CODES: United Kingdom = GB (not UK), South Korea = KR, North Korea = KP, United States = US, Russia = RU, Czech Republic = CZ, etc.

═══ EJECT ACTION (remove misfit articles from existing threads) ═══
If a thread's \`members\` array contains an article that clearly does NOT belong with the rest of that thread's members, you may emit an eject entry to remove it. Eject only when you are confident the article was incorrectly grouped — do not eject for minor topical drift or because you'd prefer a different title. Ejected articles simply become unassigned; they will find their proper home in a future run (or stay solo). Do NOT spawn a new thread from ejected articles — just eject them.

Eject entry shape (use INSTEAD OF a normal entry, not in addition):
  { "action": "eject", "thread_id": <existing thread id>, "eject_article_ids": [<ids from that thread's members list>] }

Eject entries count toward the returned array; you can mix them freely with normal new/extend entries.`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    // Bumped from 3072 → 8192 because CLAUDE_BATCH=100 regularly produces
    // JSON arrays that overran the old cap mid-object ("Expected ',' or
    // '}' after property value"). 8192 gives ~6× the old headroom.
    max_tokens: 8192,
    // System prompt = static editorial rules (THREAD_BATCH_SYSTEM_PROMPT,
    // module-level, byte-identical across calls) marked cacheable so
    // calls 2+ in this run pay $0.10/M instead of $1/M for the prefix.
    // Empirically (Apr 19–22 in usage CSV) this drops Haiku input cost
    // ~85% which translated to ~$13/day savings.
    system: [
      {
        type: 'text',
        text: THREAD_BATCH_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages:   [{ role: "user", content: userPrompt }]
  });

  const text = response.content[0].text.trim();
  return parseClaudeJsonArray(text);
}

// Resilient JSON array parser for Claude responses. Handles:
//   • Wrapping commentary / code fences / trailing prose
//   • Truncated responses where max_tokens cut the tail mid-object —
//     we walk the bracket depth and keep only complete top-level objects,
//     so a batch that returns 15 good defs + a half-finished 16th still
//     persists the 15.
function parseClaudeJsonArray(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  // Strip code-fence wrappers if present.
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Fast path: whole response is a valid array.
  try {
    const parsed = JSON.parse(unfenced);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}

  // Locate the opening [ of the array. Anything before it is prose.
  const startIdx = unfenced.indexOf('[');
  if (startIdx < 0) {
    throw new Error(`No JSON array in Claude response: ${unfenced.slice(0, 200)}`);
  }

  // EMPTY-ARRAY fast path: the response contains an "[]" but the walker
  // would otherwise treat a legitimate empty array as unparseable. Claude
  // returns [] when it correctly sees no threadable stories in the batch
  // — that's a success case (no error), not a parse failure.
  // Look for a bare [] at the top level, tolerating whitespace between
  // brackets and any trailing prose Claude may have appended.
  const emptyMatch = unfenced.slice(startIdx).match(/^\[\s*\]/);
  if (emptyMatch) return [];

  // Walk forward character-by-character, respecting string literals and
  // escape sequences, to find every top-level object boundary. At each
  // complete {...} at depth 1, attempt to JSON.parse it and collect.
  const out = [];
  let depth = 0;       // bracket depth, counting the outer [ as 1
  let objStart = -1;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"')  { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') { depth++; continue; }
    if (ch === '{') {
      if (depth === 1 && objStart < 0) objStart = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 1 && objStart >= 0) {
        const slice = unfenced.slice(objStart, i + 1);
        try { out.push(JSON.parse(slice)); } catch (_) { /* skip malformed object */ }
        objStart = -1;
      }
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }

  if (!out.length) {
    throw new Error(`Could not recover any JSON objects from Claude response: ${unfenced.slice(0, 200)}`);
  }
  return out;
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persistThreadDefs(defs, validIdSet, existingThreadMap = new Map()) {
  let created = 0, updated = 0;
  const refreshIds = new Set();
  // IDs created or updated in this call — exported so the caller can pass
  // them to the scoped Claude dedup pass at end-of-run. Used to keep dedup
  // Claude cost bounded to the threads that actually changed this cron.
  const touchedIds = new Set();

  // Hard reject categories that don't belong on a geopolitical platform.
  // Acts as a server-side safety net in case Claude ignores the prompt rules.
  // The prompt enum includes 'sports'/'entertainment'/'culture'/'other' so
  // Claude can self-tag off-topic articles honestly; we hard-reject those
  // tags here. If the prompt enum tightens, drop them from this set too.
  const ALLOWED_CATEGORIES = new Set([
    'politics','economy','military','diplomacy','environment','technology'
  ]);
  // Off-topic categories — Claude is encouraged to use these for articles
  // that don't fit the geopolitical surface. Threads with these tags are
  // ALWAYS rejected. Better to have Claude tag honestly and us reject than
  // to have Claude misclassify as 'politics' so it slips through.
  const REJECTED_CATEGORIES = new Set([
    'sports','entertainment','culture','other','lifestyle','arts','religion'
  ]);
  // Title-level junk filter — catches the abstract/lifestyle/fluff titles
  // the prompt is supposed to reject. Lower-cased substring match.
  const JUNK_TITLE_PATTERNS = [
    /\bstudent\b.*\b(financial|hardship|loan|debt)\b/i,
    /\b(higher|secondary|primary)\s+education\b/i,
    /\btourism\b/i,
    /\brecreation\b/i,
    /\bcultural\s+(event|festival|celebration)/i,
    /\bfestival\b/i,
    /\b(lifestyle|wellness|food|fashion|dating|shopping|retail)\b/i,
    /\bentertainment\s+(coverage|news|industry)\b/i,
    /\b(sports|entertainment|lifestyle|culture|arts)\s+and\s+(sports|entertainment|lifestyle|culture|arts|society|business)\b/i,
    /\b(celebrity|movie|film|tv|streaming|album|concert)\b/i,
    /\b(general|various|miscellaneous|other)\s+(coverage|news|topics|updates)\b/i,
    /\bcoverage\s+(roundup|recap|digest|hub)\b/i,
    /^\s*(general|various|miscellaneous|other)\b/i,
    // Vague administrative / governance non-stories. Government routine
    // announcements should attach to existing geopolitical threads when
    // relevant — they should never spawn their own thread.
    /\badministrative\s+(announcements|updates|matters|affairs|notices|developments)\b/i,
    /\bgovernance\s+(challenges|issues|topics|matters|developments|updates|concerns)\b/i,
    /\blegal\s+system\s+(and|challenges|issues|developments|updates|reform)\b/i,
    /\bjudicial\s+(system|developments|updates|matters)\b/i,
    /\bregulatory\s+(updates|developments|landscape|environment|matters)\b/i,
    /\bpolicy\s+(developments|updates|landscape|matters|discussions|debates)\b/i,
    /\b(bureaucratic|institutional)\s+(reform|reforms|challenges|updates)\b/i,
    /\bpublic\s+(administration|sector)\s+(updates|reforms|challenges|developments)\b/i,
    /\bcivil\s+service\s+(reform|updates|matters)\b/i,
    /\binfrastructure\s+(issues|challenges|concerns|topics|matters)\b/i,
    /\b(road|transportation|transport)\s+safety\s+(crisis|issues|concerns|matters)\b/i,
    /\beconomic\s+(inequality|challenges|concerns|topics|matters|conditions)\b/i,
    /\bhealth\s+(crisis|concerns|challenges|topics|matters|issues)\s+and\b/i,
    /\b(industrial|workplace)\s+safety\s+(and|incidents|concerns|matters)\b/i,
    /\b(challenges|issues|developments|updates|concerns|matters|trends|reforms|topics)\s+and\s+(challenges|issues|developments|updates|concerns|matters|trends|reforms|topics|governance|administration|policy|reform)\b/i,
    /\b(governance|administration|legal|judicial|regulatory|policy|bureaucratic)\s+(and|&)\s+(governance|administration|legal|judicial|regulatory|policy|bureaucratic|challenges|issues|reforms|developments|updates)\b/i,
    /\breligious\s+(observances|celebrations|holidays|practices)\b/i,
    /\bglobal\s+celebrations\b/i,
    /\bpractical\s+observances\b/i,
    /\bweather\s+(updates|patterns|conditions|forecast)\b/i,
    /\bdaily\s+(news|updates|roundup|briefing)\b/i,
    /\b(news|coverage)\s+(briefs|brief|wrap|wrapup|wrap-up)\b/i,
    // Regional / subnational politics
    /\b(foundation|party|anniversary)\s+day\s+(celebration|celebrations)\b/i,
    /\b(cabinet|government)\s+(formation|reshuffle|reshuffling|reshuffles)\b/i,
    /\b(leadership|chamber|council|committee|board)\s+(election|appointment|appointments|selection|recruitment)\b/i,
    /\bchamber\s+of\s+commerce\b/i,
    /\b(youth|provincial|regional|municipal|district|local|village|town|county)\s+(council|assembly|committee|board)\b/i,
    /\bgovernment\s+leadership\s+(appointments?|changes?|reshuffle)\b/i,
    /\bregional\s+cabinet\b/i,
    /\bdefamation\s+(dispute|case|lawsuit|suit|charges?)\b/i,
    // Routine government administration
    /\b(license|permit|passport|visa)\s+(processing|issuance|applications?|renewal)\b/i,
    /\b(recruitment|hiring)\s+(announcement|drive|campaign|notice)\b/i,
    /\bpersonnel\s+(meetings?|changes?|announcements?|updates?)\b/i,
    /\btax\s+(returns?|filing|season|campaign)\s+(campaign|opens?|opening|deadline|filing|begins?)/i,
    /\btax\s+(returns?|filing)\b/i,
    /\b(transport|transportation)\s+department\b/i,
    /\b(ministry|department)\s+(personnel|operations|activities|meetings?|announcements?)\b/i,
    // Commercial / industrial / factory
    /\b(plant|factory|mill|refinery|smelter)\s+(opens?|opening|launches?|launched|development|expansion|groundbreaking|inauguration|construction)\b/i,
    /\bgroundbreaking\b/i,
    /\b(steel|cement|ceramic|textile|glass|aluminum|copper|plastic)\s+(plant|industry|mill|market|technology|sector|factory)\b/i,
    /\brenewable\s+energy\s+(investment|surge|growth|expansion)\b/i,
    /\bmanufacturing\s+(sector|plant|expansion|growth|investment|boom)\b/i,
    /\b(real\s+estate|property)\s+(market|guidance|prices|listings)\b/i,
    /\bprice\s+controls?\b/i,
    /\bmarket\s+liberalization\b/i,
    /\b(group|company|corporation|corp|ltd|inc)\s+launches?\b/i,
    /\blaunches?\s+(product|technology|platform|service|app|brand|ceramic|steel|cement)\b/i,
    /\bindustry\s+(expansion|growth|development|investment)\b/i,
    // Research / science / academic
    /\b(research|scientific|medical|academic)\s+(breakthrough|breakthroughs|funding|grants?|awards?)\b/i,
    /\b(cancer|viral|medical|clinical|biomedical)\s+research\b/i,
    /\bresearch\s+funding\s+awards?\b/i,
    // Domestic crime / violations
    /\b(crime|theft|robbery|burglary|fraud)\s*:/i,
    /\b(property|petty)\s+(theft|crime)\b/i,
    /\bhouse\s+arrest\s+violations?\b/i,
    // Weather
    /\b(weather\s+crisis|cold\s+front|severe\s+(weather|conditions|storm|cold)|heat\s+wave|rain\s+forecast)\b/i,
    // News-of-news / coverage meta
    /\b(communication|campaign|political|election)\s+strategy\b/i,
    /\belection\s+coverage\b/i,
    /\bnews\s+(update|updates|headlines|briefing|briefings|roundup|recap|digest)\b/i,
    /\bheadlines?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
    // Vague "resilience / engagement / presence"
    /\b(economic|political|social|regional)\s+resilience\b/i,
    /\bamid\s+(global|regional)\s+(tensions?|challenges?|uncertainty|pressure)\b/i,
    /\bdiplomatic\s+(engagement|presence|activities|initiatives|outreach)\b/i,
    /\breconstruction\s+and\s+(international|diplomatic|foreign)\b/i,
    // Routine maritime / inspection
    /\b(maritime|port|harbor|airport|border)\s+(authority|agency)\s+(inspection|inspections|operations|activities)\b/i,
    /\b(boat|vessel|ship|vehicle|customs)\s+inspections?\b/i,
    // ── Performing arts / classical music / theatre ──────────────────
    // The "Venice's La Fenice Opera Ousts Incoming Music Director"
    // class — concrete verb + opera house was slipping through every
    // gate. These reject the domain regardless of verb. Tightened
    // through a real-DB false-positive sweep: dropped overly-broad
    // tokens like "ceremony"/"gala"/"single"/"finals" that were
    // catching government inauguration ceremonies, "Single Window"
    // trade reforms, and electoral "final registry update" headlines.
    /\b(opera|symphony|philharmonic|orchestra|ballet|chamber\s+(orchestra|music)|conservatory)\b/i,
    /\b(music\s+director|conductor|maestro|soprano|tenor|baritone|mezzo[-\s]?soprano|virtuoso)\b/i,
    /\b(la\s+scala|met\s+opera|metropolitan\s+opera|covent\s+garden|royal\s+opera|paris\s+opera|vienna\s+state\s+opera|bolshoi|mariinsky|glyndebourne|salzburg\s+festival|bayreuth)\b/i,
    /\b(broadway|west\s+end|playhouse)\b/i,
    /\btheatre?\s+(production|company|festival)\b/i,
    // ── Sports — leagues, tournaments, named competitions ────────────
    // FIFA/UEFA/World Cup/Olympics removed: those frequently appear in
    // GEOPOLITICAL stories (Trump pressuring FIFA over Iran, host-state
    // boycotts, doping scandals tied to states). The prompt rule says
    // "sports UNLESS state-level political angle" — when geopolitics
    // is the lens, the thread should stand. The narrower league set
    // below catches club-level sports stories that are rarely
    // geopolitical.
    /\b(nfl|nba|nhl|mlb|wnba|mls|epl|premier\s+league|la\s+liga|bundesliga|serie\s+a|ligue\s+1)\b/i,
    /\b(wimbledon|french\s+open|australian\s+open|the\s+masters|ryder\s+cup|tour\s+de\s+france|giro\s+d'italia|formula\s*1|formula\s*one|nascar|indycar|moto\s*gp)\b/i,
    /\b(boxing\s+match|boxing\s+title|wrestling\s+match|mma\s+(fight|bout)|ufc\s+\d+)\b/i,
    /\b(athletes?|sportsmen|sportswomen|football|soccer|basketball|baseball|cricket|tennis|rugby|hockey|golf)\s+(stars?|legend|legends|icon|icons)\b/i,
    /\b(coach|head\s+coach|striker|goalkeeper|quarterback|pitcher|midfielder|defender)\s+(fired|hired|signed|signs|sacks?|sacked|resigns?|resigned|retires?|retired|traded)\b/i,
    /\b(transfer\s+window|free\s+agent|draft\s+pick|player\s+(transfer|trade|signing))\b/i,
    // Unambiguous sports team names. Bare city-named clubs (Manchester,
    // Liverpool, Chelsea, Arsenal, Barcelona, Tottenham) were dropped
    // because they triggered on (a) city stories — economy / planning /
    // weather — and (b) "arsenal" the noun (e.g. "US weapons arsenal",
    // "Iran arsenal depleted"). Keeps unambiguous compound names only.
    /\b(real\s+madrid|fc\s+barcelona|manchester\s+(united|city)|paris\s+saint[-\s]?germain|borussia\s+dortmund|atletico\s+madrid|bayern\s+munich|76ers|los\s+angeles\s+lakers|boston\s+celtics|new\s+york\s+yankees|new\s+england\s+patriots|dallas\s+cowboys|golden\s+state\s+warriors|los\s+angeles\s+dodgers)\b/i,
    /\b(greek\s+cup|fa\s+cup|copa\s+del\s+rey|coppa\s+italia|dfb[-\s]?pokal|euroleague|el\s+clasico|el\s+clásico)\b/i,
    // ── Film / TV / streaming / music industry ───────────────────────
    /\b(box\s+office|opening\s+weekend|streaming\s+(release|premiere|debut)|tv\s+(premiere|finale|series\s+finale)|season\s+(premiere|finale))\b/i,
    // Awards. Bare "Oscar"/"Tony"/"Emmy"/"Grammy" are common first names
    // (Tony Elumelu, Oscar-winning Russian dissident filmmaker, etc.) so
    // require unambiguous award context: plural ("Oscars"), suffixed
    // ("oscar-winning"), or the literal phrase ("Tony Award").
    // Awards. Bare *-winning forms (oscar-winning, emmy-winning) were
    // dropped — they appear as descriptive adjectives in legitimate
    // geopolitical stories ("Russia Labels Oscar-Winning Documentary
    // Filmmaker Foreign Agent" is a censorship story, not an
    // entertainment story). Now requires unambiguous award context:
    // plural ("Oscars", "Tonys"), or "X Award" / "X Ceremony" /
    // "X Nominations" / explicit festival name.
    /\b(grammys?\s+award|grammys\b|oscars\b|oscar\s+(award|nominee|nomination|ceremony)|tonys\b|tony[-\s]?award|tony\s+(award|nomination|ceremony)|emmys\b|emmy\s+award|baftas?\s+award|baftas\b|golden\s+globes?|cannes\s+(film\s+)?festival|venice\s+film\s+festival|berlin\s+film\s+festival|sundance\s+film|toronto\s+international\s+film)\b/i,
    // "billboard 100" / "billboard hot 100" — but not "billboard ad campaign"
    /\b(billboard\s+(hot\s+)?(100|200)|chart[-\s]?topping\s+(hit|single|album)|debut\s+album|number[-\s]?one\s+(hit|single))\b/i,
    /\b(biopic|netflix\s+(series|show|original)|hbo\s+(series|show)|disney\+\s+series|amazon\s+prime\s+(series|show)|apple\s+tv\+)\b/i,
    /\b(actor|actress)\s+(stars?\s+in|cast\s+(in|as)|starring\s+as|debut\s+role|signs\s+on)\b/i,
    /\bred\s+carpet|premiere\s+night\b/i,
    /\b(celebrity|paparazzi|fan[-\s]?meet)\b/i,
    /\b(reality\s+(tv|show)|talent\s+show|game\s+show|sitcom)\b/i,
  ];
  // Structural "topic bucket" detector — catches single-country summary
  // titles with no concrete event, like "Brazil Political Accountability
  // and Legislative Debates" or "Uganda Education and Digital Health
  // Transformation". These are topic labels, not stories.
  const ABSTRACT_TOPIC_NOUNS = new Set([
    "policy","policies","politics","governance","administration","administrative","reform","reforms",
    "regulation","regulations","regulatory","legislation","legislative","legal","judicial",
    "bureaucratic","institutional","accountability","transparency","oversight",
    "transformation","modernization","digitalization","reorganization","restructuring",
    "sector","sectors","industry","industries","manufacturing","agriculture","mining",
    "fishing","forestry","construction","banking","finance","financial","commerce",
    "trade","tourism","education","healthcare","health","welfare","housing",
    "infrastructure","transportation","transport","logistics","telecommunications",
    "broadcasting","media","technology","technological","digital","innovation",
    "developments","development","challenges","challenge","issues","issue","concerns",
    "concern","matters","trends","trend","topics","topic","updates","update","affairs",
    "coverage","news","reports","reporting","investment","investments","initiative",
    "initiatives","program","programs","projects","project","strategy","strategies",
    "framework","frameworks","priorities","priority","agenda","agendas","activities",
    "operations","situation","conditions","environment","landscape","outlook","overview",
    "summary","status","progress","perspective","context","background",
    "debate","debates","discussion","discussions","dialogue","consultation","review",
    "assessment","analysis","focus","attention","emphasis","approach","approaches",
    "inequality","poverty","unemployment","employment","labor","labour","workplace",
    "workforce","wages","welfare","wellbeing","sustainability","climate",
    "energy","security","safety","defense","defence","intelligence","cybersecurity",
    "diplomacy","relations","cooperation","integration","corruption",
    "federal","national","regional","local","urban","rural","domestic","public","civil",
    "social","community","societal","cultural","economic","political","industrial",
    "commercial","financial","educational","environmental","institutional","strategic",
    "operational","constitutional","democratic","municipal","provincial","state",
    "ministerial","governmental","parliamentary","executive","ongoing","general","various",
    "resilience","dispute","disputes","formation","presence","engagement","engagements",
    "surge","surges","guidance","recruitment","appointments","appointment","headlines",
    "celebrations","celebration","processing","returns","campaign","campaigns","controls",
    "control","prices","price","liberalization","breakthrough","breakthroughs","awards",
    "funding","grants","grant","inspection","inspections","reconstruction","meetings",
    "personnel","licensing","license","licenses","crime","crimes","theft","thefts",
    "violations","violation","weather","forecast","conditions","severe",
    "cold","warm","front","fronts","market","markets","cement","steel","ceramic",
    "manufacturing","factory","factories","plant","plants","expansion","expansions",
    "groundbreaking","inauguration","product","products","platform","service","research",
    "science","scientific","cancer","viral","medical","clinical","academic","chamber",
    "commerce","council","councils","authority","authorities","ministry","department",
    "departments","tax","taxes","filing","filings","boat","boats","vessel","vessels",
    "maritime","port","ports",
  ]);
  const CONCRETE_SIGNAL_RE = new RegExp([
    String.raw`\d`,
    String.raw`\b(killed|kills|kill|dies|died|dead|injured|wounded|attacks?|attacked|strikes?|struck|bombed|shot|shoots?|arrests?|arrested|elected|fired|resigns?|resigned|signed|signs?|launched|launches?|invaded|invades?|seized|seizes?|captured|captures?|sanctioned|imposed|imposes?|raids?|raided|protests?|protested|votes?|voted|wins?|won|loses?|lost|meets?|met|visits?|visited|announced|announces?|declared|declares?|approved|approves?|rejected|rejects?|condemned|condemns?|denounced|denies|denied|calls?|called|orders?|ordered|halts?|halted|suspends?|suspended|releases?|released|frees?|freed|expels?|expelled|deports?|deported|evacuates?|evacuated|destroyed|destroys?|crashes?|crashed|erupts?|erupted|hits?|hit|topples?|toppled|ousts?|ousted|deploys?|deployed|withdraws?|withdrew|escalates?|escalated|threatens?|threatened|warns?|warned|sues?|sued|charges?|charged|indicts?|indicted|jails?|jailed|negotiates?|negotiated|brokers?|brokered|ratifies?|ratified|vetoes?|vetoed|invokes?|invoked|files?|filed|reveals?|revealed|revealing|exposes?|exposed|leaked|leaks?|uncovered|uncovers?|ambushed|ambush|intercepts?|intercepted|forge|forges|forged|forging|pledges?|pledged|endorses?|endorsed|hails?|hailed|unveils?|unveiled|scraps?|scrapped|backs|backed|welcomes?|welcomed|greenlights?|greenlit|rejects?|boycotts?|boycotted|recalls?|recalled)\b`,
    String.raw`\b(president|prime\s+minister|minister|chancellor|king|queen|sultan|emir|general|admiral|colonel|ambassador|envoy|spokesperson|secretary|premier|governor|senator|deputy|mp|congressman|congresswoman)\b`,
    // Concrete state / security / paramilitary actors. These are always
    // event-bearing when they appear in a headline, regardless of any
    // abstract nouns also present (e.g. "CIA Operations" is about the CIA,
    // not the abstract concept "operations").
    String.raw`\b(cia|fbi|nsa|dhs|mossad|kgb|fsb|gru|mi5|mi6|gchq|isi|ra[wa]|sbu|idf|ira|eta|farc|hezbollah|hamas|isis|isil|daesh|taliban|houthis?|boko\s+haram|wagner|mujahideen|interpol|europol|unsc|nato|un|eu|opec|cartel|cartels)\b`,
    String.raw`\b(coup|war|invasion|airstrike|missile|drone|ceasefire|treaty|summit|election|referendum|sanctions|tariff|tariffs|protest|riot|earthquake|tsunami|wildfire|flood|hurricane|cyclone|outbreak|epidemic|pandemic|hostage|kidnap|kidnapped|shooting|massacre|assassination|raid|blockade|embargo|deal|accord|pact|verdict|ruling|indictment|impeachment|crash|explosion|attack|strike|offensive|withdrawal|retreat|surge|breakthrough|deadlock|ambush|ambushes|ambushed|partnership|alliance|coalition|memorandum|mou|visit|visits|delegation|delegations|summits|talks|negotiation|negotiations|bilateral|trilateral|multilateral)\b`
  ].join('|'), 'i');
  function looksLikeTopicBucket(title) {
    if (!title) return false;
    if (CONCRETE_SIGNAL_RE.test(title)) return false;
    const tokens = String(title).toLowerCase().replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.length < 3) return false;
    let abstractCount = 0;
    for (const tok of tokens) {
      if (ABSTRACT_TOPIC_NOUNS.has(tok)) abstractCount++;
    }
    if (abstractCount >= 2) return true;
    if (abstractCount >= 1 && /\b(and|&)\b/i.test(title)) return true;
    if (tokens.length <= 6 && abstractCount / tokens.length >= 0.4) return true;
    return false;
  }
  function isJunkThreadDef(def) {
    const cat = String(def.primary_category || '').toLowerCase();
    // Off-topic categories: Claude tagged this honestly as sports /
    // entertainment / culture / other — reject. The prompt explicitly
    // tells Claude these tags will be filtered, and that misclassifying
    // such articles as "politics" so they slip through is a worse
    // failure mode than honest tagging.
    if (cat && REJECTED_CATEGORIES.has(cat)) return `off-topic-category=${cat}`;
    if (cat && !ALLOWED_CATEGORIES.has(cat)) return `category=${cat}`;
    const title = String(def.title || '');
    for (const re of JUNK_TITLE_PATTERNS) {
      if (re.test(title)) return `title-pattern:${re.source.slice(0,40)}`;
    }
    if (looksLikeTopicBucket(title)) return `topic-bucket`;
    return null;
  }

  for (const def of defs) {
    // Handle EJECT entries: Claude flags articles in an existing thread's
    // members list that don't belong. We delete those links only (article
    // stays in news_articles; thread keeps its remaining members). Ejected
    // articles become unassigned and will be re-evaluated next run. We do
    // NOT spawn a new thread from ejected articles — that's how parallel
    // duplicates get created. If the thread loses all its members here,
    // coolDownInactiveThreads at end-of-run will deactivate it naturally.
    if (def && def.action === 'eject') {
      const threadId = Number(def.thread_id);
      const ejectIds = Array.isArray(def.eject_article_ids)
        ? def.eject_article_ids.map(Number).filter(Number.isFinite)
        : [];
      if (!threadId || !existingThreadMap.has(threadId) || !ejectIds.length) continue;
      try {
        const result = await pool.query(`
          DELETE FROM story_thread_articles
           WHERE thread_id = $1 AND article_id = ANY($2::int[])
        `, [threadId, ejectIds]);
        if (result.rowCount > 0) {
          // Tombstone the ejected pairs so the next builder run cannot
          // re-cluster them back into THIS thread. Without this row,
          // Claude in a future batch would see the article in the
          // unthreaded pool, see thread X among candidates, and could
          // extend X with the article — undoing the eject we just made.
          // ON CONFLICT keeps the insert idempotent if Claude ejects
          // the same article twice across runs. Reason capped at
          // 200 char so a verbose Claude justification doesn't bloat
          // the table.
          const ejectReason = (def.reason || '').slice(0, 200) || null;
          for (const aid of ejectIds) {
            try {
              await pool.query(
                `INSERT INTO story_thread_article_ejections
                       (thread_id, article_id, source, reason)
                  VALUES ($1, $2, 'eject_action', $3)
                  ON CONFLICT (thread_id, article_id) DO NOTHING`,
                [threadId, aid, ejectReason]
              );
            } catch (err) {
              console.warn(`   ⚠ tombstone insert failed (thread=${threadId} article=${aid}): ${err.message}`);
            }
          }
          // Eject = remove article(s) from a thread. NOT an article-add,
          // so we don't bump last_updated_at (which would falsely keep
          // the thread "fresh"). article_count is recomputed from the
          // junction table because ejection invalidates the stored count.
          await pool.query(`
            UPDATE story_threads
               SET article_count = GREATEST(0, (
                     SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1
                   ))
             WHERE id = $1
          `, [threadId]);
          await recomputeBreakingSignal(threadId).catch(() => {});
          console.log(`   ✂ Ejected ${result.rowCount} article(s) from thread ${threadId} "${def.reason || ''}"`);
          touchedIds.add(threadId);
        }
      } catch (err) {
        console.warn(`   ⚠ Eject failed for thread ${threadId}: ${err.message}`);
      }
      continue;
    }

    if (!def.article_ids?.length) continue;

    // Only reject NEW threads — never block extensions of existing threads,
    // since those decisions were already made.
    if (!def.existing_thread_id) {
      const reason = isJunkThreadDef(def);
      if (reason) {
        console.log(`   🚫 Rejected non-geopolitical thread "${def.title}" (${reason})`);
        continue;
      }

      // ── Frankenstein guard ───────────────────────────────────────
      // A real story has a focused geographic scope. A thread with more
      // nations than articles is almost always a transitive sqlCluster
      // chain that bundled unrelated stories under one umbrella (the
      // canonical case: thread #8851 with 16 articles + 13 nations
      // that fused Meta layoffs + Warner-Paramount merger + Haiti
      // military + South Africa xenophobia under "Meta Layoffs Spark
      // Regional Xenophobic Violence").
      //
      // Production stats showed the boundary cleanly:
      //   - real high-coverage threads always have far more articles
      //     than nations (1298 articles / 29 nations, 1244 articles /
      //     18 nations — easily passing).
      //   - frankensteins all looked like 3-16 articles / 9-29 nations
      //     because Claude was asked to label a heterogeneous bundle.
      // The (>5 nations AND nations > articles) rule rejects the latter
      // without catching real wide-scope stories.
      const totalNations = sanitizeIsos(def.primary_nations).length
                         + sanitizeIsos(def.secondary_nations).length;
      if (totalNations > 5 && totalNations > def.article_ids.length) {
        console.log(
          `   🚫 Rejected suspected frankenstein "${def.title}" ` +
          `(${totalNations} nations / ${def.article_ids.length} articles — ` +
          `nation count exceeds article count)`
        );
        continue;
      }
    }

    try {
      if (def.existing_thread_id) {
        const threadId = Number(def.existing_thread_id);
        // Guard against Claude hallucinating a dead thread id. If the
        // referenced thread isn't in the active map we loaded from Postgres
        // at the top of the run, reroute the def as NEW — otherwise the
        // UPDATE below silently no-ops and insertArticles FK-violates.
        if (!existingThreadMap.has(threadId)) {
          console.log(`   ⚠ Claude referenced unknown thread id ${threadId} for "${def.title}" — routing as NEW`);
          def.existing_thread_id = null;
          // Fall through to the "else" branch by re-entering the loop
          // iteration. Easiest way without restructuring: duplicate the
          // NEW-thread path inline below.
        }
      }

      if (def.existing_thread_id) {
        const threadId = Number(def.existing_thread_id);
        const current = existingThreadMap.get(threadId);
        if (shouldRefreshThreadContext(current, def.keywords || [])) {
          refreshIds.add(threadId);
        }

        // Update existing thread. Keywords still grow via SQL union (they're
        // a free-form bag). Nations are NOT unioned anymore — that pattern
        // ballooned primary_nations to 7-22 entries with hallucinated
        // countries (Iran on Sinaloa threads, EU everywhere). Instead we
        // INSERT the new articles first, then call recomputeNationsForItem
        // below which derives primary/secondary from article_locations
        // ground truth and caps at PRIMARY_CAP (4) / SECONDARY_CAP (12).
        await pool.query(`
          UPDATE story_threads
          SET last_updated_at = NOW(),
              importance      = GREATEST(importance, $1),
              article_count   = article_count + $2,
              keywords        = (
                SELECT ARRAY(SELECT DISTINCT unnest(keywords || $3::text[]))
              )
          WHERE id = $4
        `, [def.importance, def.article_ids.length, def.keywords || [], threadId]);

        await insertArticles(threadId, def.article_ids, def.anchor_article_id, def.importance, validIdSet);
        await recomputeBreakingSignal(threadId);
        await recomputeAndPersistNations(threadId);
        if (current) {
          existingThreadMap.set(threadId, {
            ...current,
            importance: Math.max(Number(current.importance) || 0, Number(def.importance) || 0),
            article_count: (Number(current.article_count) || 0) + def.article_ids.length,
            keywords: mergeKeywords(current.keywords || [], def.keywords || []),
            last_updated_at: new Date().toISOString()
          });
        }
        updated++;
        touchedIds.add(threadId);
      } else {
        // Create new thread — persist Claude's nation tags up-front so the
        // thread is regionally scoped from birth. Previously the INSERT
        // omitted primary/secondary_nations entirely, so every new thread
        // started with NULL and only a minority got back-filled later by
        // deep enrichment. Visible symptom: new threads rendered with no
        // country badges in the UI.
        // enforceDisjointAndCapped: Claude regularly returns the same ISO
        // in both primary AND secondary (e.g. primary=[IR,US], secondary=
        // [US,IL]). The plain sanitizeIsos call only deduped within each
        // array, not between them. Using the shared helper ensures
        // primary wins, secondary is the disjoint remainder, and both
        // respect the caps (4 / 12).
        const { primary: primaryIsos, secondary: secondaryIsos } =
          enforceDisjointAndCapped(def.primary_nations, def.secondary_nations);
        const { rows } = await pool.query(`
          INSERT INTO story_threads
            (title, description, primary_category, geographic_scope,
             importance, keywords, article_count,
             primary_nations, secondary_nations)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `, [
          def.title,
          def.description,
          def.primary_category || "politics",
          def.geographic_scope || "global",
          def.importance       || 5,
          def.keywords         || [],
          def.article_ids.length,
          primaryIsos,
          secondaryIsos,
        ]);

        const threadId = rows[0].id;
        await insertArticles(threadId, def.article_ids, def.anchor_article_id, def.importance, validIdSet);
        await recomputeBreakingSignal(threadId);
        existingThreadMap.set(Number(threadId), {
          id: Number(threadId),
          title: def.title,
          description: def.description,
          primary_category: def.primary_category || "politics",
          geographic_scope: def.geographic_scope || "global",
          importance: def.importance || 5,
          keywords: def.keywords || [],
          article_count: def.article_ids.length,
          primary_nations: primaryIsos,
          secondary_nations: secondaryIsos,
        });
        created++;
        touchedIds.add(Number(threadId));
      }
    } catch (err) {
      console.error(`   ⚠ Failed to persist thread "${def.title}": ${err.message}`);
    }
  }

  return { c: created, u: updated, refreshIds: [...refreshIds], touchedIds: [...touchedIds] };
}

async function insertArticles(threadId, articleIds, anchorId, importance, validIdSet) {
  const filteredIds = articleIds
    .map(id => Number(id))
    .filter(id => !validIdSet || validIdSet.has(id));
  if (!filteredIds.length) return;

  // Tombstone gate — skip any (threadId, articleId) pair that was
  // previously ejected via the audit cron OR via the in-prompt
  // EJECT action below. Without this, articles freshly detached by
  // auditThreadArticles.js go back into the unthreaded pool and can
  // re-cluster into the same thread on the next 30-min builder cycle,
  // turning the audit into a Haiku-billed treadmill. Schema:
  // migrations/20260430_story_thread_article_ejections.sql
  let tombstonedSet = new Set();
  try {
    const { rows: ej } = await pool.query(
      `SELECT article_id FROM story_thread_article_ejections
        WHERE thread_id = $1 AND article_id = ANY($2::int[])`,
      [threadId, filteredIds]
    );
    tombstonedSet = new Set(ej.map(r => Number(r.article_id)));
    if (tombstonedSet.size) {
      console.log(`   🪦 thread=${threadId} skipping ${tombstonedSet.size} tombstoned article(s) at attach time`);
    }
  } catch (err) {
    // Tombstone lookup failure shouldn't block thread building. Worst
    // case: a previously-ejected article re-attaches; the next audit
    // run will catch + re-tombstone it. Log and proceed.
    console.warn(`   ⚠ tombstone lookup failed (thread=${threadId}): ${err.message}`);
  }

  const { rows } = await pool.query(`
    SELECT id, published_at
    FROM news_articles
    WHERE id = ANY($1::int[])
  `, [filteredIds]);

  const publishedAtMap = new Map(rows.map(r => [Number(r.id), r.published_at]));
  for (const articleId of articleIds) {
    const numericId = Number(articleId);
    if (validIdSet && !validIdSet.has(numericId)) continue;
    if (tombstonedSet.has(numericId)) continue;
    const publishedAt = publishedAtMap.get(numericId);
    const score = computeArticleRelevanceScore(importance, publishedAt);
    await pool.query(`
      INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [threadId, numericId, score, numericId === Number(anchorId)]);
  }
}

// Cross-source signal convergence: recompute distinct_source_count and
// breaking_signal_score for a single thread. Score formula:
//   breaking_signal_score = distinct_sources_24h * recency_factor * avg_base_priority
// where recency_factor decays from 1.0 (fresh) toward 0.2 over 48h. Threads
// with distinct_sources_24h < MIN_SOURCES_FOR_BREAKING still persist but
// are flagged low-signal; the /api/threads/latest ranking weights by score.
async function recomputeBreakingSignal(threadId) {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id)) FILTER (
          WHERE a.published_at > NOW() - INTERVAL '${CONVERGENCE_WINDOW_HOURS} hours'
        )::int AS distinct_sources_24h,
        COUNT(DISTINCT COALESCE(a.source_id, a.youtube_source_id))::int AS distinct_sources_total,
        COALESCE(AVG(a.base_priority), 0) AS avg_bp,
        COALESCE(MAX(a.base_priority), 0) AS max_bp,
        MAX(a.published_at) AS last_pub
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.thread_id = $1
    `, [threadId]);
    const r = rows[0] || {};
    const distinct24 = Number(r.distinct_sources_24h || 0);
    const distinctTotal = Number(r.distinct_sources_total || 0);
    const avgBp = Number(r.avg_bp || 0);
    const maxBp = Number(r.max_bp || 0);
    const lastPub = r.last_pub ? new Date(r.last_pub).getTime() : Date.now();
    const ageH = Math.max(0, (Date.now() - lastPub) / 3600000);
    const recency = Math.max(0.2, Math.exp(-ageH / 36));
    const score = Number((distinct24 * recency * (0.4 + avgBp + 0.25 * maxBp)).toFixed(4));
    await pool.query(`
      UPDATE story_threads
      SET distinct_source_count  = $1,
          breaking_signal_score  = $2,
          last_breaking_ping_at  = CASE WHEN $1 >= ${MIN_SOURCES_FOR_BREAKING} THEN NOW() ELSE last_breaking_ping_at END
      WHERE id = $3
    `, [distinctTotal, score, threadId]);
  } catch (e) {
    console.warn(`   ⚠ recomputeBreakingSignal(${threadId}) failed: ${e.message}`);
  }
}

async function refreshStaleThreadContexts(threadIds) {
  let refreshed = 0;

  for (const threadId of threadIds) {
    try {
      const context = await getThreadRefreshContext(threadId);
      if (!context || context.articles.length < 2) continue;

      const next = await reevaluateThreadContext(context);
      if (!next) continue;

      // NOTE: this is a COSMETIC re-titling pass — Claude re-evaluates
      // the thread's framing based on the existing article set. NO new
      // article was added. Therefore we do NOT bump last_updated_at,
      // because that column drives the API's `latest_published_at` and
      // the cooldown job (until both got migrated to MAX(article date)
      // — keeping last_updated_at honest is the second line of defense).
      // Bumping it here was the source of the "thread is dormant in DB
      // but UI shows active" symptom on thread #8509.
      await pool.query(`
        UPDATE story_threads
        SET title            = $1,
            description      = $2,
            primary_category = $3,
            geographic_scope = $4,
            importance       = GREATEST(importance, $5),
            keywords         = $6
        WHERE id = $7
      `, [
        next.title || context.title,
        next.description || context.description,
        next.primary_category || context.primary_category || "politics",
        next.geographic_scope || context.geographic_scope || "global",
        next.importance || context.importance || 5,
        next.keywords?.length ? next.keywords : (context.keywords || []),
        threadId
      ]);

      refreshed++;
    } catch (err) {
      console.error(`   ⚠ Failed to refresh thread ${threadId}: ${err.message}`);
    }
  }

  return refreshed;
}

async function getThreadRefreshContext(threadId) {
  const { rows: threadRows } = await pool.query(`
    SELECT id, title, description, primary_category, geographic_scope, importance, keywords, article_count
    FROM story_threads
    WHERE id = $1
    LIMIT 1
  `, [threadId]);
  if (!threadRows.length) return null;

  const { rows: articleRows } = await pool.query(`
    SELECT
      a.id,
      a.title,
      a.summary,
      a.translated_summary,
      a.published_at,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name,
      ci.name AS city_name
    FROM story_thread_articles sta
    JOIN news_articles a ON a.id = sta.article_id
    LEFT JOIN news_sources ns    ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co       ON co.id = a.country_id
    LEFT JOIN cities ci          ON ci.id = a.city_id
    WHERE sta.thread_id = $1
    ORDER BY a.published_at DESC
    LIMIT 6
  `, [threadId]);

  return { ...threadRows[0], articles: articleRows };
}

async function reevaluateThreadContext(thread) {
  const prompt = `You are refreshing the framing of an ongoing news story thread.

CURRENT THREAD:
${JSON.stringify({
  id: thread.id,
  title: thread.title,
  description: thread.description,
  primary_category: thread.primary_category,
  geographic_scope: thread.geographic_scope,
  importance: thread.importance,
  keywords: thread.keywords,
  article_count: thread.article_count
}, null, 2)}

MOST RECENT ARTICLES:
${JSON.stringify(thread.articles.map(a => ({
  id: a.id,
  title: a.title,
  summary: (a.translated_summary || a.summary || "").slice(0, 250),
  published_at: a.published_at,
  source: a.source_name || null,
  country: a.country_name || null,
  city: a.city_name || null
})), null, 2)}

Instructions:
- Keep this as the same ongoing thread, but refresh the framing to match the most recent developments
- Put more emphasis on the newest reporting than older context
- Return updated title, description, category, scope, importance, and 5-10 current keywords
- Use a concise title (max 8 words)

Return ONLY valid JSON:
{
  "title": "updated thread title",
  "description": "Two sentences describing the current state of the story and why it matters now.",
  "primary_category": "politics|economy|military|diplomacy|environment|technology",
  "geographic_scope": "global|regional|local",
  "importance": 7,
  "keywords": ["array", "of", "5-10", "current", "keywords"]
}`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON object in Claude refresh response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Similarity Dedup ────────────────────────────────────────────────────────
//
// Catches near-duplicate active threads (Issues 3 + 6 from the audit).
// Pure string/keyword similarity — no Claude. Two threads are considered
// duplicates when EITHER:
//   • title-token Jaccard ≥ 0.60      (e.g. "Trump Iran nuclear talks" ≈ "Trump Iran negotiations")
//   • OR keyword Jaccard ≥ 0.70       (e.g. shared core keywords dominate)
// AND they share the same primary_category (avoids cross-topic false merges).
//
// When duplicates are found, the older / higher-importance / larger thread
// "wins" and the loser's articles are reassigned to the winner. The loser's
// keywords are merged in and it is marked dormant (not deleted) so historical
// continuity stays intact.

const TITLE_STOPWORDS = new Set([
  "the","a","an","of","in","on","at","to","for","and","or","but","with","from",
  "by","as","is","are","was","were","be","been","being","it","its","this","that",
  "these","those","over","under","after","before","new","says","say","said",
  "amid","into","out","up","down","off","vs","versus"
]);

function tokenizeTitle(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 3 && !TITLE_STOPWORDS.has(t))
  );
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union ? intersect / union : 0;
}

function countIntersect(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n;
}

// Categories Claude routinely conflates on the same event. Politics,
// diplomacy, military, and economy slide into each other constantly —
// a war is politics-by-other-means, sanctions are economy AND diplomacy,
// a coup is politics OR military depending on the angle. Allow the dedup
// pass to compare threads across this geopolitical family. Environment
// and technology stay outside it because they're rarely conflated with
// the others (an oil spill isn't going to be misfiled as politics, and
// a chip ban gets tagged "technology" or "economy" but not military).
const _GEOPOLITICAL_FAMILY = new Set(['politics', 'diplomacy', 'military', 'economy']);
function categoriesAreRelated(a, b) {
  return _GEOPOLITICAL_FAMILY.has(a) && _GEOPOLITICAL_FAMILY.has(b);
}

// Overlap coefficient / Szymkiewicz-Simpson: |A∩B| / min(|A|,|B|). Useful
// when one set is meaningfully shorter than the other (e.g. a 4-token
// title like "Denmark Train Collision: 17 Injured" vs a 7-token title
// "Train Collision in Denmark Kills Five, Injures Eighteen") — Jaccard
// penalizes that asymmetry, containment doesn't.
function containment(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  const n = countIntersect(setA, setB);
  const denom = Math.min(setA.size, setB.size);
  return denom ? n / denom : 0;
}

async function dedupSimilarThreads() {
  const { rows: threads } = await pool.query(`
    SELECT id, title, keywords, primary_category, primary_nations, secondary_nations,
           importance, article_count, last_updated_at
    FROM story_threads
    WHERE status = 'active'
      AND last_updated_at > NOW() - INTERVAL '21 days'
    ORDER BY importance DESC, article_count DESC, last_updated_at DESC
  `);

  if (threads.length < 2) return 0;

  // Pre-compute token / keyword / nation sets
  const enriched = threads.map(t => ({
    ...t,
    _titleTokens: tokenizeTitle(t.title),
    _kwSet: new Set((t.keywords || []).map(normalizeKeyword).filter(Boolean)),
    _primaryNations: new Set(
      (Array.isArray(t.primary_nations) ? t.primary_nations : [])
        .map(s => String(s || '').toUpperCase()).filter(Boolean)
    ),
  }));

  // Union-Find: group all transitively-similar threads
  const parent = new Map(enriched.map(t => [t.id, t.id]));
  const find = (x) => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i], b = enriched[j];
      // Originally required STRICT category equality to avoid politics ↔
      // sports false merges, but Claude routinely splits the same event
      // across closely-related categories — e.g. a vehicle attack on a
      // crowd ends up as "crime" in one batch and "domestic_terror" in
      // the next. Two threads about the Leipzig vehicle incident never
      // got compared (skipped at this gate), so the dedup pass missed a
      // textbook duplicate. Soften to a related-category whitelist:
      // categories within the same family CAN merge, others cannot.
      // Title/keyword/nation gates below remain strict so cross-category
      // false positives stay rare.
      if (a.primary_category && b.primary_category
          && a.primary_category !== b.primary_category
          && !categoriesAreRelated(a.primary_category, b.primary_category)) continue;

      // ── Three similarity signals (ANY triggers a merge) ─────────────
      // Jaccard alone at 0.60 was empirically too strict for Claude's
      // re-wordings in separate batches — e.g. "Trump Orders Naval
      // Action…" vs "Trump Escalates Hormuz Blockade With Shoot-to-Kill
      // Orders" only scored 0.40. Add containment (|A∩B|/min(|A|,|B|))
      // which forgives length differences, and a nation-overlap shortcut
      // so two same-category threads sharing primary nations + ≥3 title
      // tokens merge. All thresholds lowered but each still requires ≥3
      // token overlap to avoid short-title false positives.
      const titleTokenOverlap = countIntersect(a._titleTokens, b._titleTokens);
      const titleSim = jaccard(a._titleTokens, b._titleTokens);
      const titleContainment = containment(a._titleTokens, b._titleTokens);
      const kwSim    = jaccard(a._kwSet, b._kwSet);
      const nationOverlap = countIntersect(a._primaryNations, b._primaryNations);

      const similarTitle = (titleSim >= 0.40 && titleTokenOverlap >= 3)
                         || (titleContainment >= 0.55 && titleTokenOverlap >= 3);
      const similarKeywords = kwSim >= 0.55;
      const nationalAndTitleHints = nationOverlap >= 1
                                 && titleTokenOverlap >= 3
                                 && (titleSim >= 0.30 || kwSim >= 0.35);

      if (similarTitle || similarKeywords || nationalAndTitleHints) {
        union(a.id, b.id);
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (const t of enriched) {
    const r = find(t.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }

  // For each group with >1 thread, pick a winner and merge losers into it
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Winner: highest importance → most articles → most recent
    group.sort((a, b) => {
      const impDiff = (Number(b.importance) || 0) - (Number(a.importance) || 0);
      if (impDiff) return impDiff;
      const acDiff = (Number(b.article_count) || 0) - (Number(a.article_count) || 0);
      if (acDiff) return acDiff;
      return new Date(b.last_updated_at).getTime() - new Date(a.last_updated_at).getTime();
    });
    const winner = group[0];
    const losers = group.slice(1);

    for (const loser of losers) {
      try {
        // Merge keywords into winner
        const mergedKeywords = mergeKeywords(winner.keywords || [], loser.keywords || []);

        // Reassign articles (skip rows that already exist on winner,
        // and skip any (winner, article) pair that's tombstoned —
        // an article previously ejected from the WINNER must not
        // sneak back in via a merge from a LOSER). The ON CONFLICT
        // handles the already-on-winner case; the NOT EXISTS handles
        // the previously-ejected case.
        await pool.query(`
          INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
          SELECT $1, sta.article_id, sta.relevance_score, FALSE
          FROM story_thread_articles sta
          WHERE sta.thread_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM story_thread_article_ejections e
              WHERE e.thread_id = $1 AND e.article_id = sta.article_id
            )
          ON CONFLICT DO NOTHING
        `, [winner.id, loser.id]);

        // Recount winner article_count from the join table (authoritative)
        await pool.query(`
          UPDATE story_threads
          SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
              keywords      = $2::text[],
              importance    = GREATEST(importance, $3),
              last_updated_at = NOW()
          WHERE id = $1
        `, [winner.id, mergedKeywords, Number(loser.importance) || 0]);

        // Drop loser's join rows so they don't double-count, then mark dormant
        await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [loser.id]);
        await pool.query(`
          UPDATE story_threads
          SET status = 'dormant',
              article_count = 0,
              last_updated_at = NOW()
          WHERE id = $1
        `, [loser.id]);

        // Keep winner snapshot in sync for the rest of the loop
        winner.keywords = mergedKeywords;
        winner.importance = Math.max(Number(winner.importance) || 0, Number(loser.importance) || 0);

        console.log(`   ✂  merged thread ${loser.id} ("${loser.title}") → ${winner.id} ("${winner.title}")`);
        merged++;
      } catch (err) {
        console.error(`   ⚠ Failed to merge ${loser.id} → ${winner.id}: ${err.message}`);
      }
    }
  }

  return merged;
}

// ─── Maintenance ─────────────────────────────────────────────────────────────

async function coolDownInactiveThreads() {
  // Lifecycle (matches the client-side recency reclassifier in
  // www/index.html and index.html, applyRecencyStatus):
  //   active   → cooling   after 48 hours of no new articles
  //   cooling  → dormant   after a week (7 days) of no new articles
  //   dormant  → kept forever, indexed by date so we can later tie
  //              old story arcs to new ones for continuity.
  //
  // CRITICAL: this used to filter on story_threads.last_updated_at,
  // but that column gets bumped by non-article events too —
  // refreshStaleThreadContexts (Claude re-titling), article ejects,
  // breaking-signal recomputes, etc. Result: a thread that hadn't
  // received a new article in 5 days could still be classified
  // 'active' because some cosmetic operation bumped its row at hour
  // 47 and reset the cooldown timer.
  //
  // The truth is MAX(news_articles.published_at) joined through
  // story_thread_articles. We compute it once per UPDATE pass via a
  // CTE — fast on the existing indexes (idx_articles_published_at on
  // news_articles, primary key on story_thread_articles). All three
  // transition queries reuse the same CTE.

  // active → cooling: latest article > 48h old.
  const a = await pool.query(`
    WITH article_recency AS (
      SELECT sta.thread_id, MAX(na.published_at) AS latest_pub
      FROM story_thread_articles sta
      JOIN news_articles na ON na.id = sta.article_id
      GROUP BY sta.thread_id
    )
    UPDATE story_threads st
    SET status = 'cooling'
    FROM article_recency ar
    WHERE ar.thread_id = st.id
      AND st.status = 'active'
      AND ar.latest_pub < NOW() - INTERVAL '48 hours'
  `);

  // cooling → dormant: latest article > 7d old.
  const c = await pool.query(`
    WITH article_recency AS (
      SELECT sta.thread_id, MAX(na.published_at) AS latest_pub
      FROM story_thread_articles sta
      JOIN news_articles na ON na.id = sta.article_id
      GROUP BY sta.thread_id
    )
    UPDATE story_threads st
    SET status = 'dormant'
    FROM article_recency ar
    WHERE ar.thread_id = st.id
      AND st.status = 'cooling'
      AND ar.latest_pub < NOW() - INTERVAL '7 days'
  `);

  // Catch-up: any thread STILL marked active despite > 7 days of
  // silence (skipped the cooling phase because the cron missed a
  // window, or under the old policy that gave threads 14d before
  // even the first transition) should land directly in dormant.
  const aDirect = await pool.query(`
    WITH article_recency AS (
      SELECT sta.thread_id, MAX(na.published_at) AS latest_pub
      FROM story_thread_articles sta
      JOIN news_articles na ON na.id = sta.article_id
      GROUP BY sta.thread_id
    )
    UPDATE story_threads st
    SET status = 'dormant'
    FROM article_recency ar
    WHERE ar.thread_id = st.id
      AND st.status = 'active'
      AND ar.latest_pub < NOW() - INTERVAL '7 days'
  `);

  // Backfill: anything previously archived under an older policy
  // becomes dormant so the historical arc is preserved.
  const b = await pool.query(`
    UPDATE story_threads
    SET status = 'dormant'
    WHERE status = 'archived'
  `);

  console.log(`   active→cooling: ${a.rowCount} | cooling→dormant: ${c.rowCount} | active→dormant (catch-up): ${aDirect.rowCount} | archived→dormant: ${b.rowCount}`);
}

// ─── DB Queries ───────────────────────────────────────────────────────────────

async function getUnthreadedArticles(hours) {
  // Phase 1 stratified sampler. Fetches a generous candidate pool (source-
  // capped at 5 per source) then tiers the selection in JS so we get clean
  // per-tier logging and the ability to iterate on tier weights without
  // writing five-level-nested CTEs.
  const { rows: candidates } = await pool.query(`
    WITH ranked AS (
      SELECT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at,
        COALESCE(ns.name, ys.name) AS source_name,
        co.iso_code AS country_iso,
        co.name AS country_name,
        ci.name AS city_name,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(a.source_id::text, a.youtube_source_id::text, 'unknown')
          ORDER BY a.published_at DESC
        ) AS source_rank
      FROM news_articles a
      LEFT JOIN countries co       ON co.id = a.country_id
      LEFT JOIN cities    ci       ON ci.id = a.city_id
      LEFT JOIN news_sources ns    ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      WHERE a.published_at > NOW() - INTERVAL '${hours} hours'
        AND a.published_at < NOW()
        AND a.title IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM story_thread_articles sta WHERE sta.article_id = a.id
        )
    )
    SELECT id, title, summary, translated_summary, published_at,
           source_name, country_iso, country_name, city_name
    FROM ranked
    WHERE source_rank <= 5
    ORDER BY published_at DESC
    LIMIT 5000
  `);

  if (!candidates.length) return [];

  // Cross-border stories — any article mentioning ≥2 distinct ISOs in
  // article_locations qualifies as a Tier-1 "global" story. These are the
  // articles most likely to anchor breaking meta-stories, so they skip the
  // per-country quota and land in the sample unconditionally.
  const candidateIds = candidates.map(r => r.id);
  const { rows: locRows } = await pool.query(`
    SELECT al.article_id
    FROM article_locations al
    JOIN countries co ON co.id = al.country_id
    WHERE al.article_id = ANY($1::int[])
    GROUP BY al.article_id
    HAVING COUNT(DISTINCT co.iso_code) >= 2
  `, [candidateIds]);
  const globalStoryIds = new Set(locRows.map(r => r.article_id));

  const used = new Set();

  // Tier 1 — global cross-border stories.
  const tier1 = [];
  for (const a of candidates) {
    if (tier1.length >= TIER_GLOBAL_LIMIT) break;
    if (!globalStoryIds.has(a.id)) continue;
    tier1.push(a); used.add(a.id);
  }

  // Tier 2a — per-country FLOOR. Walks candidates newest-first and admits
  // up to TIER_COUNTRY_FLOOR articles for every country with candidates.
  // Sits OUTSIDE the TIER_COUNTRY_LIMIT cap so under-represented countries
  // (Mongolia, Tajikistan, Zambia, etc.) always get a shot at forming a
  // thread even on busy days when dominant countries (US/IR/IL/RU/UA)
  // would otherwise consume the entire ceiling budget. Skips uncategorized
  // (iso=ZZ) — the floor is for *known* countries getting drowned, not
  // for articles we couldn't tag.
  const countryCount = new Map();
  const tier2Floor = [];
  for (const a of candidates) {
    if (used.has(a.id)) continue;
    const iso = a.country_iso || 'ZZ';
    if (iso === 'ZZ') continue;
    const n = countryCount.get(iso) || 0;
    if (n >= TIER_COUNTRY_FLOOR) continue;
    tier2Floor.push(a); used.add(a.id);
    countryCount.set(iso, n + 1);
  }

  // Tier 2b — per-country CEILING. Walks candidates newest-first and stops
  // adding from a country once TIER_COUNTRY_PER is hit (counting the floor
  // articles already admitted). Capped at TIER_COUNTRY_LIMIT additional
  // articles — that cap is on the ceiling pass alone; floor sits on top.
  const tier2 = [];
  for (const a of candidates) {
    if (tier2.length >= TIER_COUNTRY_LIMIT) break;
    if (used.has(a.id)) continue;
    const iso = a.country_iso || 'ZZ';
    const n = countryCount.get(iso) || 0;
    if (n >= TIER_COUNTRY_PER) continue;
    tier2.push(a); used.add(a.id);
    countryCount.set(iso, n + 1);
  }

  // Tier 3 — fresh fill. Articles under FRESH_PRIORITY_HOURS that weren't
  // claimed by tier 1/2. Guarantees the breaking-right-now signal isn't
  // starved by the per-country quota.
  const freshCutoff = Date.now() - FRESH_PRIORITY_HOURS * 3600 * 1000;
  const tier3 = [];
  for (const a of candidates) {
    if (tier3.length >= TIER_FRESH_LIMIT) break;
    if (used.has(a.id)) continue;
    const t = a.published_at ? new Date(a.published_at).getTime() : 0;
    if (!t || t < freshCutoff) continue;
    tier3.push(a); used.add(a.id);
  }

  // Tier 4 — backlog fill to top up to TOTAL_ARTICLE_LIMIT.
  const tier4 = [];
  for (const a of candidates) {
    if (tier4.length >= TIER_BACKLOG_LIMIT) break;
    if (used.has(a.id)) continue;
    tier4.push(a); used.add(a.id);
  }

  // Concat order matters for the slice — tail tiers get cut first if we
  // exceed TOTAL_ARTICLE_LIMIT. Floor articles are placed BEFORE the
  // ceiling pass and the fill tiers so under-represented countries can
  // never be dropped by the cap.
  const combined = [...tier1, ...tier2Floor, ...tier2, ...tier3, ...tier4].slice(0, TOTAL_ARTICLE_LIMIT);

  // Log how many distinct countries got the floor (i.e. countries that
  // would have produced threads only via this pass). Useful for tracking
  // how much under-represented coverage the floor is actually rescuing.
  const flooredCountries = new Set(tier2Floor.map(a => a.country_iso || 'ZZ'));
  console.log(
    `   Tiered sample: global=${tier1.length} country_floor=${tier2Floor.length}(in ${flooredCountries.size} countries) ` +
    `country_ceiling=${tier2.length} fresh=${tier3.length} backlog=${tier4.length} total=${combined.length} ` +
    `(distinct_countries=${new Set(combined.map(a => a.country_iso || 'ZZ')).size})`
  );

  // Fetch keywords for the finalized set only.
  const ids = combined.map(a => a.id);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
    FROM article_keywords
    WHERE article_id = ANY($1::int[])
    GROUP BY article_id
  `, [ids]);
  const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

  return combined
    .map(a => ({ ...a, keywords: kwMap.get(a.id) || [] }))
    .filter(a => a.keywords.length > 0);
}

// Fetch up to `perThread` sample member articles for each thread id.
// Diversity hint: ORDER BY is_anchor DESC then a published_at spread so
// Claude sees both the anchor story and a cross-section of sources rather
// than 5 near-duplicates from the same wire. Returns a Map keyed by the
// numeric thread id, with each value being an array of compact member
// objects { id, title, summary, country }.
async function fetchThreadMembers(threadIds, perThread = 5) {
  const out = new Map();
  if (!Array.isArray(threadIds) || !threadIds.length) return out;
  const ids = threadIds.map(Number).filter(Number.isFinite);
  if (!ids.length) return out;
  // country_name lives on the `countries` table joined via a.country_id.
  // The previous version selected a.country_name directly → every batch
  // errored with "column a.country_name does not exist" and the whole
  // run produced 0 threads.
  const { rows } = await pool.query(`
    SELECT sta.thread_id,
           a.id           AS article_id,
           a.title,
           a.summary,
           a.translated_summary,
           co.name AS country_name,
           sta.is_anchor,
           a.published_at
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      LEFT JOIN countries co ON co.id = a.country_id
     WHERE sta.thread_id = ANY($1::int[])
     ORDER BY sta.thread_id,
              sta.is_anchor DESC NULLS LAST,
              a.published_at DESC
  `, [ids]);
  for (const r of rows) {
    const tid = Number(r.thread_id);
    if (!out.has(tid)) out.set(tid, []);
    const bucket = out.get(tid);
    if (bucket.length >= perThread) continue;
    bucket.push({
      id:       Number(r.article_id),
      title:    r.title,
      summary:  String(r.translated_summary || r.summary || '').slice(0, 180),
      country:  r.country_name || null,
    });
  }
  return out;
}

async function getActiveThreads() {
  // primary_nations / secondary_nations are needed so filterThreadsForBatch
  // can score each thread by country overlap with the batch. The old query
  // didn't select these, which is why per-batch filtering couldn't work
  // before Phase 1.
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category, geographic_scope,
           primary_nations, secondary_nations, importance, article_count
    FROM story_threads
    WHERE status = 'active'
      AND last_updated_at > NOW() - INTERVAL '30 days'
    ORDER BY importance DESC, last_updated_at DESC
    LIMIT 250
  `);
  return rows;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Normalize an iterable of ISO 3166-1 alpha-2 codes as they come back from
// Claude. Handles the common Claude mistakes: full country names instead of
// codes, lowercase, UK→GB, blank strings. Returns a deduped uppercase array
// ready to drop into a TEXT[] column.
const _ISO_NAME_FIX = new Map([
  ['united kingdom','GB'], ['uk','GB'], ['great britain','GB'], ['britain','GB'], ['england','GB'],
  ['united states','US'], ['usa','US'], ['u.s.','US'], ['u.s.a.','US'], ['america','US'],
  ['united arab emirates','AE'], ['uae','AE'],
  ['south korea','KR'], ['republic of korea','KR'],
  ['north korea','KP'], ['dprk','KP'],
  ['russia','RU'], ['russian federation','RU'],
  ['china','CN'], ["people's republic of china",'CN'], ['prc','CN'],
  ['iran','IR'], ['islamic republic of iran','IR'],
  ['czech republic','CZ'], ['czechia','CZ'],
  ['ivory coast','CI'], ["cote d'ivoire",'CI'],
  ['democratic republic of the congo','CD'], ['drc','CD'], ['dr congo','CD'],
  ['vatican','VA'], ['holy see','VA'],
  ['east timor','TL'], ['timor-leste','TL'],
  ['myanmar','MM'], ['burma','MM'],
  ['taiwan','TW'], ['republic of china','TW'],
]);
function sanitizeIsos(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    let code;
    if (/^[A-Za-z]{2}$/.test(s)) {
      code = s.toUpperCase();
      if (code === 'UK') code = 'GB';
    } else {
      const fix = _ISO_NAME_FIX.get(s.toLowerCase());
      if (fix) code = fix;
      else continue; // 3-letter / malformed inputs are dropped rather than guessed
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function normalizeKeyword(keyword) {
  return String(keyword || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[“”"'`]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeKeywords(existingKeywords, incomingKeywords) {
  const merged = new Map();
  for (const keyword of [...(existingKeywords || []), ...(incomingKeywords || [])]) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized || merged.has(normalized)) continue;
    merged.set(normalized, String(keyword || "").trim());
  }
  return [...merged.values()];
}

function shouldRefreshThreadContext(thread, incomingKeywords) {
  if (!thread || (Number(thread.article_count) || 0) < REFRESH_MIN_ARTICLES) return false;

  const existing = new Set((thread.keywords || []).map(normalizeKeyword).filter(Boolean));
  const incomingNovelCount = new Set(
    (incomingKeywords || [])
      .map(normalizeKeyword)
      .filter(Boolean)
      .filter(keyword => !existing.has(keyword))
  ).size;

  return incomingNovelCount >= REFRESH_MIN_NEW_KWS;
}

function computeArticleRelevanceScore(importance, publishedAt) {
  const base = Math.max(0.1, Math.min(1, (Number(importance) || 5) / 10));
  if (!publishedAt) return Number(base.toFixed(4));

  const ageMs = Math.max(0, Date.now() - new Date(publishedAt).getTime());
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyFactor = Math.exp(-ageHours / RECENCY_HALF_LIFE_HOURS);
  return Number((base * recencyFactor).toFixed(4));
}

// Export a handful of helpers so one-shot maintenance scripts
// (backfillThreadNations.js, auditDedupThreads.js, etc.) can reuse the
// same logic without drifting. Don't auto-run `run()` when required as a
// module — only when invoked directly via `node storyThreadBuilder.js`.
module.exports = {
  dedupSimilarThreads,
  sanitizeIsos,
  tokenizeTitle,
  jaccard,
  containment,
  countIntersect,
};

if (require.main === module) {
  run().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
