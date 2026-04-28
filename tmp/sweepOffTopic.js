// Read-only sweep. Mirror the *exact* JUNK_TITLE_PATTERNS additions
// in storyThreadBuilder.js so the impact preview matches the runtime.
//
// Cap DB_POOL_MAX before requiring ./db — single-connection script
// run by humans for debugging; cap=2 leaves the web server's pool
// untouched even if invoked during peak traffic.
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '2';

require('dotenv').config({ path: __dirname + '/../.env' });
const pool = require('../db');

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

(async () => {
  const { rows } = await pool.query(
    `SELECT id, title, primary_category, status
       FROM story_threads
      WHERE status IN ('active','cooling','dormant')`
  );
  const offenders = [];
  for (const r of rows) {
    for (const re of PATS) {
      if (re.test(r.title || '')) {
        offenders.push({ id: r.id, status: r.status, cat: r.primary_category, title: r.title, matched: re.source.slice(0, 60) });
        break;
      }
    }
  }
  const byStatus = {};
  for (const o of offenders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  console.log(`Total offenders: ${offenders.length} (out of ${rows.length} threads)`);
  console.log('  by status:', byStatus);
  console.log('\nAll matches (sorted by status):');
  offenders.sort((a, b) => (a.status > b.status ? 1 : -1));
  for (const o of offenders) {
    console.log(`  #${o.id} [${o.status}/${o.cat}] ${o.title}`);
    console.log(`     ↳ ${o.matched}`);
  }
  await pool.end();
})().catch(e => { console.error(e.stack); process.exit(1); });
