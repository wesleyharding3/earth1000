/**
 * auditJunkThreads.js
 *
 * One-shot cleanup: scan ALL story threads and delete the ones that don't
 * belong on a geopolitical monitoring platform — lifestyle, education trends,
 * tourism, cultural events, entertainment, vague "X and Y coverage" buckets,
 * and other non-geopolitical fluff.
 *
 * Mirrors the same junk filter that storyThreadBuilder.js now applies at
 * thread CREATION time. This script cleans the historical pile of junk that
 * accumulated before the prompt + reject filter were added.
 *
 * Usage:
 *   node auditJunkThreads.js                # dry-run (default, no writes)
 *   node auditJunkThreads.js --apply        # actually delete
 *   node auditJunkThreads.js --apply --dormant   # mark as dormant instead of hard-deleting
 *
 * Match rule: a thread is junk if EITHER
 *   • primary_category is not in the geopolitical allow-list, OR
 *   • title matches one of the JUNK_TITLE_PATTERNS regexes.
 *
 * Hard delete removes the thread row + its story_thread_articles links.
 * Articles themselves are NEVER deleted — they remain in news_articles.
 */

require("dotenv").config();
const pool = require("./db");

const APPLY   = process.argv.includes("--apply");
const DORMANT = process.argv.includes("--dormant");

// Categories that belong on a geopolitical monitoring platform.
// Anything outside this set (society, sports, culture, lifestyle, etc.) is junk.
const ALLOWED_CATEGORIES = new Set([
  "politics", "economy", "military", "diplomacy", "environment", "technology"
]);

// Title-level junk patterns. Mirror of storyThreadBuilder.js JUNK_TITLE_PATTERNS.
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
  // Additional vague-bucket patterns the user has called out
  /\b(social|community|society)\s+(trends|coverage|hardship|topics)\b/i,
  /\bhigher\s+education\s+ai\b/i,
  /\bspanish\s+cultural\b/i,
  /\bcentral\s+american\s+tourism\b/i,

  // Vague administrative/governance "non-stories" — titles like
  // "Nepal Government Administrative Announcements" or
  // "Cyprus Legal System and Governance Challenges". These mention a country
  // but describe no actual event, no actor, no decision — just abstract topics.
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

  // "[Country/topic] X and Y" abstract pairings — two vague nouns AND'd together
  // is almost always a topic bucket, not a story.
  /\b(challenges|issues|developments|updates|concerns|matters|trends|reforms|topics)\s+and\s+(challenges|issues|developments|updates|concerns|matters|trends|reforms|topics|governance|administration|policy|reform)\b/i,
  /\b(governance|administration|legal|judicial|regulatory|policy|bureaucratic)\s+(and|&)\s+(governance|administration|legal|judicial|regulatory|policy|bureaucratic|challenges|issues|reforms|developments|updates)\b/i,

  // Other vague non-story buckets
  /\breligious\s+(observances|celebrations|holidays|practices)\b/i,
  /\bglobal\s+celebrations\b/i,
  /\bpractical\s+observances\b/i,
  /\bweather\s+(updates|patterns|conditions|forecast)\b/i,
  /\bdaily\s+(news|updates|roundup|briefing)\b/i,
  /\b(news|coverage)\s+(briefs|brief|wrap|wrapup|wrap-up)\b/i,
];

// ─── Structural "topic bucket" detector ──────────────────────────────────────
//
// Catches titles like:
//   "Canada Federal Workplace Policy and Urban Infrastructure"
//   "Brazil Political Accountability and Legislative Debates"
//   "Uganda Education and Digital Health Transformation"
//   "Turkey Regional News and Politics"
//   "Nigeria Police Reform and Security Investment"
//   "Rwanda News Broadcasting and National Updates"
//   "Paraguay Economic Reforms Manufacturing Sector"
//
// The pattern: [Country] + 2+ abstract topic nouns, no concrete event signal.
// These are topic labels, not stories.

const ABSTRACT_TOPIC_NOUNS = new Set([
  // Governance / policy
  "policy","policies","politics","governance","administration","administrative","reform","reforms",
  "regulation","regulations","regulatory","legislation","legislative","legal","judicial",
  "bureaucratic","institutional","accountability","transparency","oversight",
  "transformation","modernization","digitalization","reorganization","restructuring",
  // Sector labels
  "sector","sectors","industry","industries","manufacturing","agriculture","mining",
  "fishing","forestry","construction","banking","finance","financial","commerce",
  "trade","tourism","education","healthcare","health","welfare","housing",
  "infrastructure","transportation","transport","logistics","telecommunications",
  "broadcasting","media","technology","technological","digital","innovation",
  // Generic abstract nouns
  "developments","development","challenges","challenge","issues","issue","concerns",
  "concern","matters","trends","trend","topics","topic","updates","update","affairs",
  "coverage","news","reports","reporting","investment","investments","initiative",
  "initiatives","program","programs","projects","project","strategy","strategies",
  "framework","frameworks","priorities","priority","agenda","agendas","activities",
  "operations","situation","conditions","environment","landscape","outlook","overview",
  "summary","status","progress","perspective","context","background",
  "debate","debates","discussion","discussions","dialogue","consultation","review",
  "assessment","analysis","focus","attention","emphasis","approach","approaches",
  // Themes
  "inequality","poverty","unemployment","employment","labor","labour","workplace",
  "workforce","wages","welfare","wellbeing","sustainability","climate",
  "energy","security","safety","defense","defence","intelligence","cybersecurity",
  "diplomacy","relations","cooperation","integration","corruption",
  // Adjectives that pair with nouns to form topic buckets
  "federal","national","regional","local","urban","rural","domestic","public","civil",
  "social","community","societal","cultural","economic","political","industrial",
  "commercial","financial","educational","environmental","institutional","strategic",
  "operational","constitutional","democratic","municipal","provincial","state",
  "ministerial","governmental","parliamentary","executive","ongoing","general","various",
]);

// Words that indicate a CONCRETE event, action, named actor, or quantitative claim.
// Presence of any of these "rescues" a title from being flagged as a topic bucket.
const CONCRETE_SIGNAL_RE = new RegExp([
  // Numbers (years, counts, casualties, dates)
  String.raw`\d`,
  // Action verbs
  String.raw`\b(killed|kills|kill|dies|died|dead|injured|wounded|attacks?|attacked|strikes?|struck|bombed|shot|shoots?|arrested|elected|fired|resigns?|resigned|signed|signs?|launched|launches?|invaded|invades?|seized|seizes?|captured|captures?|sanctioned|imposed|imposes?|raids?|raided|protests?|protested|votes?|voted|wins?|won|loses?|lost|meets?|met|visits?|visited|announced|announces?|declared|declares?|approved|approves?|rejected|rejects?|condemned|condemns?|denounced|denies|denied|calls?|called|orders?|ordered|halts?|halted|suspends?|suspended|releases?|released|frees?|freed|expels?|expelled|deports?|deported|evacuates?|evacuated|destroyed|destroys?|crashes?|crashed|erupts?|erupted|hits?|hit|topples?|toppled|ousts?|ousted|deploys?|deployed|withdraws?|withdrew|escalates?|escalated|threatens?|threatened|warns?|warned|sues?|sued|charges?|charged|indicts?|indicted|jails?|jailed|frees?|negotiates?|negotiated|brokers?|brokered|ratifies?|ratified|vetoes?|vetoed|invokes?|invoked|files?|filed)\b`,
  // Titles / named roles
  String.raw`\b(president|prime\s+minister|minister|chancellor|king|queen|sultan|emir|general|admiral|colonel|ambassador|envoy|spokesperson|secretary|premier|governor|senator|deputy|mp)\b`,
  // Conflict / event nouns
  String.raw`\b(coup|war|invasion|airstrike|missile|drone|ceasefire|treaty|summit|election|referendum|sanctions|tariff|tariffs|protest|riot|earthquake|tsunami|wildfire|flood|hurricane|cyclone|outbreak|epidemic|pandemic|hostage|kidnap|kidnapped|shooting|massacre|assassination|raid|blockade|embargo|deal|accord|pact|verdict|ruling|indictment|impeachment|crash|explosion|attack|strike|offensive|withdrawal|retreat|surge|breakthrough|deadlock)\b`
].join("|"), "i");

function tokenizeForTopicCheck(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function looksLikeTopicBucket(title) {
  if (!title) return false;
  // If the title has any concrete event/action/actor signal, it's not a bucket.
  if (CONCRETE_SIGNAL_RE.test(title)) return false;
  const tokens = tokenizeForTopicCheck(title);
  if (tokens.length < 3) return false;
  let abstractCount = 0;
  for (const tok of tokens) {
    if (ABSTRACT_TOPIC_NOUNS.has(tok)) abstractCount++;
  }
  // Aggressive: a real story is named events/actors/places.
  // A non-story is "[Country] [topic] [topic] [topic]".
  // 2+ abstract nouns → topic bucket. (covers "Brazil Political Accountability and Legislative Debates")
  if (abstractCount >= 2) return true;
  // 1 abstract noun + "and"/"&" → also a topic bucket pairing.
  // ("Turkey Regional News and Politics" — regional/news/politics all in set, but
  //  even "X Reform and Y" with one abstract head is still a bucket.)
  if (abstractCount >= 1 && /\b(and|&)\b/i.test(title)) return true;
  // Final catch: very short titles (3-5 tokens) where ≥40% are abstract nouns.
  // ("Paraguay Economic Reforms Manufacturing Sector" — 4 of 5 tokens.)
  if (tokens.length <= 6 && abstractCount / tokens.length >= 0.4) return true;
  return false;
}

function classifyJunk(thread) {
  const cat = String(thread.primary_category || "").toLowerCase();
  if (cat && !ALLOWED_CATEGORIES.has(cat)) {
    return `category=${cat}`;
  }
  const title = String(thread.title || "");
  for (const re of JUNK_TITLE_PATTERNS) {
    if (re.test(title)) return `title:${re.source.slice(0, 50)}`;
  }
  if (looksLikeTopicBucket(title)) {
    return `topic-bucket`;
  }
  return null;
}

async function main() {
  console.log("─────────────────────────────────────────────");
  console.log("🧹 audit junk threads");
  console.log(`   mode: ${APPLY ? (DORMANT ? "APPLY (dormant)" : "APPLY (DELETE)") : "DRY-RUN"}`);
  console.log("─────────────────────────────────────────────\n");

  const { rows: threads } = await pool.query(`
    SELECT id, title, primary_category, status, importance, article_count, last_updated_at
    FROM story_threads
    ORDER BY id DESC
  `);
  console.log(`📦 Loaded ${threads.length} threads to evaluate\n`);

  const junk = [];
  const reasonCounts = new Map();

  for (const t of threads) {
    const reason = classifyJunk(t);
    if (!reason) continue;
    junk.push({ thread: t, reason });
    const bucket = reason.startsWith("category=") ? reason : reason.split(":")[0] + ":pattern";
    reasonCounts.set(bucket, (reasonCounts.get(bucket) || 0) + 1);
  }

  console.log(`🚫 Found ${junk.length} junk thread(s) (${(junk.length / Math.max(threads.length, 1) * 100).toFixed(1)}% of total)\n`);

  // Print summary by reason
  console.log("── breakdown by reason ──");
  const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${String(count).padStart(5)}  ${reason}`);
  }
  console.log("");

  // Print first 50 examples so the user can sanity-check
  console.log("── first 50 junk threads ──");
  for (const { thread, reason } of junk.slice(0, 50)) {
    const tag = `[${thread.id}] cat=${thread.primary_category || "—"} arts=${thread.article_count} imp=${thread.importance}`;
    console.log(`  ${tag.padEnd(48)}  "${thread.title}"`);
    console.log(`  ${"".padEnd(48)}    ↳ ${reason}`);
  }
  if (junk.length > 50) {
    console.log(`  … and ${junk.length - 50} more`);
  }
  console.log("");

  if (!APPLY) {
    console.log("🔍 dry-run complete. Re-run with --apply to delete (or --apply --dormant to soft-delete).");
    await pool.end();
    return;
  }

  // APPLY
  let removed = 0;
  let failed = 0;
  for (const { thread } of junk) {
    try {
      if (DORMANT) {
        await pool.query(
          `UPDATE story_threads SET status = 'dormant', last_updated_at = NOW() WHERE id = $1`,
          [thread.id]
        );
      } else {
        // Clear FK references first. segment_story_links points at briefing
        // segments — those briefings already played, so dropping the link
        // is harmless (the briefing rows themselves are not touched).
        await pool.query(`DELETE FROM segment_story_links WHERE thread_id = $1`, [thread.id]);
        await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [thread.id]);
        await pool.query(`DELETE FROM story_threads WHERE id = $1`, [thread.id]);
      }
      removed++;
    } catch (err) {
      failed++;
      console.error(`  ⚠ failed on thread ${thread.id} "${thread.title}": ${err.message}`);
    }
  }

  console.log("");
  console.log(`✅ ${DORMANT ? "marked dormant" : "deleted"}: ${removed}`);
  if (failed) console.log(`⚠ failed: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
