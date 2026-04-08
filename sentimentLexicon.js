/**
 * sentimentLexicon.js
 *
 * Zero-dependency, rule-based sentiment scorer tuned for news headlines
 * and short summaries. Produces a score in [-1, 1] that matches the shape
 * of news_articles.sentiment_score (previously only written by
 * deepAnalyzer.js via Claude Haiku).
 *
 * Design goals:
 *   - No external deps, no API calls, no Claude cost.
 *   - Handles negation ("not good"), intensifiers ("very bad"), and
 *     de-intensifiers ("slightly positive").
 *   - ~500 hand-picked high-signal words tuned for news (war, crisis,
 *     boom, surge, praise, condemn, etc.) rather than a generic movie-
 *     review lexicon.
 *   - Safe on any language for non-Latin text (it will just return 0 /
 *     insufficient); we use COALESCE(translated_title, title) upstream.
 *
 * Usage:
 *   const { scoreText, scoreArticle } = require('./sentimentLexicon');
 *   const score = scoreText('war breaks out, civilians flee');  // -0.78
 *   const score = scoreArticle({ title, summary, translated_title, translated_summary });
 *
 * The output is deliberately continuous and bounded so it can be written
 * directly to news_articles.sentiment_score.
 */

'use strict';

// ─── Lexicon ────────────────────────────────────────────────────────────────
// Weights in the range ~[-4, +4] (AFINN-style). Normalized at the end.
// Negative (crisis / violence / decline / blame)
const NEGATIVE = {
  // conflict & violence
  war: -3, wars: -3, warfare: -3, invasion: -3, invade: -3, invaded: -3, invading: -3,
  attack: -3, attacks: -3, attacked: -3, attacking: -3, strike: -2, strikes: -2,
  airstrike: -3, airstrikes: -3, bomb: -3, bombs: -3, bombing: -3, bombed: -3,
  shoot: -2, shooting: -3, shootings: -3, shot: -2, shots: -2,
  kill: -3, kills: -3, killed: -3, killing: -3, killings: -3, murder: -4, murdered: -4, murders: -4,
  assassinate: -4, assassinated: -4, assassination: -4,
  massacre: -4, genocide: -4, atrocity: -4, atrocities: -4,
  terror: -3, terrorism: -4, terrorist: -3, terrorists: -3,
  hostage: -3, hostages: -3, kidnap: -3, kidnapped: -3, kidnapping: -3, abduction: -3,
  torture: -4, tortured: -4, rape: -4, raped: -4, assault: -3, assaulted: -3,
  siege: -3, ambush: -3, ambushed: -3, militant: -2, militants: -2,
  insurgent: -2, insurgents: -2, rebel: -1, rebels: -1, clash: -2, clashes: -2, clashed: -2,
  riot: -3, riots: -3, unrest: -2, uprising: -2, coup: -3,
  gunfire: -3, shelling: -3, mortar: -3, missile: -2, missiles: -2, drone: -1, drones: -1,
  casualty: -3, casualties: -3, dead: -2, deaths: -2, death: -2, died: -2, dies: -2, dying: -2,
  wounded: -2, injured: -2, injuries: -2, injury: -2, hurt: -2, maim: -3, maimed: -3,
  displaced: -2, refugee: -2, refugees: -2, exodus: -2, flee: -2, fled: -2, fleeing: -2,
  evacuate: -1, evacuated: -1, evacuation: -1,
  // disaster
  disaster: -3, disasters: -3, catastrophe: -4, catastrophic: -4,
  quake: -2, earthquake: -3, tsunami: -3, hurricane: -2, typhoon: -2, cyclone: -2, tornado: -2,
  flood: -2, flooding: -2, floods: -2, floodwaters: -2,
  wildfire: -3, wildfires: -3, fire: -1, fires: -1, blaze: -2, inferno: -3,
  drought: -2, famine: -4, starvation: -4, starve: -3, starving: -3,
  collapse: -3, collapsed: -3, collapsing: -3, derail: -2, derailed: -2, crash: -2, crashes: -2, crashed: -2,
  spill: -2, spilled: -2, leak: -1, leaked: -1, explosion: -3, exploded: -3, blast: -2, blasts: -2,
  // health
  outbreak: -2, pandemic: -3, epidemic: -3, virus: -1, viruses: -1, infection: -1, infections: -1,
  disease: -2, diseases: -2, plague: -3, cancer: -2, tumor: -2,
  hospitalized: -2, overdose: -3, addict: -2, addiction: -2, suicide: -3, suicides: -3,
  // economy
  crisis: -3, crises: -3, recession: -3, depression: -3, downturn: -2, slowdown: -2,
  slump: -2, plunge: -2, plunged: -2, plummet: -3, plummeted: -3, tumble: -2, tumbled: -2,
  crash: -2, crashed: -2, crashes: -2, fall: -1, falls: -1, fell: -1, falling: -1,
  drop: -1, drops: -1, dropped: -1, decline: -2, declined: -2, declining: -2, declines: -2,
  loss: -2, losses: -2, lost: -2, losing: -2, shrink: -2, shrank: -2, shrinking: -2,
  bankrupt: -3, bankruptcy: -3, default: -2, defaulted: -2, defaults: -2, defaulting: -2,
  debt: -1, debts: -1, deficit: -1, deficits: -1, inflation: -1,
  layoff: -2, layoffs: -2, fired: -2, firing: -1, sack: -2, sacked: -2, sacking: -2,
  unemployment: -2, jobless: -2, downsize: -2, downsized: -2, downsizing: -2,
  shortage: -2, shortages: -2, expensive: -1,
  sanction: -2, sanctions: -2, sanctioned: -2, embargo: -2, tariff: -1, tariffs: -1,
  // crime / corruption
  crime: -2, crimes: -2, criminal: -2, criminals: -2, arrest: -1, arrested: -1, arrests: -1,
  charged: -1, indicted: -2, indictment: -2, convict: -2, convicted: -2, conviction: -2,
  guilty: -2, jail: -1, jailed: -2, imprisoned: -2, prison: -1, sentenced: -1,
  fraud: -3, scam: -3, scandal: -3, scandals: -3, corrupt: -3, corruption: -3,
  bribe: -3, bribed: -3, bribery: -3, embezzle: -3, embezzled: -3, embezzlement: -3,
  steal: -2, stole: -2, stolen: -2, theft: -2, robbery: -2, robbed: -2, robber: -2,
  extortion: -3, blackmail: -3, laundering: -3, trafficking: -3, smuggling: -2,
  illegal: -1, illicit: -2,
  // politics / criticism
  condemn: -2, condemned: -2, condemns: -2, condemnation: -2,
  criticize: -2, criticized: -2, criticism: -2, criticise: -2, criticised: -2,
  blame: -1, blamed: -1, blaming: -1, accuse: -2, accused: -2, accuses: -2, accusation: -2,
  allege: -1, alleged: -1, allegations: -2,
  threat: -2, threats: -2, threatened: -2, threatening: -2, warn: -1, warning: -1, warned: -1,
  protest: -1, protests: -1, protesters: -1, demonstration: -1, demonstrators: -1,
  strike: -1, boycott: -2, walkout: -1,
  polarize: -1, polarized: -1, polarizing: -1, division: -1, divisive: -2, divided: -1,
  hostility: -2, hostile: -2, aggression: -2, aggressive: -2, tension: -1, tensions: -2,
  dispute: -1, disputes: -1, disputed: -1, feud: -2,
  outrage: -3, outraged: -3, outrages: -3, furious: -3, fury: -3, anger: -2, angry: -2,
  fear: -2, fears: -2, feared: -2, fearful: -2, worried: -1, worries: -1, worry: -1, worrying: -2,
  alarm: -2, alarming: -3, alarmed: -2, panic: -3, panicked: -3, panicking: -3,
  concern: -1, concerns: -1, concerned: -1, troubled: -2, trouble: -1, troubles: -1, troubling: -2,
  // generic negatives
  bad: -2, worse: -2, worst: -3, terrible: -3, horrible: -3, horrific: -4, horrifying: -4,
  awful: -3, ghastly: -3, dreadful: -3, abysmal: -3, miserable: -2, tragic: -3, tragedy: -3,
  grim: -2, bleak: -2, dire: -3, devastating: -3, devastated: -3, devastation: -3,
  disaster: -3, failure: -2, fail: -2, failed: -2, failing: -2, failures: -2,
  flaw: -1, flawed: -1, broken: -1, damage: -2, damaged: -2, damages: -1, damaging: -2,
  destroy: -3, destroyed: -3, destroying: -3, destruction: -3,
  hate: -2, hated: -2, hatred: -3, toxic: -2, ugly: -2,
  sad: -1, sadness: -1, grief: -2, mourning: -2, mourn: -2, weep: -2,
  weak: -1, weaker: -1, weakened: -1, weakness: -1,
  risk: -1, risks: -1, risky: -2, danger: -2, dangers: -2, dangerous: -2, perilous: -2, peril: -2,
  crisis: -3, chaos: -3, chaotic: -3, turmoil: -3, unrest: -2,
  shock: -1, shocked: -1, shocking: -2,
  backlash: -2, setback: -2, setbacks: -2, obstacle: -1, hurdle: -1,
  stall: -1, stalled: -1, stalling: -1, struggle: -1, struggled: -1, struggling: -1, struggles: -1,
  suffer: -2, suffered: -2, suffering: -2, hardship: -2, hardships: -2,
  // misc
  dark: -1, darker: -1, darkest: -2, grim: -2, harsh: -1, harshly: -1,
  illicit: -2, immoral: -2, cruel: -3, brutal: -3, ruthless: -3,
};

// Positive (growth / success / peace / praise)
const POSITIVE = {
  // growth & success
  grow: 1, grows: 1, grew: 1, growing: 1, growth: 1,
  rise: 1, rises: 1, rose: 1, rising: 1, risen: 1,
  surge: 2, surged: 2, surges: 2, surging: 2,
  soar: 3, soared: 3, soaring: 3, skyrocket: 3, skyrocketed: 3,
  boom: 2, booming: 2, boomed: 2, boost: 2, boosted: 2, boosts: 2, boosting: 2,
  gain: 1, gained: 1, gains: 1, gaining: 1, increase: 1, increased: 1, increases: 1, increasing: 1,
  improve: 2, improved: 2, improves: 2, improving: 2, improvement: 2, improvements: 2,
  recover: 2, recovered: 2, recovery: 2, recovering: 2, rebound: 2, rebounded: 2, resurgence: 2,
  profit: 2, profits: 2, profitable: 2, revenue: 1, earnings: 1,
  record: 1, milestone: 2, breakthrough: 3, breakthroughs: 3, achievement: 2, achievements: 2,
  success: 2, successful: 2, successes: 2, succeed: 2, succeeded: 2, succeeding: 2,
  triumph: 3, triumphant: 3, victory: 2, victories: 2, victorious: 2, win: 2, wins: 2, won: 2, winning: 2,
  champion: 2, champions: 2, championship: 2,
  expand: 1, expanded: 1, expands: 1, expanding: 1, expansion: 1,
  thrive: 3, thrived: 3, thrives: 3, thriving: 3, flourish: 3, flourished: 3, flourishing: 3,
  prosper: 2, prospered: 2, prospering: 2, prosperity: 3, prosperous: 2,
  // peace / cooperation
  peace: 3, peaceful: 3, peacefully: 3, peacekeeping: 3,
  truce: 2, ceasefire: 3, armistice: 3, reconciliation: 3, reconcile: 2, reconciled: 2,
  agreement: 1, deal: 1, deals: 1, accord: 2, treaty: 2, pact: 1,
  cooperation: 2, cooperate: 2, cooperated: 2, partnership: 2, ally: 1, allies: 1, allied: 1,
  unite: 2, united: 2, unity: 2, solidarity: 2, together: 1,
  dialogue: 1, diplomacy: 2, diplomatic: 1, negotiate: 1, negotiated: 1, negotiation: 1, negotiations: 1,
  resolve: 1, resolved: 1, resolution: 1, settle: 1, settled: 1, settlement: 1,
  // praise / approval
  praise: 3, praised: 3, praises: 3, praising: 3, applaud: 2, applauded: 2, applause: 2,
  celebrate: 2, celebrated: 2, celebrates: 2, celebration: 2, celebrations: 2, celebrating: 2,
  honor: 2, honored: 2, honoring: 2, honour: 2, honoured: 2,
  hero: 3, heroes: 3, heroic: 3, brave: 2, bravely: 2, bravery: 2, courage: 2, courageous: 2,
  award: 2, awards: 2, awarded: 2, prize: 2, medal: 2, nobel: 3,
  endorse: 1, endorsed: 1, endorsement: 1, endorses: 1,
  welcome: 1, welcomed: 1, welcomes: 1, welcoming: 1, hail: 2, hailed: 2, hailing: 2,
  support: 1, supported: 1, supports: 1, supportive: 2, supporting: 1, supporter: 1, supporters: 1,
  approve: 1, approved: 1, approves: 1, approval: 1,
  // relief / help / healing
  relief: 2, relieve: 2, relieved: 2, rescue: 2, rescued: 2, rescues: 2, rescuing: 2,
  save: 2, saved: 2, saves: 2, saving: 2, saviour: 3, savior: 3,
  help: 1, helped: 1, helps: 1, helping: 1, helpful: 2,
  aid: 1, aided: 1, assist: 1, assisted: 1, assistance: 1,
  heal: 2, healed: 2, healing: 2, cure: 2, cured: 2, cures: 2, curing: 2, remedy: 2,
  donate: 2, donated: 2, donation: 2, donations: 2, charity: 2, generous: 2, generosity: 2,
  hope: 2, hopeful: 2, hopes: 2, optimism: 2, optimistic: 2,
  // generic positives
  good: 2, better: 2, best: 3, great: 2, greatest: 3, excellent: 3, outstanding: 3, exceptional: 3,
  wonderful: 3, amazing: 3, remarkable: 3, impressive: 2, stunning: 3, incredible: 3,
  fantastic: 3, fabulous: 3, brilliant: 3, marvelous: 3, marvellous: 3, superb: 3,
  strong: 1, stronger: 1, strongest: 2, strength: 1, robust: 2, solid: 1, sturdy: 1,
  positive: 2, positively: 2, benefit: 1, benefits: 1, beneficial: 2,
  effective: 1, efficient: 1, productive: 1, valuable: 2, worth: 1, worthwhile: 2,
  happy: 2, happier: 2, happiest: 3, happiness: 2, joy: 3, joyful: 3, joyous: 3, delight: 2, delighted: 2,
  love: 3, loved: 3, loves: 3, loving: 2, beloved: 3,
  smile: 2, smiled: 2, smiles: 2, smiling: 2, laugh: 1, laughed: 1, laughing: 1, laughter: 2,
  safe: 1, safer: 1, safest: 2, safety: 1, secure: 1, secured: 1, security: 1,
  free: 1, freed: 1, freedom: 2, liberate: 2, liberated: 2, liberation: 2,
  innovate: 2, innovated: 2, innovation: 2, innovative: 2, advance: 1, advanced: 1, advancement: 2,
  progress: 2, progressed: 2, progressing: 2, progressive: 1, forward: 1,
  clean: 1, clear: 1, bright: 2, brightest: 2, brilliant: 2, shine: 1, shining: 1,
  kind: 1, kinder: 1, kindness: 2, compassion: 2, compassionate: 2, gentle: 1,
  smart: 1, wise: 1, wisdom: 2, talented: 2, gifted: 2, genius: 3,
  clean: 1, fresh: 1, healthy: 2, healthier: 2, wellness: 2, fit: 1, fitness: 1,
  green: 1, sustainable: 2, renewable: 2, eco: 1,
  popular: 1, favorite: 1, beloved: 3, admired: 2,
  fair: 1, fairness: 1, just: 1, justice: 2, equitable: 2, equality: 2,
};

// Intensifiers / dampeners (multiplicative)
const INTENSIFIERS = {
  very: 1.35, extremely: 1.55, incredibly: 1.55, remarkably: 1.45, exceptionally: 1.55,
  absolutely: 1.45, utterly: 1.5, totally: 1.4, completely: 1.4, highly: 1.3, deeply: 1.35,
  'so': 1.2, really: 1.25, truly: 1.3, quite: 1.15, particularly: 1.2, especially: 1.25,
  massively: 1.55, hugely: 1.5, severely: 1.5, greatly: 1.35, significantly: 1.3, vastly: 1.45,
};
const DAMPENERS = {
  slightly: 0.55, somewhat: 0.7, barely: 0.4, hardly: 0.3, scarcely: 0.3,
  marginally: 0.55, kind: 0.7, sort: 0.7, rather: 0.85, fairly: 0.8,
  partially: 0.75, moderately: 0.8, relatively: 0.85, 'a little': 0.6, 'a bit': 0.6,
};
const NEGATORS = new Set([
  'not','no','never','none','nothing','nobody','nowhere','neither','nor',
  "n't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "won't", "wouldn't", "can't", "cannot", "couldn't", "shouldn't", "hasn't",
  "haven't", "hadn't"
]);

// ─── Tokenizer ──────────────────────────────────────────────────────────────
function tokenize(text) {
  if (!text) return [];
  // Lowercase, keep apostrophes so contractions survive, strip punctuation
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ─── Core scorer ────────────────────────────────────────────────────────────
/**
 * scoreText(text) -> number in [-1, 1], or null if text had no signal.
 *
 * Algorithm:
 *   1. Tokenize.
 *   2. For each token, look up its base weight in POS/NEG.
 *   3. Apply intensifier/dampener from the preceding 1-2 tokens.
 *   4. Apply negation flip if any NEGATOR appeared in the preceding 3 tokens
 *      (capped at sentence boundary — we treat '.', '!', '?' as resets but
 *      we already stripped punctuation, so we use a token-distance heuristic).
 *   5. Sum weighted scores, divide by sqrt(sum of |weights| + 4) for a
 *      smooth normalization similar to VADER's.
 *   6. Clamp to [-1, 1].
 */
function scoreText(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;

  let sum = 0;
  let absSum = 0;
  let matched = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let w = 0;
    if (NEGATIVE[tok] !== undefined)      w = NEGATIVE[tok];
    else if (POSITIVE[tok] !== undefined) w = POSITIVE[tok];
    if (w === 0) continue;

    // Intensifier / dampener (prev 1-2 tokens)
    for (let k = 1; k <= 2 && i - k >= 0; k++) {
      const pv = tokens[i - k];
      if (INTENSIFIERS[pv] !== undefined) { w *= INTENSIFIERS[pv]; break; }
      if (DAMPENERS[pv]    !== undefined) { w *= DAMPENERS[pv];    break; }
    }

    // Negation: flip & dampen if a negator appears within 3 preceding tokens
    let negated = false;
    for (let k = 1; k <= 3 && i - k >= 0; k++) {
      const pv = tokens[i - k];
      if (NEGATORS.has(pv) || pv.endsWith("n't")) { negated = true; break; }
    }
    if (negated) w = -w * 0.75;

    sum    += w;
    absSum += Math.abs(w);
    matched++;
  }

  if (!matched) return null;

  // VADER-inspired normalization: sum / sqrt(sum^2 + alpha)
  const ALPHA = 15;
  const normalized = sum / Math.sqrt(sum * sum + ALPHA);
  return Math.max(-1, Math.min(1, normalized));
}

/**
 * scoreArticle(row) -> { score: number | null, matched: boolean }
 *
 * Picks the best available text fields (prefers translated when present),
 * concatenates title + summary, and runs scoreText.
 */
function scoreArticle(row) {
  if (!row) return { score: null, matched: false };
  const title   = row.translated_title   || row.title   || '';
  const summary = row.translated_summary || row.summary || '';
  const combined = `${title}. ${summary}`.trim();
  const s = scoreText(combined);
  return { score: s, matched: s !== null };
}

module.exports = { scoreText, scoreArticle, tokenize };
