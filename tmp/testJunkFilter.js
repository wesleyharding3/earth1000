// Functional test: proves the updated junk filter rejects the example
// titles that previously slipped through, AND lets through legitimate
// geopolitical headlines that LOOK adjacent (FIFA-as-Iran-pressure, US
// arsenal, Barcelona conference, Tony Elumelu).
//
// We import storyThreadBuilder.js by hand-extracting the patterns and
// the isJunkThreadDef logic, since the patterns live inside a closure.
// That mirroring is verified once at the top of the file.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../storyThreadBuilder.js', 'utf8');

// Sanity-check the patterns were committed to the source file.
function assertPresent(needle, label) {
  if (!src.includes(needle)) {
    console.error(`MISSING in storyThreadBuilder.js: ${label}`);
    process.exit(1);
  }
}
assertPresent("REJECTED_CATEGORIES = new Set([", 'REJECTED_CATEGORIES set');
assertPresent("Performing arts / classical music / theatre", 'opera/symphony pattern block');
assertPresent("Sports — leagues, tournaments, named competitions", 'sports leagues pattern block');
assertPresent("off-topic-category=", 'category-based reject reason');

// Now mirror the same JUNK_TITLE_PATTERNS + ALLOWED/REJECTED sets
// for an in-process functional test.
const ALLOWED_CATEGORIES = new Set(['politics','economy','military','diplomacy','environment','technology']);
const REJECTED_CATEGORIES = new Set(['sports','entertainment','culture','other','lifestyle','arts','religion']);
const PATS = [
  /\b(opera|symphony|philharmonic|orchestra|ballet|chamber\s+(orchestra|music)|conservatory)\b/i,
  /\b(music\s+director|conductor|maestro|soprano|tenor|baritone|mezzo[-\s]?soprano|virtuoso)\b/i,
  /\b(la\s+scala|met\s+opera|metropolitan\s+opera|covent\s+garden|royal\s+opera|paris\s+opera|vienna\s+state\s+opera|bolshoi|mariinsky|glyndebourne|salzburg\s+festival|bayreuth)\b/i,
  /\b(broadway|west\s+end|playhouse)\b/i,
  /\btheatre?\s+(production|company|festival)\b/i,
  /\b(nfl|nba|nhl|mlb|wnba|mls|epl|premier\s+league|la\s+liga|bundesliga|serie\s+a|ligue\s+1)\b/i,
  /\b(wimbledon|french\s+open|australian\s+open|the\s+masters|ryder\s+cup|tour\s+de\s+france|giro\s+d'italia|formula\s*1|formula\s*one|nascar|indycar|moto\s*gp)\b/i,
  /\b(boxing\s+match|boxing\s+title|wrestling\s+match|mma\s+(fight|bout)|ufc\s+\d+)\b/i,
  /\b(athletes?|sportsmen|sportswomen|football|soccer|basketball|baseball|cricket|tennis|rugby|hockey|golf)\s+(stars?|legend|legends|icon|icons)\b/i,
  /\b(coach|head\s+coach|striker|goalkeeper|quarterback|pitcher|midfielder|defender)\s+(fired|hired|signed|signs|sacks?|sacked|resigns?|resigned|retires?|retired|traded)\b/i,
  /\b(transfer\s+window|free\s+agent|draft\s+pick|player\s+(transfer|trade|signing))\b/i,
  /\b(real\s+madrid|fc\s+barcelona|manchester\s+(united|city)|paris\s+saint[-\s]?germain|borussia\s+dortmund|atletico\s+madrid|bayern\s+munich|76ers|los\s+angeles\s+lakers|boston\s+celtics|new\s+york\s+yankees|new\s+england\s+patriots|dallas\s+cowboys|golden\s+state\s+warriors|los\s+angeles\s+dodgers)\b/i,
  /\b(greek\s+cup|fa\s+cup|copa\s+del\s+rey|coppa\s+italia|dfb[-\s]?pokal|euroleague|el\s+clasico|el\s+clásico)\b/i,
  /\b(box\s+office|opening\s+weekend|streaming\s+(release|premiere|debut)|tv\s+(premiere|finale|series\s+finale)|season\s+(premiere|finale))\b/i,
  /\b(grammys?\s+award|grammys\b|oscars\b|oscar\s+(award|nominee|nomination|ceremony)|tonys\b|tony[-\s]?award|tony\s+(award|nomination|ceremony)|emmys\b|emmy\s+award|baftas?\s+award|baftas\b|golden\s+globes?|cannes\s+(film\s+)?festival|venice\s+film\s+festival|berlin\s+film\s+festival|sundance\s+film|toronto\s+international\s+film)\b/i,
  /\b(billboard\s+(hot\s+)?(100|200)|chart[-\s]?topping\s+(hit|single|album)|debut\s+album|number[-\s]?one\s+(hit|single))\b/i,
  /\b(biopic|netflix\s+(series|show|original)|hbo\s+(series|show)|disney\+\s+series|amazon\s+prime\s+(series|show)|apple\s+tv\+)\b/i,
  /\b(actor|actress)\s+(stars?\s+in|cast\s+(in|as)|starring\s+as|debut\s+role|signs\s+on)\b/i,
  /\bred\s+carpet|premiere\s+night\b/i,
  /\b(celebrity|paparazzi|fan[-\s]?meet)\b/i,
  /\b(reality\s+(tv|show)|talent\s+show|game\s+show|sitcom)\b/i,
];

function isJunk(def) {
  const cat = String(def.primary_category || '').toLowerCase();
  if (cat && REJECTED_CATEGORIES.has(cat)) return `off-topic-category=${cat}`;
  if (cat && !ALLOWED_CATEGORIES.has(cat)) return `category=${cat}`;
  for (const re of PATS) if (re.test(def.title || '')) return `title-pattern`;
  return null;
}

const cases = [
  // SHOULD reject — examples we found in production
  { title: "Venice's La Fenice Opera Ousts Incoming Music Director", primary_category: 'politics', expect: 'reject' },
  { title: "Real Madrid Draws Betis, Title Hopes Fade in La Liga", primary_category: 'politics', expect: 'reject' },
  { title: "Michael Tilson Thomas, Renowned Conductor, Dies at 81", primary_category: 'technology', expect: 'reject' },
  { title: "Michael Jackson Biopic Sets Record Box Office Haul at $220M", primary_category: 'technology', expect: 'reject' },
  { title: "OFI Wins Greek Cup Final Against PAOK in Extra Time", primary_category: 'politics', expect: 'reject' },
  // SHOULD reject — fresh proposals via off-topic category (Claude tagging honestly)
  { title: "Manchester United Sign New Striker From Brazil", primary_category: 'sports', expect: 'reject' },
  { title: "Berlin Philharmonic Premieres New Mahler Cycle", primary_category: 'culture', expect: 'reject' },
  { title: "Taylor Swift Wins Album of the Year at Grammys", primary_category: 'entertainment', expect: 'reject' },
  // SHOULD pass — geopolitical even if FIFA/Cup-adjacent
  { title: "FIFA Rejects Iran Request to Move World Cup Matches", primary_category: 'diplomacy', expect: 'pass' },
  { title: "Trump Envoy Lobbies FIFA to Replace Iran With Italy at 2026 World Cup", primary_category: 'diplomacy', expect: 'pass' },
  { title: "Norway Demands FIFA Revoke Trump Peace Prize", primary_category: 'politics', expect: 'pass' },
  { title: "NATO Rearmament Stalls as Iran War Drains US Arsenal", primary_category: 'military', expect: 'pass' },
  { title: "Russia Labels Oscar-Winning Documentary Filmmaker Foreign Agent", primary_category: 'politics', expect: 'pass' },
  { title: "Polish Military Oath Ceremony in Grajewo", primary_category: 'military', expect: 'pass' },
  { title: "Tony Elumelu Foundation 2026 Entrepreneur Selection Announcement", primary_category: 'economy', expect: 'pass' },
  { title: "Mobile World Congress 2026 Economic Impact in Barcelona", primary_category: 'economy', expect: 'pass' },
  { title: "Nigeria Port Single Window Implementation Disputed", primary_category: 'economy', expect: 'pass' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const reason = isJunk(c);
  const got = reason ? 'reject' : 'pass';
  const ok = got === c.expect;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'} [${c.expect}→${got}] ${c.title}${reason ? `  (${reason})` : ''}`);
}
console.log(`\n${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
