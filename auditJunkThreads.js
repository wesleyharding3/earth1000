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
 *   node auditJunkThreads.js                       # dry-run (default, no writes)
 *   node auditJunkThreads.js --apply               # actually delete
 *   node auditJunkThreads.js --apply --dormant     # mark as dormant instead of hard-deleting
 *   node auditJunkThreads.js --apply --clean-orphans  # also delete dormant threads with 0 articles (merge-losers)
 *   node auditJunkThreads.js --apply --min-arts=2  # also delete threads with fewer than N articles
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

const APPLY         = process.argv.includes("--apply");
const DORMANT       = process.argv.includes("--dormant");
const CLEAN_ORPHANS = process.argv.includes("--clean-orphans");
const MIN_ARTS      = parseInt(process.argv.find(a => a.startsWith("--min-arts="))?.split("=")[1] || "0", 10);
const SHOW_LIMIT    = parseInt(process.argv.find(a => a.startsWith("--show="))?.split("=")[1] || "50", 10);
const OUT_FILE      = process.argv.find(a => a.startsWith("--out="))?.split("=")[1] || null;
const GROUP_BY_REASON = process.argv.includes("--group");

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

  // ─── Regional / subnational politics (not geopolitical) ──────────────
  /\b(foundation|party|anniversary)\s+day\s+(celebration|celebrations)\b/i,
  /\b(cabinet|government)\s+(formation|reshuffle|reshuffling|reshuffles)\b/i,
  /\b(leadership|chamber|council|committee|board)\s+(election|appointment|appointments|selection|recruitment)\b/i,
  /\bchamber\s+of\s+commerce\b/i,
  /\b(youth|provincial|regional|municipal|district|local|village|town|county)\s+(council|assembly|committee|board)\b/i,
  /\bgovernment\s+leadership\s+(appointments?|changes?|reshuffle)\b/i,
  /\bregional\s+cabinet\b/i,
  /\bdefamation\s+(dispute|case|lawsuit|suit|charges?)\b/i,

  // ─── Routine government administration ──────────────────────────────
  /\b(license|permit|passport|visa)\s+(processing|issuance|applications?|renewal)\b/i,
  /\b(recruitment|hiring)\s+(announcement|drive|campaign|notice)\b/i,
  /\bpersonnel\s+(meetings?|changes?|announcements?|updates?)\b/i,
  /\btax\s+(returns?|filing|season|campaign)\s+(campaign|opens?|opening|deadline|filing|begins?)/i,
  /\btax\s+(returns?|filing)\b/i,
  /\b(transport|transportation)\s+department\b/i,
  /\b(ministry|department)\s+(personnel|operations|activities|meetings?|announcements?)\b/i,

  // ─── Commercial / industrial / factory news ─────────────────────────
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

  // ─── Research / science / academic (non-event) ──────────────────────
  /\b(research|scientific|medical|academic)\s+(breakthrough|breakthroughs|funding|grants?|awards?)\b/i,
  /\b(cancer|viral|medical|clinical|biomedical)\s+research\b/i,
  /\bresearch\s+funding\s+awards?\b/i,

  // ─── Domestic crime / violations (non-geopolitical) ─────────────────
  /\b(crime|theft|robbery|burglary|fraud)\s*:/i,
  /\b(property|petty)\s+(theft|crime)\b/i,
  /\bhouse\s+arrest\s+violations?\b/i,

  // ─── Weather (non-geopolitical) ─────────────────────────────────────
  /\b(weather\s+crisis|cold\s+front|severe\s+(weather|conditions|storm|cold)|heat\s+wave|rain\s+forecast)\b/i,

  // ─── News-of-news / coverage meta / headlines roundup ───────────────
  /\b(communication|campaign|political|election)\s+strategy\b/i,
  /\belection\s+coverage\b/i,
  /\bnews\s+(update|updates|headlines|briefing|briefings|roundup|recap|digest)\b/i,
  /\bheadlines?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,

  // ─── Vague "resilience / engagement / presence" framings ────────────
  /\b(economic|political|social|regional)\s+resilience\b/i,
  /\bamid\s+(global|regional)\s+(tensions?|challenges?|uncertainty|pressure)\b/i,
  /\bdiplomatic\s+(engagement|presence|activities|initiatives|outreach)\b/i,
  /\breconstruction\s+and\s+(international|diplomatic|foreign)\b/i,

  // ─── Routine maritime / inspection / operations ─────────────────────
  /\b(maritime|port|harbor|airport|border)\s+(authority|agency)\s+(inspection|inspections|operations|activities)\b/i,
  /\b(boat|vessel|ship|vehicle|customs)\s+inspections?\b/i,
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
  // Extras exposed by real examples
  "resilience","dispute","disputes","formation","presence","engagement","engagements",
  "surge","surges","guidance","recruitment","appointments","appointment","headlines",
  "celebrations","celebration","processing","returns","campaign","campaigns","controls",
  "control","prices","price","liberalization","breakthrough","breakthroughs","awards",
  "funding","grants","grant","inspection","inspections","reconstruction","meetings",
  "personnel","licensing","license","licenses","crime","crimes","theft","thefts",
  "violations","violation","weather","climate","forecast","conditions","severe",
  "cold","warm","front","fronts","market","markets","cement","steel","ceramic",
  "manufacturing","factory","factories","plant","plants","expansion","expansions",
  "groundbreaking","inauguration","launches","launch","launched","product","products",
  "technology","platform","service","research","science","scientific","cancer","viral",
  "medical","clinical","academic","chamber","commerce","council","councils","authority",
  "authorities","ministry","department","departments","appointees","tax","taxes",
  "filing","filings","boat","boats","vessel","vessels","maritime","port","ports",
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
    let reason = classifyJunk(t);
    // Orphan merge-losers: dormant threads with no articles left.
    // auditDedupThreads.js marks these dormant after merging, but they're
    // pure DB bloat and the frontend already hides them — safe to hard delete.
    if (!reason && CLEAN_ORPHANS && t.status === "dormant" && Number(t.article_count) === 0) {
      reason = "orphan-dormant";
    }
    // Thin threads: single-article (or MIN_ARTS-1 article) threads without
    // multi-source corroboration. A real story arc needs ≥2 sources.
    if (!reason && MIN_ARTS > 0 && Number(t.article_count) < MIN_ARTS) {
      reason = `thin<${MIN_ARTS}`;
    }
    if (!reason) continue;
    junk.push({ thread: t, reason });
    const bucket = reason.startsWith("category=") ? reason
                : reason.startsWith("orphan") ? "orphan-dormant"
                : reason.startsWith("thin") ? reason
                : reason.split(":")[0] + ":pattern";
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

  // Print examples for sanity-check. Two modes:
  //  • default: flat list, truncated at --show=N (default 50)
  //  • --group: group by reason bucket so you can see what each pattern caught
  //  • --out=path: dump ALL flagged threads to a file for full review
  const formatRow = ({ thread, reason }) => {
    const tag = `[${thread.id}] cat=${thread.primary_category || "—"} arts=${thread.article_count} imp=${thread.importance}`;
    return `  ${tag.padEnd(48)}  "${thread.title}"\n  ${"".padEnd(48)}    ↳ ${reason}`;
  };

  if (GROUP_BY_REASON) {
    console.log(`── junk threads grouped by reason (showing up to ${SHOW_LIMIT} per group) ──`);
    const byReason = new Map();
    for (const j of junk) {
      const key = j.reason.startsWith("category=") ? j.reason
                : j.reason.startsWith("orphan") ? "orphan-dormant"
                : j.reason.startsWith("thin") ? j.reason
                : j.reason.split(":")[0] + ":pattern";
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key).push(j);
    }
    const sorted = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [key, items] of sorted) {
      console.log(`\n── ${key}  (${items.length}) ──`);
      for (const item of items.slice(0, SHOW_LIMIT)) {
        console.log(formatRow(item));
      }
      if (items.length > SHOW_LIMIT) {
        console.log(`  … and ${items.length - SHOW_LIMIT} more in this group`);
      }
    }
    console.log("");
  } else {
    console.log(`── first ${SHOW_LIMIT} junk threads ──`);
    for (const item of junk.slice(0, SHOW_LIMIT)) {
      console.log(formatRow(item));
    }
    if (junk.length > SHOW_LIMIT) {
      console.log(`  … and ${junk.length - SHOW_LIMIT} more (use --show=N or --group or --out=file.txt to see more)`);
    }
    console.log("");
  }

  // Dump ALL flagged threads to a file if requested
  if (OUT_FILE) {
    const fs = require("fs");
    const lines = [
      `# auditJunkThreads dump — ${new Date().toISOString()}`,
      `# total flagged: ${junk.length}`,
      `# breakdown:`,
      ...sortedReasons.map(([r, n]) => `#   ${String(n).padStart(5)}  ${r}`),
      ``,
    ];
    // Group the file dump by reason so it's actually usable
    const byReason = new Map();
    for (const j of junk) {
      const key = j.reason.startsWith("category=") ? j.reason
                : j.reason.startsWith("orphan") ? "orphan-dormant"
                : j.reason.startsWith("thin") ? j.reason
                : j.reason.split(":")[0] + ":pattern";
      if (!byReason.has(key)) byReason.set(key, []);
      byReason.get(key).push(j);
    }
    const sortedFile = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [key, items] of sortedFile) {
      lines.push(`\n## ${key}  (${items.length})`);
      for (const { thread, reason } of items) {
        lines.push(`  [${thread.id}] cat=${thread.primary_category || "—"} arts=${thread.article_count} imp=${thread.importance} status=${thread.status}  "${thread.title}"`);
        lines.push(`      ↳ ${reason}`);
      }
    }
    fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n", "utf8");
    console.log(`📄 wrote full dump to ${OUT_FILE}`);
  }

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
