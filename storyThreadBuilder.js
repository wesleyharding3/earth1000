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

require("dotenv").config();
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");
const { normalizeRecentKeywords } = require("./keywordNormalizer");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOOKBACK_HOURS  = parseInt(process.argv.find(a => a.startsWith("--hours="))?.split("=")[1] || "48");
const CLAUDE_BATCH    = 120;    // articles per Claude call
const MIN_CLUSTER     = 3;     // min articles to form a cluster (Claude sees singletons too)
const MIN_SHARED_KW   = 2;     // min shared keywords to link two articles
const MIN_SOURCES_FOR_BREAKING = 3; // ≥3 distinct sources within 24h → "breaking meta-story"
const CONVERGENCE_WINDOW_HOURS = 24;
const FRESH_PRIORITY_HOURS = 6;
const FRESH_PRIORITY_LIMIT = 100;
const TOTAL_ARTICLE_LIMIT  = 1200;
const REFRESH_MIN_ARTICLES = 5;
const REFRESH_MIN_NEW_KWS  = 3;
const RECENCY_HALF_LIFE_HOURS = 36;
const SKIP_KEYWORDS   = new Set([ // too generic to cluster on
  "government","minister","president","official","said","year","people",
  "new","first","last","will","also","one","two","three","could","would",
  "after","before","over","under","says","says","day","week","month","country",
  "world","international","national","local","news","report","according"
]);

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now()-t0)/1000).toFixed(1)}s`;

  console.log(`\n🧵 Story Thread Builder — ${new Date().toISOString()}`);
  console.log(`   Lookback: ${LOOKBACK_HOURS}h | Article limit: none`);

  console.log(`   [${elapsed()}] Normalizing recent multilingual keywords...`);
  const normalization = await normalizeRecentKeywords({
    pool,
    anthropicClient: client,
    logger: console,
    scope: { hours: LOOKBACK_HOURS }
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
  const allGroups = [...clusters, ...chunkSingletons(singletons, 20)];
  const totalBatches = Math.ceil(allGroups.length / 3);
  console.log(`   [${elapsed()}] Sending ${totalBatches} batch(es) to Claude...\n`);

  for (let i = 0; i < allGroups.length; i += 3) {
    const batchNum = Math.floor(i/3) + 1;
    const batch = allGroups.slice(i, i + 3).flat().slice(0, CLAUDE_BATCH);
    if (!batch.length) continue;

    process.stdout.write(`   [${elapsed()}] Batch ${batchNum}/${totalBatches} (${batch.length} articles) → Claude... `);
    try {
      const validIdSet = new Set(batch.map(a => Number(a.id)));
      const defs = await evaluateWithClaude(batch, [...existingThreadMap.values()]);
      const { c, u, refreshIds } = await persistThreadDefs(defs, validIdSet, existingThreadMap);
      created += c; updated += u;
      refreshIds.forEach(id => refreshThreadIds.add(Number(id)));
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

  // Compact format keeps token usage manageable while letting Claude see
  // ~150 active threads (vs the old 30) so it can correctly extend duplicates
  // instead of spawning parallel "Trump-Iran" / "Iran-US war" / etc threads.
  const existingData = existingThreads.slice(0, 150).map(t => ({
    id:       t.id,
    title:    t.title,
    kw:       (t.keywords || []).slice(0, 3),
    cat:      t.primary_category
  }));

  const prompt = `You are the editor of the BREAKING META-STORY stream of a geopolitical monitoring platform. Your job is NOT to catalogue umbrella arcs (that is handled elsewhere by the Timelines editor). Your job is to surface the STORIES THE WORLD'S PRESS IS COLLECTIVELY FOREGROUNDING RIGHT NOW — the meta-story that emerges from cross-source signal convergence in the last 48 hours.

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

EXISTING ACTIVE THREADS (check if any articles extend these):
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
- Entertainment: movies, TV, music, celebrity news, streaming
- Sports — UNLESS the story is about state boycotts, doping scandals tied to governments, or athletes being used as political instruments
- Technology product launches, consumer apps, startup funding
- Personal finance, real estate trends, retail/shopping
- Local crime, accidents, weather — unless it triggers a state-level response or has cross-border impact
- Vague abstractions like "social hardship", "youth trends", "community coverage"
- Op-eds, opinion pieces, editorials, "explainer" pieces with no news event
- ROUTINE GOVERNMENT ACTIVITY without a specific event or decision: "Nepal Government Administrative Announcements", "Cyprus Legal System and Governance Challenges", "Country X Policy Developments", "Country Y Regulatory Updates", "Road Safety and Infrastructure Issues", "Health Crisis and Economic Inequality". These are TOPIC LABELS, not stories. If a routine government article is relevant to an existing thread (a named conflict, election, sanctions regime, etc.), ATTACH it to that thread via existing_thread_id. Otherwise OMIT it. Do not create a new thread that just pairs a country name with abstract governance/legal/administrative/infrastructure nouns.

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

═══ AGGRESSIVE CROSS-COUNTRY LINKING ═══
When articles relate to the same geopolitical development across multiple countries or regions, LINK them into ONE thread rather than splitting them:

ANTI-PATTERN (wrong — splits the story):
  • Thread 1: "Poland Demands Investigation Into Citizen Death in Russian Custody"
  • Thread 2: "Ukraine Detention Center Staffing Under Scrutiny"
  • Thread 3: "Baltic States Condemn Russian POW Treatment"

CORRECT PATTERN (one unified narrative):
  • Thread: "Eastern Europe POW Crisis: Poland, Ukraine, Baltics Demand Russian Accountability"
    - Includes Poland citizen death + Ukraine detention + Baltic statements
    - Shows the regional escalation and coordination

Another example:
ANTI-PATTERN:
  • "Armenia Court Detention Decision David Minasyan"
  • "Armenia-Azerbaijan Transit Corridor Opening"
  • "Armenia-Azerbaijani Tensions Over Karabakh Region"

CORRECT:
  • "Armenia-Azerbaijan Reconciliation Stalls: Corridor Talks Amid Detention Crackdown"
    - Links the corridor progress + internal repression + regional tensions into one narrative

The goal: show readers the FULL picture of how a geopolitical development is unfolding, not scattered fragments.

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
    "primary_category": "politics|economy|military|diplomacy|environment|technology",
    "geographic_scope": "global|regional|local",
    "importance": 7,
    "keywords": ["array", "of", "5-10", "core", "keywords"]
  }
]`;

  const response = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 3072,
    messages:   [{ role: "user", content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persistThreadDefs(defs, validIdSet, existingThreadMap = new Map()) {
  let created = 0, updated = 0;
  const refreshIds = new Set();

  // Hard reject categories that don't belong on a geopolitical platform.
  // Acts as a server-side safety net in case Claude ignores the prompt rules.
  const ALLOWED_CATEGORIES = new Set([
    'politics','economy','military','diplomacy','environment','technology'
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
    String.raw`\b(killed|kills|kill|dies|died|dead|injured|wounded|attacks?|attacked|strikes?|struck|bombed|shot|shoots?|arrested|elected|fired|resigns?|resigned|signed|signs?|launched|launches?|invaded|invades?|seized|seizes?|captured|captures?|sanctioned|imposed|imposes?|raids?|raided|protests?|protested|votes?|voted|wins?|won|loses?|lost|meets?|met|visits?|visited|announced|announces?|declared|declares?|approved|approves?|rejected|rejects?|condemned|condemns?|denounced|denies|denied|calls?|called|orders?|ordered|halts?|halted|suspends?|suspended|releases?|released|frees?|freed|expels?|expelled|deports?|deported|evacuates?|evacuated|destroyed|destroys?|crashes?|crashed|erupts?|erupted|hits?|hit|topples?|toppled|ousts?|ousted|deploys?|deployed|withdraws?|withdrew|escalates?|escalated|threatens?|threatened|warns?|warned|sues?|sued|charges?|charged|indicts?|indicted|jails?|jailed|negotiates?|negotiated|brokers?|brokered|ratifies?|ratified|vetoes?|vetoed|invokes?|invoked|files?|filed)\b`,
    String.raw`\b(president|prime\s+minister|minister|chancellor|king|queen|sultan|emir|general|admiral|colonel|ambassador|envoy|spokesperson|secretary|premier|governor|senator|deputy|mp)\b`,
    String.raw`\b(coup|war|invasion|airstrike|missile|drone|ceasefire|treaty|summit|election|referendum|sanctions|tariff|tariffs|protest|riot|earthquake|tsunami|wildfire|flood|hurricane|cyclone|outbreak|epidemic|pandemic|hostage|kidnap|kidnapped|shooting|massacre|assassination|raid|blockade|embargo|deal|accord|pact|verdict|ruling|indictment|impeachment|crash|explosion|attack|strike|offensive|withdrawal|retreat|surge|breakthrough|deadlock)\b`
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
    if (cat && !ALLOWED_CATEGORIES.has(cat)) return `category=${cat}`;
    const title = String(def.title || '');
    for (const re of JUNK_TITLE_PATTERNS) {
      if (re.test(title)) return `title-pattern:${re.source.slice(0,40)}`;
    }
    if (looksLikeTopicBucket(title)) return `topic-bucket`;
    return null;
  }

  for (const def of defs) {
    if (!def.article_ids?.length) continue;

    // Only reject NEW threads — never block extensions of existing threads,
    // since those decisions were already made.
    if (!def.existing_thread_id) {
      const reason = isJunkThreadDef(def);
      if (reason) {
        console.log(`   🚫 Rejected non-geopolitical thread "${def.title}" (${reason})`);
        continue;
      }
    }

    try {
      if (def.existing_thread_id) {
        const threadId = Number(def.existing_thread_id);
        const current = existingThreadMap.get(threadId);
        if (shouldRefreshThreadContext(current, def.keywords || [])) {
          refreshIds.add(threadId);
        }

        // Update existing thread
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
      } else {
        // Create new thread
        const { rows } = await pool.query(`
          INSERT INTO story_threads
            (title, description, primary_category, geographic_scope, importance, keywords, article_count)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [
          def.title,
          def.description,
          def.primary_category || "politics",
          def.geographic_scope || "global",
          def.importance       || 5,
          def.keywords         || [],
          def.article_ids.length
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
          article_count: def.article_ids.length
        });
        created++;
      }
    } catch (err) {
      console.error(`   ⚠ Failed to persist thread "${def.title}": ${err.message}`);
    }
  }

  return { c: created, u: updated, refreshIds: [...refreshIds] };
}

async function insertArticles(threadId, articleIds, anchorId, importance, validIdSet) {
  const filteredIds = articleIds
    .map(id => Number(id))
    .filter(id => !validIdSet || validIdSet.has(id));
  if (!filteredIds.length) return;

  const { rows } = await pool.query(`
    SELECT id, published_at
    FROM news_articles
    WHERE id = ANY($1::int[])
  `, [filteredIds]);

  const publishedAtMap = new Map(rows.map(r => [Number(r.id), r.published_at]));
  for (const articleId of articleIds) {
    const numericId = Number(articleId);
    if (validIdSet && !validIdSet.has(numericId)) continue;
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

      await pool.query(`
        UPDATE story_threads
        SET title            = $1,
            description      = $2,
            primary_category = $3,
            geographic_scope = $4,
            importance       = GREATEST(importance, $5),
            keywords         = $6,
            last_updated_at  = NOW()
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

async function dedupSimilarThreads() {
  const { rows: threads } = await pool.query(`
    SELECT id, title, keywords, primary_category, importance, article_count, last_updated_at
    FROM story_threads
    WHERE status = 'active'
      AND last_updated_at > NOW() - INTERVAL '21 days'
    ORDER BY importance DESC, article_count DESC, last_updated_at DESC
  `);

  if (threads.length < 2) return 0;

  // Pre-compute token/keyword sets
  const enriched = threads.map(t => ({
    ...t,
    _titleTokens: tokenizeTitle(t.title),
    _kwSet: new Set((t.keywords || []).map(normalizeKeyword).filter(Boolean))
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
      // Require category match to avoid e.g. politics ↔ sports false merges
      if (a.primary_category && b.primary_category && a.primary_category !== b.primary_category) continue;

      const titleSim = jaccard(a._titleTokens, b._titleTokens);
      const kwSim    = jaccard(a._kwSet, b._kwSet);
      if (titleSim >= 0.60 || kwSim >= 0.70) {
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

        // Reassign articles (skip rows that already exist on winner)
        await pool.query(`
          INSERT INTO story_thread_articles (thread_id, article_id, relevance_score, is_anchor)
          SELECT $1, sta.article_id, sta.relevance_score, FALSE
          FROM story_thread_articles sta
          WHERE sta.thread_id = $2
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
  // Lifecycle (relaxed to give threads more breathing room):
  //   active   → cooling   after 14 days of no new articles
  //   cooling  → dormant   after another 14 days (28 total)
  //   dormant  → kept forever, indexed by date so we can later
  //              tie old story arcs to new ones for continuity.

  // active → cooling
  const a = await pool.query(`
    UPDATE story_threads
    SET status = 'cooling'
    WHERE status = 'active'
      AND last_updated_at < NOW() - INTERVAL '14 days'
  `);

  // cooling → dormant
  const c = await pool.query(`
    UPDATE story_threads
    SET status = 'dormant'
    WHERE status = 'cooling'
      AND last_updated_at < NOW() - INTERVAL '14 days'
  `);

  // Backfill: anything previously archived under the old policy
  // becomes dormant so the historical arc is preserved.
  const b = await pool.query(`
    UPDATE story_threads
    SET status = 'dormant
    WHERE status = 'archived'
  `);

  console.log(`   active→cooling: ${a.rowCount} | cooling→dormant: ${c.rowCount} | archived→dormant: ${b.rowCount}`);
}

// ─── DB Queries ───────────────────────────────────────────────────────────────

async function getUnthreadedArticles(hours) {
  // Step 1: keep the 48h window, but bias selection toward the freshest articles.
  // We still cap at 5 per source, then reserve the first tranche for the last 6h
  // before filling the rest from the older remainder of the 48h window.
  const { rows: baseRows } = await pool.query(`
    WITH ranked AS (
      SELECT
        a.id, a.title, a.summary, a.translated_summary,
        a.published_at,
        COALESCE(ns.name, ys.name) AS source_name,
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
    ),
    fresh AS (
      SELECT id, title, summary, translated_summary, published_at, source_name, country_name, city_name
      FROM ranked
      WHERE source_rank <= 5
        AND published_at > NOW() - INTERVAL '${Math.min(hours, FRESH_PRIORITY_HOURS)} hours'
      ORDER BY published_at DESC, RANDOM()
      LIMIT ${FRESH_PRIORITY_LIMIT}
    ),
    backlog AS (
      SELECT id, title, summary, translated_summary, published_at, source_name, country_name, city_name
      FROM ranked
      WHERE source_rank <= 5
        AND published_at <= NOW() - INTERVAL '${Math.min(hours, FRESH_PRIORITY_HOURS)} hours'
      ORDER BY published_at DESC, RANDOM()
      LIMIT ${TOTAL_ARTICLE_LIMIT - FRESH_PRIORITY_LIMIT}
    )
    SELECT *
    FROM (
      SELECT * FROM fresh
      UNION ALL
      SELECT * FROM backlog
    ) sampled
    ORDER BY published_at DESC, RANDOM()
    LIMIT ${TOTAL_ARTICLE_LIMIT}
  `);

  if (!baseRows.length) return [];

  // Step 2: fetch keywords for just those article IDs
  const ids = baseRows.map(r => r.id);
  const { rows: kwRows } = await pool.query(`
    SELECT article_id, ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
    FROM article_keywords
    WHERE article_id = ANY($1::int[])
    GROUP BY article_id
  `, [ids]);

  const kwMap = new Map(kwRows.map(r => [r.article_id, r.keywords]));

  return baseRows
    .map(a => ({ ...a, keywords: kwMap.get(a.id) || [] }))
    .filter(a => a.keywords.length > 0);
}

async function getActiveThreads() {
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category, geographic_scope, importance, article_count
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

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
