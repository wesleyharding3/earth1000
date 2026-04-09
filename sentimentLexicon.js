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

// ─── Multilingual lexicons ──────────────────────────────────────────────────
// Compact news-tuned lexicons keyed by language code (ISO 639-1).
// These are NOT exhaustive — just the highest-signal ~80-120 words per
// language covering: war/violence/crisis/disaster/death/corruption on the
// negative side, peace/growth/victory/success/relief on the positive side.
// Weights mirror the English scale [-4, +4]. Normalization is unchanged,
// so scores stay comparable across languages.

// Spanish
const ES = {
  // negative
  guerra: -3, guerras: -3, invasión: -3, invasion: -3, invadir: -3, invaden: -3,
  ataque: -3, ataques: -3, atacar: -3, atacaron: -3, bombardeo: -3, bomba: -3, bombas: -3,
  muerte: -2, muertes: -2, muerto: -2, muertos: -2, murió: -2, murieron: -2, matar: -3, mataron: -3, asesinato: -4, asesinados: -4,
  masacre: -4, terror: -3, terrorista: -3, terroristas: -3, terrorismo: -4, rehén: -3, rehenes: -3, secuestro: -3, secuestrados: -3,
  herido: -2, heridos: -2, víctima: -2, víctimas: -2, herida: -2, lesionado: -2, lesionados: -2,
  desastre: -3, catástrofe: -4, tragedia: -3, trágico: -3, terremoto: -3, tsunami: -3, huracán: -2, inundación: -2, inundaciones: -2, incendio: -2, sequía: -2, hambre: -3, hambruna: -4,
  crisis: -3, recesión: -3, quiebra: -3, bancarrota: -3, colapso: -3, desplomar: -3, desplome: -3, caída: -1, caer: -1, cayó: -1, bajaron: -1, pérdida: -2, pérdidas: -2, deuda: -1, déficit: -1, desempleo: -2, despido: -2, despidos: -2, inflación: -1,
  corrupción: -3, corrupto: -3, fraude: -3, soborno: -3, escándalo: -3, delito: -2, crimen: -2, criminal: -2, robo: -2, asalto: -3, arresto: -1, arrestado: -1, condenado: -2, culpable: -2, cárcel: -1,
  protesta: -1, protestas: -1, manifestación: -1, disturbios: -3, violencia: -3, violento: -3, brutal: -3, cruel: -3,
  amenaza: -2, amenazas: -2, sanción: -2, sanciones: -2, conflicto: -2, conflictos: -2, tensión: -1, tensiones: -2,
  miedo: -2, temor: -2, pánico: -3, preocupación: -1, preocupado: -1, preocupante: -2,
  fracaso: -2, fracasar: -2, fallido: -2, fallo: -1, peligro: -2, peligroso: -2, grave: -2, terrible: -3, horrible: -3, horror: -3, horrendo: -4,
  triste: -1, tristeza: -1, sufrir: -2, sufrimiento: -2, dolor: -2, daño: -2, dañado: -2, destrucción: -3, destruido: -3,
  odio: -3, odiar: -2, enfermedad: -2, virus: -1, pandemia: -3, epidemia: -3, contagio: -2,
  // positive
  paz: 3, pacífico: 3, tregua: 2, acuerdo: 1, acuerdos: 1, tratado: 2, alianza: 2, cooperación: 2,
  victoria: 2, victorias: 2, victorioso: 2, ganar: 2, ganó: 2, ganaron: 2, triunfo: 3, triunfar: 3, éxito: 2, exitoso: 2, logro: 2, logros: 2, récord: 1,
  crecimiento: 2, crecer: 2, creció: 1, crecen: 1, aumento: 1, aumentar: 1, aumentó: 1, auge: 2, expansión: 1, mejora: 2, mejoras: 2, mejorar: 2, mejoró: 2, recuperación: 2, recuperar: 2, recuperó: 2,
  beneficio: 1, beneficios: 1, ganancia: 1, ganancias: 1, prosperidad: 3, próspero: 2,
  rescate: 2, rescatado: 2, salvar: 2, salvado: 2, héroe: 3, heroico: 3, valiente: 2, ayuda: 1, ayudar: 1, apoyo: 1, apoyar: 1, solidaridad: 2, generoso: 2, donación: 2,
  bueno: 2, buena: 2, mejor: 2, excelente: 3, gran: 2, grande: 1, impresionante: 2, maravilloso: 3, increíble: 3, fantástico: 3, fabuloso: 3, extraordinario: 3,
  feliz: 2, felicidad: 2, alegría: 3, amor: 3, amado: 3, esperanza: 2, esperanzador: 2, optimismo: 2,
  libre: 1, libertad: 2, liberado: 2, liberación: 2, seguro: 1, seguridad: 1, salud: 1, sano: 2, saludable: 2, curación: 2, curar: 2, sanar: 2,
  celebrar: 2, celebración: 2, homenaje: 2, premio: 2, premiado: 2, aplaudir: 2, elogiar: 2, elogio: 2,
  fuerte: 1, fortaleza: 1, firme: 1, justo: 1, justicia: 2, progreso: 2, innovación: 2, innovador: 2,
};

// French
const FR = {
  // negative
  guerre: -3, guerres: -3, invasion: -3, envahir: -3, attaque: -3, attaques: -3, attaquer: -3, bombardement: -3, bombe: -3, bombes: -3, tir: -2, tirs: -2, fusillade: -3,
  mort: -2, morts: -2, mourir: -2, tuer: -3, tué: -3, tués: -3, meurtre: -4, assassinat: -4, assassiné: -4, massacre: -4,
  terreur: -3, terrorisme: -4, terroriste: -3, terroristes: -3, otage: -3, otages: -3, enlèvement: -3, enlevé: -3,
  blessé: -2, blessés: -2, victime: -2, victimes: -2, casualty: -3,
  catastrophe: -4, désastre: -3, tragédie: -3, tragique: -3, séisme: -3, tsunami: -3, ouragan: -2, inondation: -2, inondations: -2, incendie: -2, sécheresse: -2, famine: -4,
  crise: -3, récession: -3, faillite: -3, effondrement: -3, effondrer: -3, chute: -1, tomber: -1, perdre: -1, perte: -2, pertes: -2, dette: -1, déficit: -1, chômage: -2, licenciement: -2, licenciements: -2, inflation: -1,
  corruption: -3, corrompu: -3, fraude: -3, pot: -2, escroquerie: -3, scandale: -3, crime: -2, criminel: -2, vol: -2, arrêté: -1, condamné: -2, coupable: -2, prison: -1,
  manifestation: -1, manifestations: -1, émeute: -3, émeutes: -3, violence: -3, violent: -3, brutal: -3, cruel: -3,
  menace: -2, menaces: -2, sanction: -2, sanctions: -2, conflit: -2, conflits: -2, tension: -1, tensions: -2,
  peur: -2, crainte: -2, craintes: -2, panique: -3, inquiet: -1, inquiétude: -1, inquiétant: -2, alarmant: -3,
  échec: -2, échoué: -2, danger: -2, dangereux: -2, grave: -2, terrible: -3, horrible: -3, horreur: -3,
  triste: -1, tristesse: -1, souffrir: -2, souffrance: -2, douleur: -2, dommage: -2, dégât: -2, dégâts: -2, destruction: -3, détruit: -3,
  haine: -3, détester: -2, maladie: -2, virus: -1, pandémie: -3, épidémie: -3,
  // positive
  paix: 3, paisible: 3, trêve: 2, accord: 1, accords: 1, traité: 2, alliance: 2, coopération: 2,
  victoire: 2, victoires: 2, gagner: 2, gagné: 2, triomphe: 3, succès: 2, réussi: 2, réussite: 2, exploit: 2, record: 1,
  croissance: 2, croître: 2, augmenter: 1, augmentation: 1, hausse: 1, boom: 2, expansion: 1, amélioration: 2, amélioré: 2, améliorer: 2, reprise: 2, récupérer: 2,
  profit: 2, profits: 2, bénéfice: 1, bénéfices: 1, prospérité: 3, prospère: 2,
  sauvetage: 2, sauver: 2, sauvé: 2, héros: 3, héroïque: 3, courageux: 2, courage: 2, aider: 1, aide: 1, soutien: 1, soutenir: 1, solidarité: 2, généreux: 2, don: 1, dons: 1,
  bon: 2, bonne: 2, meilleur: 2, excellent: 3, grand: 1, formidable: 3, magnifique: 3, incroyable: 3, fantastique: 3, fabuleux: 3, extraordinaire: 3,
  heureux: 2, bonheur: 2, joie: 3, amour: 3, aimé: 3, espoir: 2, optimisme: 2,
  libre: 1, liberté: 2, libéré: 2, libération: 2, sûr: 1, sécurité: 1, santé: 1, sain: 2, guérison: 2, guérir: 2,
  célébrer: 2, célébration: 2, hommage: 2, prix: 1, récompense: 2, applaudir: 2, saluer: 2, louange: 2,
  fort: 1, force: 1, ferme: 1, juste: 1, justice: 2, progrès: 2, innovation: 2,
};

// Portuguese
const PT = {
  // negative
  guerra: -3, guerras: -3, invasão: -3, invadir: -3, ataque: -3, ataques: -3, atacar: -3, bombardeio: -3, bomba: -3, bombas: -3, tiroteio: -3,
  morte: -2, mortes: -2, morto: -2, mortos: -2, morrer: -2, morreu: -2, morreram: -2, matar: -3, mataram: -3, assassinato: -4, assassinados: -4, massacre: -4,
  terror: -3, terrorismo: -4, terrorista: -3, terroristas: -3, refém: -3, reféns: -3, sequestro: -3, sequestrados: -3,
  ferido: -2, feridos: -2, vítima: -2, vítimas: -2,
  desastre: -3, catástrofe: -4, tragédia: -3, trágico: -3, terremoto: -3, tsunami: -3, furacão: -2, enchente: -2, enchentes: -2, incêndio: -2, seca: -2, fome: -3,
  crise: -3, recessão: -3, falência: -3, colapso: -3, queda: -1, cair: -1, caiu: -1, caíram: -1, perda: -2, perdas: -2, dívida: -1, déficit: -1, desemprego: -2, demissão: -2, demissões: -2, inflação: -1,
  corrupção: -3, corrupto: -3, fraude: -3, suborno: -3, escândalo: -3, crime: -2, criminoso: -2, roubo: -2, preso: -1, condenado: -2, culpado: -2, prisão: -1, cadeia: -1,
  protesto: -1, protestos: -1, manifestação: -1, distúrbios: -3, violência: -3, violento: -3, brutal: -3, cruel: -3,
  ameaça: -2, ameaças: -2, sanção: -2, sanções: -2, conflito: -2, conflitos: -2, tensão: -1, tensões: -2,
  medo: -2, temor: -2, pânico: -3, preocupação: -1, preocupado: -1, preocupante: -2, alarmante: -3,
  fracasso: -2, falhou: -2, perigo: -2, perigoso: -2, grave: -2, terrível: -3, horrível: -3, horror: -3,
  triste: -1, tristeza: -1, sofrer: -2, sofrimento: -2, dor: -2, dano: -2, danos: -2, destruição: -3, destruído: -3,
  ódio: -3, odiar: -2, doença: -2, vírus: -1, pandemia: -3, epidemia: -3,
  // positive
  paz: 3, pacífico: 3, trégua: 2, acordo: 1, acordos: 1, tratado: 2, aliança: 2, cooperação: 2,
  vitória: 2, vitórias: 2, vencer: 2, venceu: 2, triunfo: 3, sucesso: 2, êxito: 2, conquista: 2, conquistas: 2, recorde: 1,
  crescimento: 2, crescer: 2, cresceu: 1, aumento: 1, aumentar: 1, alta: 1, expansão: 1, melhoria: 2, melhorias: 2, melhorar: 2, melhorou: 2, recuperação: 2, recuperar: 2,
  lucro: 2, lucros: 2, ganho: 1, ganhos: 1, prosperidade: 3, próspero: 2,
  resgate: 2, resgatado: 2, salvar: 2, salvo: 2, salvos: 2, herói: 3, heroico: 3, corajoso: 2, coragem: 2, ajuda: 1, ajudar: 1, apoio: 1, apoiar: 1, solidariedade: 2, generoso: 2, doação: 2,
  bom: 2, boa: 2, melhor: 2, ótimo: 3, excelente: 3, grande: 1, impressionante: 2, maravilhoso: 3, incrível: 3, fantástico: 3,
  feliz: 2, felicidade: 2, alegria: 3, amor: 3, amado: 3, esperança: 2, otimismo: 2,
  livre: 1, liberdade: 2, libertado: 2, libertação: 2, seguro: 1, segurança: 1, saúde: 1, saudável: 2, cura: 2, curar: 2,
  celebrar: 2, celebração: 2, homenagem: 2, prêmio: 2, premiado: 2, aplaudir: 2, elogiar: 2, elogio: 2,
  forte: 1, força: 1, firme: 1, justo: 1, justiça: 2, progresso: 2, inovação: 2,
};

// German
const DE = {
  // negative
  krieg: -3, kriege: -3, invasion: -3, angriff: -3, angriffe: -3, angreifen: -3, bombardierung: -3, bombe: -3, bomben: -3, schießerei: -3,
  tod: -2, tote: -2, toter: -2, sterben: -2, getötet: -3, ermordet: -4, mord: -4, morde: -4, attentat: -4, massaker: -4,
  terror: -3, terrorismus: -4, terrorist: -3, terroristen: -3, geisel: -3, geiseln: -3, entführung: -3, entführt: -3,
  verletzt: -2, verletzte: -2, opfer: -2, verletzung: -2,
  katastrophe: -4, tragödie: -3, tragisch: -3, erdbeben: -3, tsunami: -3, hurrikan: -2, überschwemmung: -2, flut: -2, brand: -1, waldbrand: -3, dürre: -2, hunger: -3, hungersnot: -4,
  krise: -3, rezession: -3, insolvenz: -3, bankrott: -3, zusammenbruch: -3, sturz: -1, fallen: -1, verlust: -2, verluste: -2, schulden: -1, defizit: -1, arbeitslosigkeit: -2, entlassung: -2, entlassungen: -2, inflation: -1,
  korruption: -3, korrupt: -3, betrug: -3, bestechung: -3, skandal: -3, verbrechen: -2, kriminell: -2, diebstahl: -2, verhaftet: -1, verurteilt: -2, schuldig: -2, gefängnis: -1,
  protest: -1, proteste: -1, demonstration: -1, unruhen: -3, gewalt: -3, gewalttätig: -3, brutal: -3, grausam: -3,
  bedrohung: -2, bedrohungen: -2, sanktion: -2, sanktionen: -2, konflikt: -2, konflikte: -2, spannung: -1, spannungen: -2,
  angst: -2, furcht: -2, panik: -3, besorgt: -1, besorgnis: -1, besorgniserregend: -2, alarmierend: -3,
  versagen: -2, scheitern: -2, gescheitert: -2, gefahr: -2, gefährlich: -2, schwer: -1, schrecklich: -3, furchtbar: -3, schlimm: -2, schlimmer: -2, schlimmste: -3,
  traurig: -1, trauer: -2, leiden: -2, leid: -2, schmerz: -2, schaden: -2, schäden: -2, zerstörung: -3, zerstört: -3,
  hass: -3, hassen: -2, krankheit: -2, virus: -1, pandemie: -3, epidemie: -3,
  // extras (politik, wirtschaft, alltag)
  streik: -2, streiks: -2, gesperrt: -1, sperre: -1, razzia: -2, festnahme: -1, festgenommen: -1, ermittlung: -1, ermittlungen: -1, vorwurf: -1, vorwürfe: -2, klage: -1, urteil: -1, strafe: -1, bestraft: -1,
  konkurs: -3, rückgang: -1, rückgänge: -1, sorge: -1, sorgen: -1, streit: -2, streitigkeiten: -2, auseinandersetzung: -2, drohung: -2, warnung: -1, warnungen: -1, alarm: -2,
  unfall: -2, unfälle: -2, verletzter: -2, kollision: -2, zusammenstoß: -2, explosion: -3, explosionen: -3,
  // positive
  frieden: 3, friedlich: 3, waffenstillstand: 3, abkommen: 1, vertrag: 2, bündnis: 2, zusammenarbeit: 2,
  sieg: 2, siege: 2, siegen: 2, gewonnen: 2, gewinnen: 2, triumph: 3, erfolg: 2, erfolgreich: 2, errungenschaft: 2, rekord: 1,
  wachstum: 2, wachsen: 2, anstieg: 1, steigen: 1, gestiegen: 1, boom: 2, aufschwung: 2, expansion: 1, verbesserung: 2, verbessern: 2, verbessert: 2, erholung: 2, erholen: 2,
  gewinn: 2, gewinne: 2, profit: 2, wohlstand: 3,
  rettung: 2, gerettet: 2, retten: 2, held: 3, helden: 3, heldenhaft: 3, mutig: 2, mut: 2, hilfe: 1, helfen: 1, unterstützung: 1, unterstützen: 1, solidarität: 2, großzügig: 2, spende: 2, spenden: 2,
  gut: 2, gute: 2, besser: 2, beste: 2, ausgezeichnet: 3, hervorragend: 3, groß: 1, wunderbar: 3, erstaunlich: 3, fantastisch: 3, großartig: 3,
  glücklich: 2, glück: 2, freude: 3, liebe: 3, geliebt: 3, hoffnung: 2, optimismus: 2,
  frei: 1, freiheit: 2, befreit: 2, befreiung: 2, sicher: 1, sicherheit: 1, gesundheit: 1, gesund: 2, heilung: 2, heilen: 2,
  feiern: 2, feier: 2, ehre: 2, preis: 1, auszeichnung: 2, beifall: 2, lob: 2, loben: 2,
  stark: 1, stärke: 1, fest: 1, gerecht: 1, gerechtigkeit: 2, fortschritt: 2, innovation: 2,
};

// Italian
const IT = {
  // negative
  guerra: -3, guerre: -3, invasione: -3, invadere: -3, attacco: -3, attacchi: -3, attaccare: -3, bombardamento: -3, bomba: -3, bombe: -3, sparatoria: -3,
  morte: -2, morti: -2, morto: -2, morire: -2, ucciso: -3, uccisi: -3, uccidere: -3, omicidio: -4, assassinio: -4, strage: -4, massacro: -4,
  terrore: -3, terrorismo: -4, terrorista: -3, terroristi: -3, ostaggio: -3, ostaggi: -3, rapimento: -3, rapito: -3,
  ferito: -2, feriti: -2, vittima: -2, vittime: -2,
  disastro: -3, catastrofe: -4, tragedia: -3, tragico: -3, terremoto: -3, tsunami: -3, uragano: -2, alluvione: -2, inondazione: -2, incendio: -2, siccità: -2, carestia: -4,
  crisi: -3, recessione: -3, fallimento: -3, bancarotta: -3, crollo: -3, crollare: -3, caduta: -1, cadere: -1, perdita: -2, perdite: -2, debito: -1, disoccupazione: -2, licenziamento: -2, licenziamenti: -2, inflazione: -1,
  corruzione: -3, corrotto: -3, frode: -3, tangente: -3, scandalo: -3, crimine: -2, criminale: -2, furto: -2, arrestato: -1, condannato: -2, colpevole: -2, carcere: -1, prigione: -1,
  protesta: -1, proteste: -1, manifestazione: -1, rivolta: -3, violenza: -3, violento: -3, brutale: -3, crudele: -3,
  minaccia: -2, minacce: -2, sanzione: -2, sanzioni: -2, conflitto: -2, conflitti: -2, tensione: -1, tensioni: -2,
  paura: -2, panico: -3, preoccupazione: -1, preoccupato: -1, preoccupante: -2, allarmante: -3,
  fallimento: -2, fallito: -2, pericolo: -2, pericoloso: -2, grave: -2, terribile: -3, orribile: -3, orrore: -3,
  triste: -1, tristezza: -1, soffrire: -2, sofferenza: -2, dolore: -2, danno: -2, danni: -2, distruzione: -3, distrutto: -3,
  odio: -3, odiare: -2, malattia: -2, virus: -1, pandemia: -3, epidemia: -3,
  // positive
  pace: 3, pacifico: 3, tregua: 2, accordo: 1, accordi: 1, trattato: 2, alleanza: 2, cooperazione: 2,
  vittoria: 2, vittorie: 2, vincere: 2, vinto: 2, trionfo: 3, successo: 2, successi: 2, riuscito: 2, record: 1, primato: 2,
  crescita: 2, crescere: 2, aumento: 1, aumentare: 1, rialzo: 1, boom: 2, espansione: 1, miglioramento: 2, migliorare: 2, migliorato: 2, ripresa: 2, recuperare: 2,
  profitto: 2, profitti: 2, guadagno: 1, guadagni: 1, prosperità: 3, prospero: 2,
  salvataggio: 2, salvato: 2, salvare: 2, eroe: 3, eroico: 3, coraggioso: 2, coraggio: 2, aiuto: 1, aiutare: 1, sostegno: 1, sostenere: 1, solidarietà: 2, generoso: 2, donazione: 2,
  buono: 2, buona: 2, migliore: 2, ottimo: 3, eccellente: 3, grande: 1, meraviglioso: 3, incredibile: 3, straordinario: 3, fantastico: 3,
  felice: 2, felicità: 2, gioia: 3, amore: 3, amato: 3, speranza: 2, ottimismo: 2,
  libero: 1, libertà: 2, liberato: 2, liberazione: 2, sicuro: 1, sicurezza: 1, salute: 1, sano: 2, guarigione: 2, guarire: 2,
  celebrare: 2, celebrazione: 2, omaggio: 2, premio: 2, premiato: 2, applaudire: 2, elogiare: 2, elogio: 2,
  forte: 1, forza: 1, fermo: 1, giusto: 1, giustizia: 2, progresso: 2, innovazione: 2,
};

// Dutch
const NL = {
  // negative
  oorlog: -3, oorlogen: -3, invasie: -3, aanval: -3, aanvallen: -3, bombardement: -3, bom: -3, bommen: -3, schietpartij: -3,
  dood: -2, doden: -2, gedood: -3, sterven: -2, gestorven: -2, vermoord: -4, moord: -4, moorden: -4, aanslag: -4, bloedbad: -4,
  terreur: -3, terrorisme: -4, terrorist: -3, terroristen: -3, gijzelaar: -3, gijzelaars: -3, ontvoering: -3, ontvoerd: -3,
  gewond: -2, gewonden: -2, slachtoffer: -2, slachtoffers: -2,
  ramp: -3, catastrofe: -4, tragedie: -3, tragisch: -3, aardbeving: -3, tsunami: -3, orkaan: -2, overstroming: -2, brand: -1, bosbrand: -3, droogte: -2, hongersnood: -4,
  crisis: -3, recessie: -3, faillissement: -3, instorting: -3, val: -1, vallen: -1, verlies: -2, verliezen: -2, schuld: -1, tekort: -1, werkloosheid: -2, ontslag: -2, ontslagen: -2, inflatie: -1,
  corruptie: -3, corrupt: -3, fraude: -3, omkoping: -3, schandaal: -3, misdaad: -2, crimineel: -2, diefstal: -2, gearresteerd: -1, veroordeeld: -2, schuldig: -2, gevangenis: -1,
  protest: -1, protesten: -1, demonstratie: -1, rellen: -3, geweld: -3, gewelddadig: -3, brutaal: -3, wreed: -3,
  dreiging: -2, dreigingen: -2, sanctie: -2, sancties: -2, conflict: -2, conflicten: -2, spanning: -1, spanningen: -2,
  angst: -2, vrees: -2, paniek: -3, bezorgd: -1, zorgen: -1, zorgwekkend: -2, alarmerend: -3,
  mislukking: -2, mislukt: -2, gevaar: -2, gevaarlijk: -2, ernstig: -2, vreselijk: -3, verschrikkelijk: -3, horror: -3,
  verdrietig: -1, verdriet: -1, lijden: -2, pijn: -2, schade: -2, vernietiging: -3, vernietigd: -3,
  haat: -3, haten: -2, ziekte: -2, virus: -1, pandemie: -3, epidemie: -3,
  // positive
  vrede: 3, vreedzaam: 3, wapenstilstand: 3, akkoord: 1, verdrag: 2, alliantie: 2, samenwerking: 2,
  overwinning: 2, winnen: 2, gewonnen: 2, triomf: 3, succes: 2, succesvol: 2, prestatie: 2, record: 1,
  groei: 2, groeien: 2, stijging: 1, stijgen: 1, gestegen: 1, boom: 2, expansie: 1, verbetering: 2, verbeteren: 2, verbeterd: 2, herstel: 2, herstellen: 2,
  winst: 2, winsten: 2, voordeel: 1, welvaart: 3,
  redding: 2, gered: 2, redden: 2, held: 3, helden: 3, heroïsch: 3, moedig: 2, moed: 2, hulp: 1, helpen: 1, steun: 1, solidariteit: 2, gul: 2, donatie: 2,
  goed: 2, beter: 2, beste: 2, uitstekend: 3, groot: 1, prachtig: 3, geweldig: 3, fantastisch: 3, ongelooflijk: 3,
  gelukkig: 2, geluk: 2, vreugde: 3, liefde: 3, geliefd: 3, hoop: 2, optimisme: 2,
  vrij: 1, vrijheid: 2, bevrijd: 2, bevrijding: 2, veilig: 1, veiligheid: 1, gezondheid: 1, gezond: 2, genezing: 2, genezen: 2,
  vieren: 2, viering: 2, eer: 2, prijs: 1, onderscheiding: 2, applaus: 2, prijzen: 2, lof: 2,
  sterk: 1, kracht: 1, vast: 1, eerlijk: 1, rechtvaardig: 2, rechtvaardigheid: 2, vooruitgang: 2, innovatie: 2,
};

// Russian (cyrillic — tokenizer already keeps unicode via regex update below)
const RU = {
  // negative
  война: -3, войны: -3, вторжение: -3, нападение: -3, нападения: -3, атака: -3, атаки: -3, бомба: -3, бомбы: -3, обстрел: -3, теракт: -4, теракты: -4,
  смерть: -2, смерти: -2, погиб: -2, погибли: -2, погибших: -2, убийство: -4, убит: -3, убиты: -3, убийца: -3, резня: -4,
  террор: -3, терроризм: -4, террорист: -3, террористы: -3, заложник: -3, заложники: -3, похищение: -3, похищен: -3,
  раненый: -2, раненые: -2, ранен: -2, жертва: -2, жертвы: -2,
  катастрофа: -4, трагедия: -3, трагический: -3, землетрясение: -3, цунами: -3, ураган: -2, наводнение: -2, пожар: -1, засуха: -2, голод: -3,
  кризис: -3, рецессия: -3, банкротство: -3, обвал: -3, падение: -2, упал: -1, потеря: -2, потери: -2, долг: -1, безработица: -2, инфляция: -1,
  коррупция: -3, коррумпированный: -3, мошенничество: -3, взятка: -3, скандал: -3, преступление: -2, преступник: -2, кража: -2, арестован: -1, осужден: -2, виновен: -2, тюрьма: -1,
  протест: -1, протесты: -1, беспорядки: -3, насилие: -3, жестокий: -3, жестокость: -3,
  угроза: -2, угрозы: -2, санкции: -2, конфликт: -2, конфликты: -2, напряжённость: -2, напряженность: -2,
  страх: -2, паника: -3, беспокойство: -1, тревожный: -2, тревожно: -2,
  провал: -2, опасность: -2, опасный: -2, ужасный: -3, ужас: -3,
  грустный: -1, страдание: -2, страдать: -2, боль: -2, ущерб: -2, разрушение: -3, разрушен: -3,
  ненависть: -3, ненавидеть: -2, болезнь: -2, вирус: -1, пандемия: -3, эпидемия: -3,
  // extras (политика, экономика, происшествия)
  задержан: -1, задержаны: -1, арест: -1, обвинение: -1, обвинения: -1, обвиняется: -1, суд: -1, приговор: -2, штраф: -1, следствие: -1,
  авария: -2, аварии: -2, столкновение: -2, взрыв: -3, взрывы: -3, пострадал: -2, пострадавший: -2, пострадавшие: -2, травма: -2, травмы: -2, ранение: -2, ранения: -2,
  забастовка: -2, забастовки: -2, протестующие: -1, митинг: -1, митинги: -1, столкновения: -2, беспорядки: -3,
  закрытие: -1, закрыт: -1, запрет: -2, запреты: -2, запрещён: -2, запрещен: -2, санкция: -2, угрожает: -2, предупреждение: -1, тревога: -2,
  проблема: -1, проблемы: -1, сложности: -1, трудности: -1, критика: -1, критиковать: -1, обвал: -3, снижение: -1, сокращение: -1, увольнение: -2, увольнения: -2,
  // positive
  мир: 3, мирный: 3, перемирие: 3, соглашение: 1, договор: 2, союз: 1, сотрудничество: 2,
  победа: 2, победы: 2, победил: 2, побеждает: 2, триумф: 3, успех: 2, успешный: 2, достижение: 2, рекорд: 1,
  рост: 2, растёт: 2, растет: 2, увеличение: 1, бум: 2, улучшение: 2, улучшить: 2, восстановление: 2, восстановить: 2,
  прибыль: 2, прибыли: 2, процветание: 3,
  спасение: 2, спас: 2, спасли: 2, герой: 3, герои: 3, героический: 3, храбрый: 2, помощь: 1, поддержка: 1, солидарность: 2, щедрый: 2,
  хороший: 2, лучший: 2, отличный: 3, великий: 2, великолепный: 3, замечательный: 3, потрясающий: 3, невероятный: 3,
  счастливый: 2, счастье: 2, радость: 3, любовь: 3, надежда: 2, оптимизм: 2,
  свободный: 1, свобода: 2, освобождён: 2, освобожден: 2, безопасный: 1, безопасность: 1, здоровье: 1, здоровый: 2, лечение: 2,
  праздник: 2, праздновать: 2, почёт: 2, награда: 2, аплодировать: 2, похвала: 2,
  сильный: 1, сила: 1, справедливость: 2, прогресс: 2, инновация: 2, инновации: 2,
};

// ─── Arabic ─────────────────────────────────────────────────────────────────
const AR = {
  حرب: -3, حروب: -3, غزو: -3, هجوم: -3, هجمات: -3, قصف: -3, قنبلة: -3, قنابل: -3, انفجار: -3, انفجارات: -3, اطلاق: -2, رصاص: -2,
  موت: -2, وفاة: -2, قتل: -3, قتلى: -3, قتيل: -3, مقتل: -3, اغتيال: -4, مجزرة: -4, مذبحة: -4, ضحية: -2, ضحايا: -2, جريح: -2, جرحى: -2, اصابة: -2, اصابات: -2,
  ارهاب: -4, ارهابي: -3, ارهابيون: -3, رهينة: -3, رهائن: -3, اختطاف: -3, خطف: -3,
  كارثة: -4, كوارث: -4, مأساة: -3, زلزال: -3, تسونامي: -3, اعصار: -2, فيضان: -2, حريق: -1, جفاف: -2, مجاعة: -4,
  ازمة: -3, ركود: -3, افلاس: -3, انهيار: -3, هبوط: -1, خسارة: -2, خسائر: -2, دين: -1, بطالة: -2, تسريح: -2, تضخم: -1,
  فساد: -3, رشوة: -3, احتيال: -3, فضيحة: -3, جريمة: -2, جرائم: -2, مجرم: -2, سرقة: -2, اعتقال: -1, معتقل: -1, ادانة: -2, مدان: -2, سجن: -1,
  احتجاج: -1, احتجاجات: -1, مظاهرة: -1, مظاهرات: -1, اشتباكات: -3, عنف: -3, وحشي: -3, قمع: -3,
  تهديد: -2, تهديدات: -2, عقوبات: -2, نزاع: -2, نزاعات: -2, صراع: -2, توتر: -1, توترات: -2,
  خوف: -2, ذعر: -3, قلق: -1, مقلق: -2, انذار: -2,
  فشل: -2, خطر: -2, خطير: -2, مروع: -3, رعب: -3, هلع: -3,
  حزين: -1, حزن: -1, معاناة: -2, الم: -2, ضرر: -2, اضرار: -2, دمار: -3, مدمر: -3,
  كراهية: -3, مرض: -2, امراض: -2, فيروس: -1, جائحة: -3, وباء: -3,
  // positive
  سلام: 3, هدنة: 3, اتفاق: 1, اتفاقية: 1, معاهدة: 2, تحالف: 2, تعاون: 2, حوار: 1,
  نصر: 2, انتصار: 2, انتصارات: 2, فوز: 2, فاز: 2, نجاح: 2, ناجح: 2, انجاز: 2, انجازات: 2, تفوق: 2,
  نمو: 2, ازدهار: 3, تحسن: 2, تحسين: 2, تعافي: 2, انتعاش: 2, زيادة: 1, ارتفاع: 1,
  ربح: 2, ارباح: 2, ازدهار: 3, رخاء: 3,
  انقاذ: 2, منقذ: 2, بطل: 3, ابطال: 3, بطولة: 2, شجاع: 2, شجاعة: 2, مساعدة: 1, مساعدات: 1, دعم: 1, تضامن: 2, كرم: 2,
  جيد: 2, افضل: 2, ممتاز: 3, رائع: 3, عظيم: 2, مذهل: 3, مدهش: 2, رائعة: 3,
  سعيد: 2, سعادة: 2, فرح: 2, فرحة: 2, حب: 2, امل: 2, تفاؤل: 2, متفائل: 2,
  حر: 1, حرية: 2, تحرير: 2, امن: 1, امان: 1, صحة: 1, صحي: 2, شفاء: 2, علاج: 2,
  احتفال: 2, احتفالات: 2, جائزة: 2, تكريم: 2, اشادة: 2, مديح: 2,
  قوي: 1, قوة: 1, عدالة: 2, عدل: 2, تقدم: 2, ابتكار: 2, ابداع: 2,
};

// ─── Turkish ────────────────────────────────────────────────────────────────
const TR = {
  savaş: -3, savaşlar: -3, istila: -3, saldırı: -3, saldırılar: -3, bombalama: -3, bomba: -3, bombalar: -3, patlama: -3, silahlı: -2,
  ölüm: -2, ölümler: -2, öldü: -2, öldürüldü: -3, öldürme: -3, cinayet: -4, katliam: -4, suikast: -4,
  terör: -3, terörist: -3, teröristler: -3, teröristlerin: -3, terörizm: -4, rehine: -3, rehineler: -3, kaçırma: -3,
  yaralı: -2, yaralılar: -2, yaralanma: -2, kurban: -2, kurbanlar: -2,
  felaket: -4, afet: -3, trajedi: -3, trajik: -3, deprem: -3, tsunami: -3, kasırga: -2, sel: -2, yangın: -1, kuraklık: -2, kıtlık: -4,
  kriz: -3, resesyon: -3, iflas: -3, çöküş: -3, düşüş: -1, kayıp: -2, kayıplar: -2, borç: -1, işsizlik: -2, enflasyon: -1,
  yolsuzluk: -3, rüşvet: -3, dolandırıcılık: -3, skandal: -3, suç: -2, suçlu: -2, hırsızlık: -2, tutuklandı: -1, mahkum: -2, suçlu: -2, hapis: -1,
  protesto: -1, protestolar: -1, gösteri: -1, isyan: -3, şiddet: -3, acımasız: -3, zalim: -3,
  tehdit: -2, tehditler: -2, yaptırım: -2, yaptırımlar: -2, çatışma: -2, çatışmalar: -2, gerilim: -1, gerginlik: -2,
  korku: -2, panik: -3, endişe: -1, endişeli: -1, endişe: -1, alarm: -2,
  başarısızlık: -2, başarısız: -2, tehlike: -2, tehlikeli: -2, ciddi: -1, korkunç: -3, dehşet: -3,
  üzgün: -1, üzüntü: -1, acı: -2, acılar: -2, hasar: -2, zarar: -2, yıkım: -3, yıkılmış: -3,
  nefret: -3, hastalık: -2, virüs: -1, pandemi: -3, salgın: -2,
  // positive
  barış: 3, ateşkes: 3, anlaşma: 1, antlaşma: 2, ittifak: 2, işbirliği: 2,
  zafer: 2, kazanç: 1, kazandı: 2, başarı: 2, başarılı: 2, triumph: 3, rekor: 1,
  büyüme: 2, büyüdü: 1, artış: 1, yükseliş: 1, iyileşme: 2, gelişme: 2, toparlanma: 2,
  kâr: 1, kazanç: 1, refah: 3, bolluk: 2,
  kurtarma: 2, kurtarıldı: 2, kahraman: 3, kahramanlar: 3, cesur: 2, cesaret: 2, yardım: 1, destek: 1, dayanışma: 2, cömert: 2, bağış: 2,
  iyi: 2, daha: 1, harika: 3, mükemmel: 3, büyük: 1, muhteşem: 3, inanılmaz: 3,
  mutlu: 2, mutluluk: 2, sevinç: 2, sevgi: 2, aşk: 2, umut: 2, iyimserlik: 2,
  özgür: 1, özgürlük: 2, kurtuluş: 2, güvenli: 1, güvenlik: 1, sağlık: 1, sağlıklı: 2, iyileşme: 2,
  kutlama: 2, ödül: 2, alkış: 2, övgü: 2,
  güçlü: 1, güç: 1, adalet: 2, ilerleme: 2, yenilik: 2,
};

// ─── Polish ─────────────────────────────────────────────────────────────────
const PL = {
  wojna: -3, wojny: -3, inwazja: -3, atak: -3, ataki: -3, bombardowanie: -3, bomba: -3, bomby: -3, wybuch: -3, strzelanina: -3,
  śmierć: -2, śmierci: -2, zginął: -2, zginęli: -2, zabójstwo: -4, zabity: -3, zabici: -3, morderstwo: -4, masakra: -4,
  terror: -3, terroryzm: -4, terrorysta: -3, terroryści: -3, zakładnik: -3, zakładnicy: -3, porwanie: -3,
  ranny: -2, ranni: -2, ofiara: -2, ofiary: -2, poszkodowany: -2,
  katastrofa: -4, tragedia: -3, tragiczny: -3, trzęsienie: -3, tsunami: -3, huragan: -2, powódź: -2, pożar: -1, susza: -2, głód: -3,
  kryzys: -3, recesja: -3, bankructwo: -3, upadek: -3, spadek: -1, strata: -2, straty: -2, dług: -1, bezrobocie: -2, inflacja: -1,
  korupcja: -3, korupcyjny: -3, oszustwo: -3, łapówka: -3, skandal: -3, przestępstwo: -2, przestępca: -2, kradzież: -2, aresztowany: -1, skazany: -2, więzienie: -1,
  protest: -1, protesty: -1, manifestacja: -1, zamieszki: -3, przemoc: -3, brutalny: -3, okrutny: -3,
  groźba: -2, groźby: -2, sankcje: -2, konflikt: -2, konflikty: -2, napięcie: -1, napięcia: -2,
  strach: -2, panika: -3, zmartwienie: -1, niepokój: -1, niepokojący: -2, alarm: -2,
  porażka: -2, niepowodzenie: -2, niebezpieczeństwo: -2, niebezpieczny: -2, poważny: -1, straszny: -3, okropny: -3,
  smutny: -1, smutek: -1, cierpienie: -2, ból: -2, szkoda: -2, szkody: -2, zniszczenie: -3, zniszczony: -3,
  nienawiść: -3, choroba: -2, wirus: -1, pandemia: -3, epidemia: -3,
  // positive
  pokój: 3, rozejm: 3, umowa: 1, traktat: 2, sojusz: 2, współpraca: 2,
  zwycięstwo: 2, wygrana: 2, wygrał: 2, wygrali: 2, triumf: 3, sukces: 2, udany: 2, osiągnięcie: 2, rekord: 1,
  wzrost: 2, rośnie: 1, poprawa: 2, ożywienie: 2, odbudowa: 2, odzyskanie: 2,
  zysk: 2, zyski: 2, dobrobyt: 3, rozkwit: 2,
  ratunek: 2, uratowany: 2, ratować: 2, bohater: 3, bohaterowie: 3, odważny: 2, pomoc: 1, wsparcie: 1, solidarność: 2, hojny: 2,
  dobry: 2, lepszy: 2, doskonały: 3, wspaniały: 3, wielki: 1, niesamowity: 3, fantastyczny: 3,
  szczęśliwy: 2, szczęście: 2, radość: 3, miłość: 3, nadzieja: 2, optymizm: 2,
  wolny: 1, wolność: 2, uwolniony: 2, bezpieczny: 1, bezpieczeństwo: 1, zdrowie: 1, zdrowy: 2, leczenie: 2,
  świętować: 2, nagroda: 2, nagrodzony: 2, pochwała: 2,
  silny: 1, siła: 1, sprawiedliwość: 2, postęp: 2, innowacja: 2,
};

// ─── Ukrainian ──────────────────────────────────────────────────────────────
const UK = {
  війна: -3, війни: -3, вторгнення: -3, напад: -3, напади: -3, атака: -3, атаки: -3, обстріл: -3, обстріли: -3, бомба: -3, бомби: -3, вибух: -3, вибухи: -3,
  смерть: -2, загинув: -2, загинули: -2, загиблий: -2, загиблі: -2, убивство: -4, вбивство: -4, вбитий: -3, вбиті: -3, розстріл: -4, різанина: -4,
  терор: -3, тероризм: -4, терорист: -3, терористи: -3, заручник: -3, заручники: -3, викрадення: -3,
  поранений: -2, поранені: -2, постраждалий: -2, постраждалі: -2, жертва: -2, жертви: -2,
  катастрофа: -4, трагедія: -3, трагічний: -3, землетрус: -3, цунамі: -3, повінь: -2, пожежа: -1, засуха: -2, голод: -3,
  криза: -3, рецесія: -3, банкрутство: -3, обвал: -3, падіння: -1, збиток: -2, збитки: -2, борг: -1, безробіття: -2, інфляція: -1,
  корупція: -3, хабар: -3, шахрайство: -3, скандал: -3, злочин: -2, злочинець: -2, крадіжка: -2, арешт: -1, засуджений: -2, "в'язниця": -1,
  протест: -1, протести: -1, заворушення: -3, насильство: -3, жорстокий: -3,
  загроза: -2, загрози: -2, санкції: -2, конфлікт: -2, напруга: -1,
  страх: -2, паніка: -3, тривога: -2, занепокоєння: -1,
  провал: -2, небезпека: -2, небезпечний: -2, жахливий: -3,
  сумний: -1, страждання: -2, біль: -2, шкода: -2, руйнування: -3, знищений: -3, зруйнований: -3,
  ненависть: -3, хвороба: -2, вірус: -1, пандемія: -3,
  // positive
  мир: 3, "перемир'я": 3, угода: 1, договір: 2, союз: 2, співпраця: 2,
  перемога: 2, перемоги: 2, переміг: 2, тріумф: 3, успіх: 2, успішний: 2, досягнення: 2, рекорд: 1,
  зростання: 2, покращення: 2, відновлення: 2, підйом: 1,
  прибуток: 2, прибутки: 2, процвітання: 3,
  порятунок: 2, врятований: 2, герой: 3, герої: 3, героїчний: 3, сміливий: 2, допомога: 1, підтримка: 1, солідарність: 2,
  добрий: 2, кращий: 2, відмінний: 3, чудовий: 3, великий: 1, неймовірний: 3,
  щасливий: 2, щастя: 2, радість: 3, любов: 3, надія: 2, оптимізм: 2,
  вільний: 1, свобода: 2, звільнений: 2, безпечний: 1, безпека: 1, "здоров'я": 1, здоровий: 2, лікування: 2,
  святкувати: 2, свято: 2, нагорода: 2, похвала: 2,
  сильний: 1, сила: 1, справедливість: 2, прогрес: 2, інновація: 2,
};

// ─── Greek ──────────────────────────────────────────────────────────────────
const EL = {
  πόλεμος: -3, πόλεμοι: -3, εισβολή: -3, επίθεση: -3, επιθέσεις: -3, βομβαρδισμός: -3, βόμβα: -3, βόμβες: -3, έκρηξη: -3, πυροβολισμοί: -3,
  θάνατος: -2, θάνατοι: -2, νεκρός: -2, νεκροί: -2, δολοφονία: -4, δολοφονήθηκε: -4, σκοτώθηκε: -3, σκοτώθηκαν: -3, σφαγή: -4, μακελειό: -4,
  τρόμος: -3, τρομοκρατία: -4, τρομοκράτης: -3, τρομοκράτες: -3, όμηρος: -3, όμηροι: -3, απαγωγή: -3,
  τραυματίας: -2, τραυματίες: -2, θύμα: -2, θύματα: -2,
  καταστροφή: -4, τραγωδία: -3, τραγικός: -3, σεισμός: -3, τσουνάμι: -3, τυφώνας: -2, πλημμύρα: -2, πυρκαγιά: -2, ξηρασία: -2, λιμός: -4,
  κρίση: -3, ύφεση: -3, χρεοκοπία: -3, κατάρρευση: -3, πτώση: -1, απώλεια: -2, απώλειες: -2, χρέος: -1, ανεργία: -2, πληθωρισμός: -1,
  διαφθορά: -3, δωροδοκία: -3, απάτη: -3, σκάνδαλο: -3, έγκλημα: -2, εγκληματίας: -2, κλοπή: -2, συνελήφθη: -1, καταδικάστηκε: -2, φυλακή: -1,
  διαμαρτυρία: -1, διαμαρτυρίες: -1, ταραχές: -3, βία: -3, βίαιος: -3, βάναυσος: -3,
  απειλή: -2, απειλές: -2, κυρώσεις: -2, σύγκρουση: -2, συγκρούσεις: -2, ένταση: -1, εντάσεις: -2,
  φόβος: -2, πανικός: -3, ανησυχία: -1, ανησυχητικός: -2,
  αποτυχία: -2, κίνδυνος: -2, επικίνδυνος: -2, τρομερός: -3, φρικτός: -3,
  λυπημένος: -1, πόνος: -2, ζημιά: -2, καταστροφή: -3,
  μίσος: -3, ασθένεια: -2, ιός: -1, πανδημία: -3, επιδημία: -3,
  // positive
  ειρήνη: 3, ανακωχή: 3, συμφωνία: 1, συνθήκη: 2, συμμαχία: 2, συνεργασία: 2,
  νίκη: 2, νίκες: 2, κέρδισε: 2, θρίαμβος: 3, επιτυχία: 2, επιτυχημένος: 2, επίτευγμα: 2, ρεκόρ: 1,
  ανάπτυξη: 2, αύξηση: 1, βελτίωση: 2, ανάκαμψη: 2, ανάκτηση: 2,
  κέρδος: 2, κέρδη: 2, ευημερία: 3,
  διάσωση: 2, διασώθηκε: 2, ήρωας: 3, ήρωες: 3, ηρωικός: 3, γενναίος: 2, βοήθεια: 1, υποστήριξη: 1, αλληλεγγύη: 2,
  καλός: 2, καλύτερος: 2, εξαιρετικός: 3, υπέροχος: 3, μεγάλος: 1, απίστευτος: 3,
  ευτυχισμένος: 2, ευτυχία: 2, χαρά: 3, αγάπη: 3, ελπίδα: 2, αισιοδοξία: 2,
  ελεύθερος: 1, ελευθερία: 2, απελευθέρωση: 2, ασφαλής: 1, ασφάλεια: 1, υγεία: 1, υγιής: 2,
  γιορτή: 2, βραβείο: 2, έπαινος: 2,
  δυνατός: 1, δύναμη: 1, δικαιοσύνη: 2, πρόοδος: 2, καινοτομία: 2,
};

// ─── Czech / Slovak (shared — close enough) ─────────────────────────────────
const CS = {
  válka: -3, války: -3, invaze: -3, útok: -3, útoky: -3, bombardování: -3, bomba: -3, bomby: -3, výbuch: -3, střelba: -3,
  smrt: -2, smrti: -2, zemřel: -2, zemřeli: -2, zabit: -3, zabiti: -3, vražda: -4, vraždy: -4, masakr: -4,
  teror: -3, terorismus: -4, terorista: -3, teroristé: -3, rukojmí: -3, únos: -3,
  zraněný: -2, zranění: -2, oběť: -2, oběti: -2,
  katastrofa: -4, tragédie: -3, tragický: -3, zemětřesení: -3, tsunami: -3, hurikán: -2, povodeň: -2, požár: -1, sucho: -2, hladomor: -4,
  krize: -3, recese: -3, bankrot: -3, kolaps: -3, pokles: -1, ztráta: -2, ztráty: -2, dluh: -1, nezaměstnanost: -2, inflace: -1,
  korupce: -3, úplatek: -3, podvod: -3, skandál: -3, zločin: -2, zločinec: -2, krádež: -2, zatčen: -1, odsouzen: -2, vězení: -1,
  protest: -1, protesty: -1, nepokoje: -3, násilí: -3, brutální: -3,
  hrozba: -2, hrozby: -2, sankce: -2, konflikt: -2, napětí: -1,
  strach: -2, panika: -3, obava: -1, obavy: -1, znepokojivý: -2,
  selhání: -2, nebezpečí: -2, nebezpečný: -2, hrozný: -3, strašný: -3,
  smutný: -1, utrpení: -2, bolest: -2, škoda: -2, zničení: -3, zničený: -3,
  nenávist: -3, nemoc: -2, virus: -1, pandemie: -3, epidemie: -3,
  // positive
  mír: 3, příměří: 3, dohoda: 1, smlouva: 2, aliance: 2, spolupráce: 2,
  vítězství: 2, vyhrál: 2, triumf: 3, úspěch: 2, úspěšný: 2, rekord: 1,
  růst: 2, zlepšení: 2, oživení: 2, zotavení: 2,
  zisk: 2, zisky: 2, prosperita: 3,
  záchrana: 2, zachráněn: 2, hrdina: 3, hrdinové: 3, statečný: 2, pomoc: 1, podpora: 1, solidarita: 2,
  dobrý: 2, lepší: 2, vynikající: 3, skvělý: 3, velký: 1, úžasný: 3,
  šťastný: 2, štěstí: 2, radost: 3, láska: 3, naděje: 2, optimismus: 2,
  svobodný: 1, svoboda: 2, osvobozen: 2, bezpečný: 1, bezpečnost: 1, zdraví: 1, zdravý: 2, léčba: 2,
  oslava: 2, cena: 1, ocenění: 2, chvála: 2,
  silný: 1, síla: 1, spravedlnost: 2, pokrok: 2, inovace: 2,
};

// ─── Romanian ───────────────────────────────────────────────────────────────
const RO = {
  război: -3, războaie: -3, invazie: -3, atac: -3, atacuri: -3, bombardament: -3, bombă: -3, bombe: -3, explozie: -3, împușcături: -3,
  moarte: -2, morți: -2, mort: -2, ucis: -3, uciși: -3, crimă: -4, asasinat: -4, masacru: -4,
  teroare: -3, terorism: -4, terorist: -3, teroriști: -3, ostatic: -3, ostatici: -3, răpire: -3,
  rănit: -2, răniți: -2, victimă: -2, victime: -2,
  dezastru: -4, catastrofă: -4, tragedie: -3, tragic: -3, cutremur: -3, tsunami: -3, uragan: -2, inundație: -2, incendiu: -2, secetă: -2, foamete: -4,
  criză: -3, recesiune: -3, faliment: -3, prăbușire: -3, scădere: -1, pierdere: -2, pierderi: -2, datorie: -1, șomaj: -2, inflație: -1,
  corupție: -3, mită: -3, fraudă: -3, scandal: -3, crimă: -2, criminal: -2, furt: -2, arestat: -1, condamnat: -2, închisoare: -1,
  protest: -1, proteste: -1, revolte: -3, violență: -3, brutal: -3,
  amenințare: -2, amenințări: -2, sancțiuni: -2, conflict: -2, tensiune: -1,
  frică: -2, panică: -3, îngrijorare: -1, alarmant: -2,
  eșec: -2, pericol: -2, periculos: -2, teribil: -3, groaznic: -3,
  trist: -1, suferință: -2, durere: -2, daune: -2, distrugere: -3, distrus: -3,
  ură: -3, boală: -2, virus: -1, pandemie: -3, epidemie: -3,
  // positive
  pace: 3, armistițiu: 3, acord: 1, tratat: 2, alianță: 2, cooperare: 2,
  victorie: 2, victorii: 2, câștigat: 2, triumf: 3, succes: 2, reușită: 2, record: 1,
  creștere: 2, îmbunătățire: 2, redresare: 2, recuperare: 2,
  profit: 2, profituri: 2, prosperitate: 3,
  salvare: 2, salvat: 2, erou: 3, eroi: 3, eroic: 3, curajos: 2, ajutor: 1, sprijin: 1, solidaritate: 2,
  bun: 2, bună: 2, mai: 1, excelent: 3, minunat: 3, mare: 1, uimitor: 3,
  fericit: 2, fericire: 2, bucurie: 3, iubire: 3, speranță: 2, optimism: 2,
  liber: 1, libertate: 2, eliberat: 2, sigur: 1, siguranță: 1, sănătate: 1, sănătos: 2, vindecare: 2,
  sărbătoare: 2, premiu: 2, laudă: 2,
  puternic: 1, putere: 1, dreptate: 2, progres: 2, inovație: 2,
};

// ─── Serbian / Croatian (Latin-script — Serbian also uses Cyrillic) ─────────
const SR = {
  rat: -3, ratovi: -3, invazija: -3, napad: -3, napadi: -3, bombardovanje: -3, bomba: -3, bombe: -3, eksplozija: -3, pucnjava: -3,
  smrt: -2, smrti: -2, mrtav: -2, ubistvo: -4, ubijen: -3, ubijeni: -3, masakr: -4, pokolj: -4,
  teror: -3, terorizam: -4, terorista: -3, teroristi: -3, talac: -3, taoci: -3, otmica: -3,
  ranjen: -2, ranjeni: -2, žrtva: -2, žrtve: -2,
  katastrofa: -4, tragedija: -3, tragičan: -3, zemljotres: -3, tsunami: -3, uragan: -2, poplava: -2, požar: -1, suša: -2, glad: -3,
  kriza: -3, recesija: -3, bankrot: -3, kolaps: -3, pad: -1, gubitak: -2, gubici: -2, dug: -1, nezaposlenost: -2, inflacija: -1,
  korupcija: -3, mito: -3, prevara: -3, skandal: -3, zločin: -2, zločinac: -2, krađa: -2, uhapšen: -1, osuđen: -2, zatvor: -1,
  protest: -1, protesti: -1, neredi: -3, nasilje: -3, brutalan: -3,
  pretnja: -2, prijetnja: -2, pretnje: -2, sankcije: -2, sukob: -2, napetost: -1,
  strah: -2, panika: -3, briga: -1, zabrinjavajuće: -2,
  neuspeh: -2, opasnost: -2, opasan: -2, strašan: -3, užasan: -3,
  tužan: -1, patnja: -2, bol: -2, šteta: -2, uništenje: -3, uništen: -3,
  mržnja: -3, bolest: -2, virus: -1, pandemija: -3, epidemija: -3,
  // positive
  mir: 3, primirje: 3, sporazum: 1, ugovor: 2, savez: 2, saradnja: 2,
  pobeda: 2, pobjeda: 2, pobede: 2, pobijedio: 2, trijumf: 3, uspeh: 2, uspjeh: 2, uspešan: 2, rekord: 1,
  rast: 2, poboljšanje: 2, oporavak: 2,
  profit: 2, dobit: 2, prosperitet: 3,
  spas: 2, spasen: 2, spasavanje: 2, heroj: 3, heroji: 3, hrabar: 2, pomoć: 1, podrška: 1, solidarnost: 2,
  dobar: 2, bolji: 2, odličan: 3, izvrstan: 3, veliki: 1, neverovatan: 3, nevjerojatan: 3,
  srećan: 2, sretan: 2, sreća: 2, radost: 3, ljubav: 3, nada: 2, optimizam: 2,
  slobodan: 1, sloboda: 2, oslobođen: 2, siguran: 1, sigurnost: 1, zdravlje: 1, zdrav: 2, lečenje: 2,
  proslava: 2, nagrada: 2, pohvala: 2,
  jak: 1, snaga: 1, pravda: 2, napredak: 2, inovacija: 2,
};

// ─── Hungarian ──────────────────────────────────────────────────────────────
const HU = {
  háború: -3, háborúk: -3, invázió: -3, támadás: -3, támadások: -3, bombázás: -3, bomba: -3, bombák: -3, robbanás: -3, lövöldözés: -3,
  halál: -2, halott: -2, meghalt: -2, meghaltak: -2, gyilkosság: -4, megölt: -3, mészárlás: -4,
  terror: -3, terrorizmus: -4, terrorista: -3, terroristák: -3, túsz: -3, túszok: -3, emberrablás: -3,
  sérült: -2, sérültek: -2, áldozat: -2, áldozatok: -2,
  katasztrófa: -4, tragédia: -3, tragikus: -3, földrengés: -3, cunami: -3, hurrikán: -2, árvíz: -2, tűz: -1, aszály: -2, éhínség: -4,
  válság: -3, recesszió: -3, csőd: -3, összeomlás: -3, csökkenés: -1, veszteség: -2, adósság: -1, munkanélküliség: -2, infláció: -1,
  korrupció: -3, vesztegetés: -3, csalás: -3, botrány: -3, bűn: -2, bűnözés: -2, bűnöző: -2, lopás: -2, letartóztatták: -1, elítélt: -2, börtön: -1,
  tiltakozás: -1, tiltakozások: -1, zavargás: -3, erőszak: -3, brutális: -3,
  fenyegetés: -2, szankciók: -2, konfliktus: -2, feszültség: -1,
  félelem: -2, pánik: -3, aggodalom: -1, aggasztó: -2,
  kudarc: -2, veszély: -2, veszélyes: -2, szörnyű: -3, borzalmas: -3,
  szomorú: -1, szenvedés: -2, fájdalom: -2, kár: -2, pusztítás: -3, megsemmisített: -3,
  gyűlölet: -3, betegség: -2, vírus: -1, járvány: -3,
  // positive
  béke: 3, tűzszünet: 3, megállapodás: 1, szerződés: 2, szövetség: 2, együttműködés: 2,
  győzelem: 2, győzelmek: 2, nyert: 2, diadal: 3, siker: 2, sikeres: 2, rekord: 1,
  növekedés: 2, javulás: 2, fellendülés: 2, helyreállás: 2,
  nyereség: 2, nyereségek: 2, jólét: 3,
  mentés: 2, megmentett: 2, hős: 3, hősök: 3, bátor: 2, segítség: 1, támogatás: 1, szolidaritás: 2,
  jó: 2, jobb: 2, kiváló: 3, csodálatos: 3, nagy: 1, hihetetlen: 3,
  boldog: 2, boldogság: 2, öröm: 3, szerelem: 3, remény: 2, optimizmus: 2,
  szabad: 1, szabadság: 2, felszabadult: 2, biztonságos: 1, biztonság: 1, egészség: 1, egészséges: 2, gyógyulás: 2,
  ünneplés: 2, díj: 2, dicséret: 2,
  erős: 1, erő: 1, igazság: 2, haladás: 2, innováció: 2,
};

// ─── Swedish ────────────────────────────────────────────────────────────────
const SV = {
  krig: -3, invasion: -3, attack: -3, attacker: -3, bombning: -3, bomb: -3, bomber: -3, explosion: -3, skottlossning: -3,
  död: -2, dödsfall: -2, dödad: -3, dödade: -3, mord: -4, mördad: -4, massaker: -4,
  terror: -3, terrorism: -4, terrorist: -3, terrorister: -3, gisslan: -3, kidnappning: -3,
  skadad: -2, skadade: -2, offer: -2, offren: -2,
  katastrof: -4, tragedi: -3, tragisk: -3, jordbävning: -3, tsunami: -3, orkan: -2, översvämning: -2, brand: -1, torka: -2, svält: -4,
  kris: -3, recession: -3, konkurs: -3, kollaps: -3, nedgång: -1, förlust: -2, förluster: -2, skuld: -1, arbetslöshet: -2, inflation: -1,
  korruption: -3, muta: -3, bedrägeri: -3, skandal: -3, brott: -2, brottsling: -2, stöld: -2, gripen: -1, dömd: -2, fängelse: -1,
  protest: -1, protester: -1, upplopp: -3, våld: -3, brutal: -3,
  hot: -2, sanktioner: -2, konflikt: -2, spänning: -1,
  rädsla: -2, panik: -3, oro: -1, oroande: -2,
  misslyckande: -2, fara: -2, farlig: -2, hemsk: -3, fruktansvärd: -3,
  ledsen: -1, lidande: -2, smärta: -2, skada: -2, förstörelse: -3, förstörd: -3,
  hat: -3, sjukdom: -2, virus: -1, pandemi: -3, epidemi: -3,
  // positive
  fred: 3, vapenvila: 3, avtal: 1, fördrag: 2, allians: 2, samarbete: 2,
  seger: 2, segrar: 2, vann: 2, triumf: 3, framgång: 2, framgångsrik: 2, rekord: 1,
  tillväxt: 2, förbättring: 2, återhämtning: 2,
  vinst: 2, vinster: 2, välstånd: 3,
  räddning: 2, räddad: 2, hjälte: 3, hjältar: 3, modig: 2, hjälp: 1, stöd: 1, solidaritet: 2,
  bra: 2, bättre: 2, utmärkt: 3, fantastisk: 3, stor: 1, underbar: 3,
  glad: 2, lycka: 2, glädje: 3, kärlek: 3, hopp: 2, optimism: 2,
  fri: 1, frihet: 2, frigiven: 2, säker: 1, säkerhet: 1, hälsa: 1, frisk: 2, läkning: 2,
  fira: 2, pris: 1, utmärkelse: 2, beröm: 2,
  stark: 1, styrka: 1, rättvisa: 2, framsteg: 2, innovation: 2,
};

// ─── Norwegian ──────────────────────────────────────────────────────────────
const NO = {
  krig: -3, invasjon: -3, angrep: -3, bombing: -3, bombe: -3, bomber: -3, eksplosjon: -3, skyting: -3,
  død: -2, dødsfall: -2, drept: -3, drap: -4, mord: -4, massakre: -4,
  terror: -3, terrorisme: -4, terrorist: -3, terrorister: -3, gissel: -3, kidnapping: -3,
  såret: -2, sårede: -2, offer: -2, ofre: -2,
  katastrofe: -4, tragedie: -3, tragisk: -3, jordskjelv: -3, tsunami: -3, orkan: -2, flom: -2, brann: -1, tørke: -2, sult: -3, hungersnød: -4,
  krise: -3, resesjon: -3, konkurs: -3, kollaps: -3, fall: -1, tap: -2, gjeld: -1, arbeidsledighet: -2, inflasjon: -1,
  korrupsjon: -3, bestikkelse: -3, bedrageri: -3, skandale: -3, kriminalitet: -2, kriminell: -2, tyveri: -2, arrestert: -1, dømt: -2, fengsel: -1,
  protest: -1, protester: -1, opptøyer: -3, vold: -3, brutal: -3,
  trussel: -2, sanksjoner: -2, konflikt: -2, spenning: -1,
  frykt: -2, panikk: -3, bekymring: -1, bekymringsfull: -2,
  fiasko: -2, fare: -2, farlig: -2, forferdelig: -3, fryktelig: -3,
  trist: -1, lidelse: -2, smerte: -2, skade: -2, ødeleggelse: -3, ødelagt: -3,
  hat: -3, sykdom: -2, virus: -1, pandemi: -3, epidemi: -3,
  // positive
  fred: 3, våpenhvile: 3, avtale: 1, traktat: 2, allianse: 2, samarbeid: 2,
  seier: 2, seire: 2, vant: 2, triumf: 3, suksess: 2, vellykket: 2, rekord: 1,
  vekst: 2, forbedring: 2, oppgang: 1, bedring: 2,
  fortjeneste: 2, overskudd: 2, velstand: 3,
  redning: 2, reddet: 2, helt: 3, helter: 3, modig: 2, hjelp: 1, støtte: 1, solidaritet: 2,
  god: 2, bedre: 2, utmerket: 3, fantastisk: 3, stor: 1, utrolig: 3,
  glad: 2, lykke: 2, glede: 3, kjærlighet: 3, håp: 2, optimisme: 2,
  fri: 1, frihet: 2, frigjort: 2, trygg: 1, sikkerhet: 1, helse: 1, frisk: 2,
  feire: 2, pris: 1, utmerkelse: 2, ros: 2,
  sterk: 1, styrke: 1, rettferdighet: 2, fremgang: 2, innovasjon: 2,
};

// ─── Danish ─────────────────────────────────────────────────────────────────
const DA = {
  krig: -3, invasion: -3, angreb: -3, bombning: -3, bombe: -3, bomber: -3, eksplosion: -3, skyderi: -3,
  død: -2, dødsfald: -2, dræbt: -3, dræbte: -3, drab: -4, mord: -4, massakre: -4,
  terror: -3, terrorisme: -4, terrorist: -3, terrorister: -3, gidsel: -3, kidnapning: -3,
  såret: -2, sårede: -2, offer: -2, ofre: -2,
  katastrofe: -4, tragedie: -3, tragisk: -3, jordskælv: -3, tsunami: -3, orkan: -2, oversvømmelse: -2, brand: -1, tørke: -2, hungersnød: -4,
  krise: -3, recession: -3, konkurs: -3, kollaps: -3, fald: -1, tab: -2, gæld: -1, arbejdsløshed: -2, inflation: -1,
  korruption: -3, bestikkelse: -3, bedrageri: -3, skandale: -3, kriminalitet: -2, kriminel: -2, tyveri: -2, anholdt: -1, dømt: -2, fængsel: -1,
  protest: -1, protester: -1, optøjer: -3, vold: -3, brutal: -3,
  trussel: -2, sanktioner: -2, konflikt: -2, spænding: -1,
  frygt: -2, panik: -3, bekymring: -1, bekymrende: -2,
  fiasko: -2, fare: -2, farlig: -2, forfærdelig: -3, frygtelig: -3,
  ked: -1, lidelse: -2, smerte: -2, skade: -2, ødelæggelse: -3, ødelagt: -3,
  had: -3, sygdom: -2, virus: -1, pandemi: -3, epidemi: -3,
  // positive
  fred: 3, våbenhvile: 3, aftale: 1, traktat: 2, alliance: 2, samarbejde: 2,
  sejr: 2, sejre: 2, vandt: 2, triumf: 3, succes: 2, succesfuld: 2, rekord: 1,
  vækst: 2, forbedring: 2, opsving: 2, bedring: 2,
  profit: 2, overskud: 2, velstand: 3,
  redning: 2, reddet: 2, helt: 3, helte: 3, modig: 2, hjælp: 1, støtte: 1, solidaritet: 2,
  god: 2, bedre: 2, fremragende: 3, fantastisk: 3, stor: 1, utrolig: 3,
  glad: 2, lykke: 2, glæde: 3, kærlighed: 3, håb: 2, optimisme: 2,
  fri: 1, frihed: 2, løsladt: 2, sikker: 1, sikkerhed: 1, sundhed: 1, rask: 2,
  fejre: 2, pris: 1, anerkendelse: 2, ros: 2,
  stærk: 1, styrke: 1, retfærdighed: 2, fremskridt: 2, innovation: 2,
};

// ─── Finnish ────────────────────────────────────────────────────────────────
const FI = {
  sota: -3, sodat: -3, hyökkäys: -3, hyökkäykset: -3, pommitus: -3, pommi: -3, pommit: -3, räjähdys: -3, ammuskelu: -3,
  kuolema: -2, kuolemat: -2, kuollut: -2, kuolleet: -2, tappo: -3, murha: -4, joukkomurha: -4, verilöyly: -4,
  terrori: -3, terrorismi: -4, terroristi: -3, terroristit: -3, panttivanki: -3, sieppaus: -3,
  loukkaantunut: -2, loukkaantuneet: -2, uhri: -2, uhrit: -2,
  katastrofi: -4, tragedia: -3, traaginen: -3, maanjäristys: -3, tsunami: -3, hurrikaani: -2, tulva: -2, tulipalo: -1, kuivuus: -2, nälänhätä: -4,
  kriisi: -3, taantuma: -3, konkurssi: -3, romahdus: -3, lasku: -1, tappio: -2, velka: -1, työttömyys: -2, inflaatio: -1,
  korruptio: -3, lahjus: -3, petos: -3, skandaali: -3, rikos: -2, rikollinen: -2, varkaus: -2, pidätetty: -1, tuomittu: -2, vankila: -1,
  mielenosoitus: -1, mellakka: -3, väkivalta: -3, brutaali: -3,
  uhka: -2, pakotteet: -2, konflikti: -2, jännitys: -1,
  pelko: -2, paniikki: -3, huoli: -1, huolestuttava: -2,
  epäonnistuminen: -2, vaara: -2, vaarallinen: -2, kauhea: -3, hirveä: -3,
  surullinen: -1, kärsimys: -2, kipu: -2, vahinko: -2, tuho: -3, tuhottu: -3,
  viha: -3, sairaus: -2, virus: -1, pandemia: -3, epidemia: -3,
  // positive
  rauha: 3, aselepo: 3, sopimus: 1, liitto: 2, yhteistyö: 2,
  voitto: 2, voitot: 2, voitti: 2, voittivat: 2, triumfi: 3, menestys: 2, menestyksekäs: 2, ennätys: 1,
  kasvu: 2, parannus: 2, elpyminen: 2, toipuminen: 2,
  voitto: 2, vauraus: 3, menestys: 2,
  pelastus: 2, pelastettu: 2, sankari: 3, sankarit: 3, rohkea: 2, apu: 1, tuki: 1, solidaarisuus: 2,
  hyvä: 2, parempi: 2, erinomainen: 3, upea: 3, suuri: 1, uskomaton: 3,
  onnellinen: 2, onnellisuus: 2, ilo: 3, rakkaus: 3, toivo: 2, optimismi: 2,
  vapaa: 1, vapaus: 2, vapautettu: 2, turvallinen: 1, turvallisuus: 1, terveys: 1, terve: 2, paraneminen: 2,
  juhla: 2, palkinto: 2, ylistys: 2,
  vahva: 1, voima: 1, oikeudenmukaisuus: 2, edistys: 2, innovaatio: 2,
};

// ─── Indonesian / Malay (closely related) ──────────────────────────────────
const ID = {
  perang: -3, invasi: -3, serangan: -3, pemboman: -3, bom: -3, ledakan: -3, penembakan: -3,
  mati: -2, kematian: -2, tewas: -3, meninggal: -2, pembunuhan: -4, dibunuh: -4, pembantaian: -4,
  teror: -3, terorisme: -4, teroris: -3, sandera: -3, penculikan: -3,
  luka: -2, terluka: -2, korban: -2, korbannya: -2,
  bencana: -4, tragedi: -3, tragis: -3, gempa: -3, tsunami: -3, topan: -2, banjir: -2, kebakaran: -2, kekeringan: -2, kelaparan: -4,
  krisis: -3, resesi: -3, bangkrut: -3, kebangkrutan: -3, keruntuhan: -3, penurunan: -1, kerugian: -2, utang: -1, pengangguran: -2, inflasi: -1,
  korupsi: -3, suap: -3, penipuan: -3, skandal: -3, kejahatan: -2, kriminal: -2, pencurian: -2, ditangkap: -1, dipenjara: -1, dihukum: -2, penjara: -1,
  protes: -1, demonstrasi: -1, kerusuhan: -3, kekerasan: -3, brutal: -3, kejam: -3,
  ancaman: -2, sanksi: -2, konflik: -2, ketegangan: -1,
  takut: -2, panik: -3, khawatir: -1, mengkhawatirkan: -2,
  gagal: -2, kegagalan: -2, bahaya: -2, berbahaya: -2, mengerikan: -3, buruk: -2,
  sedih: -1, menderita: -2, sakit: -2, rasa: -1, kerusakan: -2, kehancuran: -3, hancur: -3,
  benci: -3, kebencian: -3, penyakit: -2, virus: -1, pandemi: -3, wabah: -2,
  // positive
  damai: 3, gencatan: 3, perjanjian: 1, aliansi: 2, kerjasama: 2, kerja: 1,
  kemenangan: 2, menang: 2, menangkan: 2, triumf: 3, sukses: 2, berhasil: 2, prestasi: 2, rekor: 1,
  pertumbuhan: 2, peningkatan: 2, pemulihan: 2, bangkit: 2,
  keuntungan: 2, laba: 1, kemakmuran: 3,
  penyelamatan: 2, diselamatkan: 2, pahlawan: 3, berani: 2, bantuan: 1, dukungan: 1, solidaritas: 2,
  baik: 2, lebih: 1, terbaik: 2, luar: 1, biasa: 1, hebat: 2, fantastis: 3, menakjubkan: 3,
  bahagia: 2, kebahagiaan: 2, sukacita: 3, cinta: 3, harapan: 2, optimis: 2,
  bebas: 1, kebebasan: 2, dibebaskan: 2, aman: 1, keamanan: 1, kesehatan: 1, sehat: 2, penyembuhan: 2,
  rayakan: 2, perayaan: 2, penghargaan: 2, pujian: 2,
  kuat: 1, kekuatan: 1, keadilan: 2, kemajuan: 2, inovasi: 2,
};

// ─── Vietnamese ─────────────────────────────────────────────────────────────
const VI = {
  'chiến tranh': -3, 'xâm lược': -3, 'tấn công': -3, 'đánh bom': -3, 'bom': -2, 'nổ': -2, 'xả súng': -3,
  'chết': -2, 'tử vong': -2, 'qua đời': -2, 'giết': -3, 'sát hại': -4, 'thảm sát': -4,
  'khủng bố': -4, 'bắt cóc': -3, 'con tin': -3,
  'bị thương': -2, 'nạn nhân': -2,
  'thảm họa': -4, 'bi kịch': -3, 'động đất': -3, 'sóng thần': -3, 'bão': -2, 'lũ lụt': -2, 'cháy': -1, 'hạn hán': -2, 'nạn đói': -4,
  'khủng hoảng': -3, 'suy thoái': -3, 'phá sản': -3, 'sụp đổ': -3, 'giảm': -1, 'thua lỗ': -2, 'nợ': -1, 'thất nghiệp': -2, 'lạm phát': -1,
  'tham nhũng': -3, 'hối lộ': -3, 'lừa đảo': -3, 'bê bối': -3, 'tội phạm': -2, 'trộm': -2, 'bắt giữ': -1, 'kết án': -2, 'tù': -1,
  'biểu tình': -1, 'bạo loạn': -3, 'bạo lực': -3, 'tàn bạo': -3,
  'đe dọa': -2, 'lệnh trừng phạt': -2, 'xung đột': -2, 'căng thẳng': -1,
  'sợ hãi': -2, 'hoảng loạn': -3, 'lo lắng': -1, 'đáng lo ngại': -2,
  'thất bại': -2, 'nguy hiểm': -2, 'khủng khiếp': -3, 'tồi tệ': -2,
  'buồn': -1, 'đau khổ': -2, 'đau đớn': -2, 'thiệt hại': -2, 'phá hủy': -3, 'bị phá hủy': -3,
  'ghét': -3, 'căm ghét': -3, 'bệnh': -2, 'virus': -1, 'đại dịch': -3, 'dịch bệnh': -3,
  // positive
  'hòa bình': 3, 'ngừng bắn': 3, 'thỏa thuận': 1, 'hiệp ước': 2, 'liên minh': 2, 'hợp tác': 2,
  'chiến thắng': 2, 'thắng': 2, 'thành công': 2, 'thành tựu': 2, 'kỷ lục': 1,
  'tăng trưởng': 2, 'cải thiện': 2, 'phục hồi': 2, 'tăng': 1,
  'lợi nhuận': 2, 'thịnh vượng': 3,
  'giải cứu': 2, 'cứu': 2, 'anh hùng': 3, 'dũng cảm': 2, 'giúp đỡ': 1, 'hỗ trợ': 1, 'đoàn kết': 2,
  'tốt': 2, 'tuyệt vời': 3, 'xuất sắc': 3, 'lớn': 1, 'kỳ diệu': 3,
  'hạnh phúc': 2, 'niềm vui': 3, 'tình yêu': 3, 'hy vọng': 2, 'lạc quan': 2,
  'tự do': 2, 'được giải phóng': 2, 'an toàn': 1, 'an ninh': 1, 'sức khỏe': 1, 'khỏe mạnh': 2, 'chữa lành': 2,
  'ăn mừng': 2, 'giải thưởng': 2, 'khen ngợi': 2,
  'mạnh': 1, 'sức mạnh': 1, 'công lý': 2, 'tiến bộ': 2, 'đổi mới': 2,
};

// ─── Hebrew ─────────────────────────────────────────────────────────────────
const HE = {
  מלחמה: -3, מלחמות: -3, פלישה: -3, התקפה: -3, התקפות: -3, הפצצה: -3, פצצה: -3, פצצות: -3, פיצוץ: -3, ירי: -3,
  מוות: -2, מת: -2, מתים: -2, נהרג: -3, נהרגו: -3, רצח: -4, טבח: -4,
  טרור: -3, טרוריסט: -3, טרוריסטים: -3, בן: -1, חטיפה: -3, חטופים: -3, חטוף: -3,
  פצוע: -2, פצועים: -2, קורבן: -2, קורבנות: -2,
  אסון: -4, טרגדיה: -3, טרגי: -3, רעידת: -3, צונאמי: -3, הוריקן: -2, שיטפון: -2, שרפה: -1, בצורת: -2, רעב: -3,
  משבר: -3, מיתון: -3, פשיטת: -3, קריסה: -3, ירידה: -1, הפסד: -2, חוב: -1, אבטלה: -2, אינפלציה: -1,
  שחיתות: -3, שוחד: -3, הונאה: -3, שערורייה: -3, פשע: -2, פשעים: -2, גניבה: -2, נעצר: -1, הורשע: -2, כלא: -1,
  מחאה: -1, מחאות: -1, מהומות: -3, אלימות: -3, אכזרי: -3,
  איום: -2, איומים: -2, סנקציות: -2, עימות: -2, סכסוך: -2, מתח: -1,
  פחד: -2, פניקה: -3, דאגה: -1, מדאיג: -2,
  כישלון: -2, סכנה: -2, מסוכן: -2, נורא: -3, איום: -3,
  עצוב: -1, סבל: -2, כאב: -2, נזק: -2, הרס: -3, הרוס: -3,
  שנאה: -3, מחלה: -2, נגיף: -1, מגפה: -3,
  // positive
  שלום: 3, הפסקת: 2, הסכם: 1, ברית: 2, שיתוף: 1,
  ניצחון: 2, ניצחונות: 2, ניצח: 2, תרועת: 2, הצלחה: 2, מצליח: 2, הישג: 2, שיא: 1,
  צמיחה: 2, שיפור: 2, התאוששות: 2,
  רווח: 2, רווחים: 2, שגשוג: 3,
  הצלה: 2, ניצל: 2, גיבור: 3, גיבורים: 3, אמיץ: 2, עזרה: 1, תמיכה: 1, סולידריות: 2,
  טוב: 2, מעולה: 3, מצוין: 3, גדול: 1, נהדר: 3, מדהים: 3,
  שמח: 2, אושר: 2, שמחה: 3, אהבה: 3, תקווה: 2, אופטימיות: 2,
  חופשי: 1, חופש: 2, משוחרר: 2, בטוח: 1, ביטחון: 1, בריאות: 1, בריא: 2, ריפוי: 2,
  חגיגה: 2, פרס: 2, שבח: 2,
  חזק: 1, כוח: 1, צדק: 2, התקדמות: 2, חדשנות: 2,
};

// ─── Bulgarian ──────────────────────────────────────────────────────────────
const BG = {
  война: -3, войни: -3, нахлуване: -3, нападение: -3, нападения: -3, бомбардировка: -3, бомба: -3, бомби: -3, експлозия: -3, стрелба: -3,
  смърт: -2, починал: -2, загинал: -2, загинали: -2, убит: -3, убийство: -4, клане: -4, масово: -3,
  терор: -3, тероризъм: -4, терорист: -3, терористи: -3, заложник: -3, заложници: -3, отвличане: -3,
  ранен: -2, ранени: -2, жертва: -2, жертви: -2,
  катастрофа: -4, трагедия: -3, трагичен: -3, земетресение: -3, цунами: -3, ураган: -2, наводнение: -2, пожар: -1, суша: -2, глад: -3,
  криза: -3, рецесия: -3, фалит: -3, срив: -3, спад: -1, загуба: -2, загуби: -2, дълг: -1, безработица: -2, инфлация: -1,
  корупция: -3, подкуп: -3, измама: -3, скандал: -3, престъпление: -2, престъпник: -2, кражба: -2, арестуван: -1, осъден: -2, затвор: -1,
  протест: -1, протести: -1, безредици: -3, насилие: -3, брутален: -3,
  заплаха: -2, санкции: -2, конфликт: -2, напрежение: -1,
  страх: -2, паника: -3, загриженост: -1, тревожно: -2,
  провал: -2, опасност: -2, опасен: -2, ужасен: -3, страшен: -3,
  тъжен: -1, страдание: -2, болка: -2, щета: -2, разрушение: -3, разрушен: -3,
  омраза: -3, болест: -2, вирус: -1, пандемия: -3, епидемия: -3,
  // positive
  мир: 3, примирие: 3, споразумение: 1, договор: 2, съюз: 2, сътрудничество: 2,
  победа: 2, победи: 2, спечели: 2, триумф: 3, успех: 2, успешен: 2, постижение: 2, рекорд: 1,
  растеж: 2, подобрение: 2, възстановяване: 2,
  печалба: 2, печалби: 2, просперитет: 3,
  спасение: 2, спасен: 2, герой: 3, герои: 3, храбър: 2, помощ: 1, подкрепа: 1, солидарност: 2,
  добър: 2, отличен: 3, чудесен: 3, голям: 1, невероятен: 3,
  щастлив: 2, щастие: 2, радост: 3, любов: 3, надежда: 2, оптимизъм: 2,
  свободен: 1, свобода: 2, освободен: 2, безопасен: 1, сигурност: 1, здраве: 1, здрав: 2, лечение: 2,
  празник: 2, награда: 2, похвала: 2,
  силен: 1, сила: 1, справедливост: 2, прогрес: 2, иновация: 2,
};

// ─── Chinese (substring — no word boundaries) ───────────────────────────────
const ZH = {
  战争: -3, 战斗: -2, 入侵: -3, 袭击: -3, 攻击: -3, 轰炸: -3, 炸弹: -3, 爆炸: -3, 枪击: -3, 开枪: -3,
  死亡: -2, 死者: -2, 遇难: -3, 丧生: -3, 身亡: -3, 杀害: -3, 谋杀: -4, 暗杀: -4, 屠杀: -4, 大屠杀: -4,
  恐怖: -3, 恐怖主义: -4, 恐怖分子: -3, 人质: -3, 绑架: -3, 劫持: -3,
  受伤: -2, 伤亡: -3, 受害者: -2, 罹难: -3,
  灾难: -4, 灾害: -3, 悲剧: -3, 地震: -3, 海啸: -3, 飓风: -2, 台风: -2, 洪水: -2, 火灾: -2, 干旱: -2, 饥荒: -4,
  危机: -3, 衰退: -3, 破产: -3, 崩溃: -3, 下跌: -1, 损失: -2, 债务: -1, 失业: -2, 通胀: -1, 通货膨胀: -1,
  腐败: -3, 贪污: -3, 行贿: -3, 诈骗: -3, 丑闻: -3, 犯罪: -2, 罪犯: -2, 盗窃: -2, 逮捕: -1, 定罪: -2, 监狱: -1, 入狱: -1,
  抗议: -1, 示威: -1, 骚乱: -3, 暴乱: -3, 暴力: -3, 残忍: -3, 残暴: -3,
  威胁: -2, 制裁: -2, 冲突: -2, 紧张: -1,
  恐惧: -2, 恐慌: -3, 担忧: -1, 担心: -1, 忧虑: -1,
  失败: -2, 危险: -2, 可怕: -3, 糟糕: -2, 严重: -1,
  悲伤: -1, 痛苦: -2, 伤害: -2, 损坏: -2, 毁灭: -3, 摧毁: -3, 破坏: -2,
  仇恨: -3, 憎恨: -3, 疾病: -2, 病毒: -1, 疫情: -2, 大流行: -3,
  // positive
  和平: 3, 停火: 3, 协议: 1, 条约: 2, 联盟: 2, 合作: 2, 对话: 1,
  胜利: 2, 获胜: 2, 取胜: 2, 赢得: 2, 成功: 2, 成就: 2, 记录: 1,
  增长: 2, 改善: 2, 进步: 2, 复苏: 2, 恢复: 2, 反弹: 1,
  利润: 2, 盈利: 2, 繁荣: 3, 兴盛: 2,
  救援: 2, 获救: 2, 英雄: 3, 勇敢: 2, 勇气: 2, 帮助: 1, 支持: 1, 团结: 2, 慷慨: 2,
  好: 2, 优秀: 3, 杰出: 3, 卓越: 3, 伟大: 2, 精彩: 3, 惊人: 3, 奇迹: 3,
  快乐: 2, 幸福: 3, 喜悦: 3, 爱: 2, 希望: 2, 乐观: 2,
  自由: 2, 解放: 2, 安全: 1, 健康: 1, 康复: 2, 治愈: 2,
  庆祝: 2, 庆典: 2, 奖: 1, 获奖: 2, 赞扬: 2, 表彰: 2,
  强大: 1, 力量: 1, 正义: 2, 公平: 1, 创新: 2,
  // Traditional Chinese variants (Taiwan / Hong Kong)
  戰爭: -3, 戰鬥: -2, 襲擊: -3, 轟炸: -3, 炸彈: -3, 爆炸: -3, 槍擊: -3, 開槍: -3,
  死傷: -3, 遇難: -3, 喪生: -3, 殺害: -3, 謀殺: -4, 屠殺: -4, 大屠殺: -4,
  恐怖主義: -4, 恐怖分子: -3, 綁架: -3, 劫持: -3,
  受傷: -2, 傷亡: -3, 受害者: -2, 罹難: -3,
  災難: -4, 災害: -3, 悲劇: -3, 地震: -3, 海嘯: -3, 颶風: -2, 颱風: -2, 洪水: -2, 火災: -2, 乾旱: -2, 飢荒: -4,
  危機: -3, 衰退: -3, 破產: -3, 崩潰: -3, 下跌: -1, 損失: -2, 債務: -1, 失業: -2, 通貨膨脹: -1,
  腐敗: -3, 貪污: -3, 行賄: -3, 詐騙: -3, 醜聞: -3, 犯罪: -2, 罪犯: -2, 盜竊: -2, 逮捕: -1, 定罪: -2, 監獄: -1,
  抗議: -1, 示威: -1, 騷亂: -3, 暴亂: -3, 暴力: -3, 殘忍: -3, 殘暴: -3,
  威脅: -2, 制裁: -2, 衝突: -2, 緊張: -1,
  恐懼: -2, 恐慌: -3, 擔憂: -1, 擔心: -1, 憂慮: -1,
  失敗: -2, 危險: -2, 可怕: -3, 糟糕: -2, 嚴重: -1,
  悲傷: -1, 痛苦: -2, 傷害: -2, 損壞: -2, 毀滅: -3, 摧毀: -3, 破壞: -2, 燒毀: -3,
  仇恨: -3, 憎恨: -3, 疾病: -2, 病毒: -1, 疫情: -2, 大流行: -3,
  // positive (traditional)
  和平: 3, 停火: 3, 協議: 1, 條約: 2, 聯盟: 2, 合作: 2, 對話: 1,
  勝利: 2, 獲勝: 2, 贏得: 2, 成功: 2, 成就: 2, 紀錄: 1,
  增長: 2, 改善: 2, 進步: 2, 復甦: 2, 復蘇: 2, 恢復: 2, 反彈: 1,
  利潤: 2, 盈利: 2, 繁榮: 3, 興盛: 2,
  救援: 2, 獲救: 2, 英雄: 3, 勇敢: 2, 幫助: 1, 支持: 1, 團結: 2, 慷慨: 2,
  優秀: 3, 傑出: 3, 卓越: 3, 偉大: 2, 精彩: 3, 驚人: 3, 奇蹟: 3,
  快樂: 2, 幸福: 3, 喜悅: 3, 愛: 2, 希望: 2, 樂觀: 2,
  自由: 2, 解放: 2, 安全: 1, 健康: 1, 康復: 2, 治癒: 2,
  慶祝: 2, 慶典: 2, 獎: 1, 獲獎: 2, 讚揚: 2, 表彰: 2,
  強大: 1, 力量: 1, 正義: 2, 創新: 2,
};

// ─── Japanese (substring) ───────────────────────────────────────────────────
const JA = {
  戦争: -3, 戦闘: -2, 侵攻: -3, 侵略: -3, 攻撃: -3, 爆撃: -3, 爆弾: -3, 爆発: -3, 銃撃: -3, 発砲: -3,
  死亡: -2, 死者: -2, 死去: -2, 死亡者: -2, 殺害: -3, 殺人: -4, 暗殺: -4, 虐殺: -4, 大量殺: -4,
  テロ: -4, テロリスト: -3, 人質: -3, 誘拐: -3, 拉致: -3,
  負傷: -2, 負傷者: -2, 怪我: -2, 被害者: -2, 犠牲者: -2,
  災害: -3, 災難: -3, 悲劇: -3, 悲惨: -3, 地震: -3, 津波: -3, 台風: -2, 洪水: -2, 火災: -2, 干ばつ: -2, 飢饉: -4,
  危機: -3, 不況: -3, 不景気: -2, 倒産: -3, 破綻: -3, 崩壊: -3, 下落: -1, 損失: -2, 負債: -1, 失業: -2, インフレ: -1,
  汚職: -3, 腐敗: -3, 贈収賄: -3, 詐欺: -3, スキャンダル: -3, 犯罪: -2, 犯人: -2, 窃盗: -2, 逮捕: -1, 有罪: -2, 刑務所: -1,
  抗議: -1, デモ: -1, 暴動: -3, 暴力: -3, 残忍: -3, 残虐: -3,
  脅威: -2, 制裁: -2, 紛争: -2, 緊張: -1,
  恐怖: -3, 恐れ: -2, 不安: -1, 懸念: -1,
  失敗: -2, 危険: -2, ひどい: -2, 最悪: -3, 深刻: -2,
  悲しい: -1, 苦痛: -2, 痛み: -2, 損害: -2, 破壊: -3, 破損: -2,
  憎しみ: -3, 憎悪: -3, 病気: -2, ウイルス: -1, パンデミック: -3, 感染: -1,
  // positive
  平和: 3, 停戦: 3, 休戦: 3, 合意: 1, 条約: 2, 同盟: 2, 協力: 2, 対話: 1,
  勝利: 2, 勝つ: 2, 勝った: 2, 成功: 2, 達成: 2, 偉業: 2, 記録: 1,
  成長: 2, 改善: 2, 進歩: 2, 回復: 2, 復興: 2,
  利益: 2, 繁栄: 3, 好景気: 2,
  救助: 2, 救出: 2, 救援: 2, 英雄: 3, ヒーロー: 3, 勇敢: 2, 助け: 1, 支援: 1, 連帯: 2,
  良い: 2, 素晴らしい: 3, 優秀: 3, 最高: 3, 偉大: 2, 驚異: 3, 奇跡: 3,
  幸せ: 2, 幸福: 3, 喜び: 3, 愛: 2, 希望: 2, 楽観: 2,
  自由: 2, 解放: 2, 安全: 1, 健康: 1, 治癒: 2, 回復: 2,
  祝福: 2, 祝賀: 2, 賞: 1, 受賞: 2, 称賛: 2,
  強い: 1, 力: 1, 正義: 2, 進歩: 2, 革新: 2,
};

// ─── Korean (substring) ─────────────────────────────────────────────────────
const KO = {
  전쟁: -3, 전투: -2, 침공: -3, 침략: -3, 공격: -3, 폭격: -3, 폭탄: -3, 폭발: -3, 총격: -3, 총기: -3,
  사망: -2, 사망자: -2, 죽음: -2, 숨진: -2, 사살: -3, 살해: -3, 살인: -4, 암살: -4, 학살: -4, 대학살: -4,
  테러: -4, 테러리스트: -3, 인질: -3, 납치: -3,
  부상: -2, 부상자: -2, 다친: -2, 피해자: -2, 희생자: -2,
  재난: -4, 재해: -3, 참사: -3, 비극: -3, 지진: -3, 쓰나미: -3, 해일: -3, 태풍: -2, 홍수: -2, 화재: -2, 가뭄: -2, 기근: -4,
  위기: -3, 경기: -1, 불황: -3, 파산: -3, 붕괴: -3, 하락: -1, 손실: -2, 부채: -1, 실업: -2, 인플레이션: -1,
  부패: -3, 뇌물: -3, 사기: -3, 스캔들: -3, 범죄: -2, 범인: -2, 절도: -2, 체포: -1, 유죄: -2, 감옥: -1, 교도소: -1,
  시위: -1, 항의: -1, 폭동: -3, 폭력: -3, 잔인: -3,
  위협: -2, 제재: -2, 분쟁: -2, 갈등: -2, 긴장: -1,
  공포: -3, 두려움: -2, 불안: -1, 걱정: -1, 우려: -1,
  실패: -2, 위험: -2, 끔찍: -3, 심각: -2,
  슬픈: -1, 슬픔: -1, 고통: -2, 피해: -2, 손해: -2, 파괴: -3, 파손: -2,
  증오: -3, 혐오: -3, 질병: -2, 바이러스: -1, 팬데믹: -3, 전염: -2,
  // positive
  평화: 3, 휴전: 3, 합의: 1, 협정: 2, 동맹: 2, 협력: 2, 대화: 1,
  승리: 2, 우승: 2, 이긴: 2, 성공: 2, 업적: 2, 기록: 1,
  성장: 2, 개선: 2, 발전: 2, 진전: 2, 회복: 2,
  이익: 2, 수익: 2, 번영: 3,
  구조: 2, 구출: 2, 영웅: 3, 용감: 2, 도움: 1, 지원: 1, 연대: 2,
  좋은: 2, 훌륭: 3, 뛰어난: 3, 최고: 3, 위대: 2, 놀라운: 3, 기적: 3,
  행복: 3, 기쁨: 3, 사랑: 3, 희망: 2, 낙관: 2,
  자유: 2, 해방: 2, 안전: 1, 건강: 1, 치유: 2, 회복: 2,
  축하: 2, 기념: 1, 상: 1, 수상: 2, 칭찬: 2,
  강한: 1, 힘: 1, 정의: 2, 진보: 2, 혁신: 2,
};

// ─── Thai (substring) ───────────────────────────────────────────────────────
const TH = {
  สงคราม: -3, การรุกราน: -3, โจมตี: -3, ระเบิด: -3, ยิง: -2, กราดยิง: -3,
  เสียชีวิต: -2, ตาย: -2, ผู้เสียชีวิต: -2, ฆ่า: -3, ฆาตกรรม: -4, สังหาร: -4, สังหารหมู่: -4,
  ก่อการร้าย: -4, ผู้ก่อการร้าย: -3, ตัวประกัน: -3, ลักพาตัว: -3,
  บาดเจ็บ: -2, ผู้บาดเจ็บ: -2, เหยื่อ: -2, ผู้เคราะห์ร้าย: -2,
  ภัยพิบัติ: -4, โศกนาฏกรรม: -3, แผ่นดินไหว: -3, สึนามิ: -3, พายุ: -2, น้ำท่วม: -2, ไฟไหม้: -2, ภัยแล้ง: -2, ความอดอยาก: -4,
  วิกฤต: -3, ถดถอย: -2, ล้มละลาย: -3, พังทลาย: -3, ลดลง: -1, ขาดทุน: -2, หนี้: -1, ว่างงาน: -2, เงินเฟ้อ: -1,
  ทุจริต: -3, สินบน: -3, ฉ้อโกง: -3, เรื่องอื้อฉาว: -3, อาชญากรรม: -2, อาชญากร: -2, ขโมย: -2, จับกุม: -1, ตัดสิน: -1, คุก: -1,
  ประท้วง: -1, จลาจล: -3, ความรุนแรง: -3, โหดร้าย: -3,
  ภัยคุกคาม: -2, คว่ำบาตร: -2, ความขัดแย้ง: -2, ตึงเครียด: -1,
  กลัว: -2, ตื่นตระหนก: -3, กังวล: -1,
  ล้มเหลว: -2, อันตราย: -2, น่ากลัว: -3, แย่: -2,
  เศร้า: -1, ทุกข์: -2, เจ็บปวด: -2, ความเสียหาย: -2, ทำลาย: -3, พังเสียหาย: -3,
  เกลียด: -3, โรค: -2, ไวรัส: -1, ระบาด: -2, โรคระบาด: -3,
  // positive
  สันติ: 3, สันติภาพ: 3, หยุดยิง: 3, ข้อตกลง: 1, พันธมิตร: 2, ความร่วมมือ: 2,
  ชัยชนะ: 2, ชนะ: 2, ความสำเร็จ: 2, สำเร็จ: 2, สถิติ: 1,
  เติบโต: 2, การเติบโต: 2, ปรับปรุง: 2, ฟื้นตัว: 2, ฟื้นฟู: 2,
  กำไร: 2, ความเจริญ: 3,
  ช่วยเหลือ: 1, ช่วยชีวิต: 2, กู้ภัย: 2, วีรบุรุษ: 3, กล้าหาญ: 2, สนับสนุน: 1, เอื้อเฟื้อ: 2,
  ดี: 2, ยอดเยี่ยม: 3, ดีเยี่ยม: 3, ยิ่งใหญ่: 2, มหัศจรรย์: 3,
  มีความสุข: 2, ความสุข: 2, ความยินดี: 3, รัก: 2, ความหวัง: 2, มองในแง่ดี: 2,
  เสรีภาพ: 2, อิสระ: 1, ปลอดภัย: 1, ความปลอดภัย: 1, สุขภาพ: 1, รักษา: 2,
  เฉลิมฉลอง: 2, รางวัล: 2, ชื่นชม: 2,
  แข็งแกร่ง: 1, ความเข้มแข็ง: 1, ความยุติธรรม: 2, ก้าวหน้า: 2, นวัตกรรม: 2,
};

// ─── Slovenian ──────────────────────────────────────────────────────────────
const SL = {
  vojna: -3, vojne: -3, invazija: -3, napad: -3, napadi: -3, bombardiranje: -3, bomba: -3, bombe: -3, eksplozija: -3, streljanje: -3,
  smrt: -2, smrti: -2, mrtev: -2, ubit: -3, ubiti: -3, umor: -4, masaker: -4, pokol: -4,
  teror: -3, terorizem: -4, terorist: -3, teroristi: -3, talec: -3, talci: -3, ugrabitev: -3,
  ranjen: -2, ranjeni: -2, žrtev: -2, žrtve: -2,
  katastrofa: -4, tragedija: -3, tragičen: -3, potres: -3, cunami: -3, orkan: -2, poplava: -2, požar: -1, suša: -2, lakota: -3,
  kriza: -3, recesija: -3, bankrot: -3, propad: -3, padec: -1, izguba: -2, izgube: -2, dolg: -1, brezposelnost: -2, inflacija: -1,
  korupcija: -3, podkupnina: -3, prevara: -3, škandal: -3, zločin: -2, zločinec: -2, kraja: -2, aretiran: -1, obsojen: -2, zapor: -1,
  protest: -1, protesti: -1, nemiri: -3, nasilje: -3, brutalen: -3,
  grožnja: -2, sankcije: -2, spor: -2, napetost: -1,
  strah: -2, panika: -3, skrb: -1, zaskrbljujoče: -2,
  neuspeh: -2, nevarnost: -2, nevaren: -2, grozen: -3, strašen: -3,
  žalosten: -1, trpljenje: -2, bolečina: -2, škoda: -2, uničenje: -3, uničen: -3,
  sovraštvo: -3, bolezen: -2, virus: -1, pandemija: -3, epidemija: -3,
  // positive
  mir: 3, premirje: 3, dogovor: 1, sporazum: 1, zavezništvo: 2, sodelovanje: 2,
  zmaga: 2, zmage: 2, zmagal: 2, triumf: 3, uspeh: 2, uspešen: 2, rekord: 1,
  rast: 2, izboljšanje: 2, okrevanje: 2,
  dobiček: 2, blaginja: 3,
  rešitev: 2, rešen: 2, junak: 3, junaki: 3, pogumen: 2, pomoč: 1, podpora: 1, solidarnost: 2,
  dober: 2, boljši: 2, odličen: 3, čudovit: 3, velik: 1, neverjeten: 3,
  srečen: 2, sreča: 2, veselje: 3, ljubezen: 3, upanje: 2, optimizem: 2,
  svoboden: 1, svoboda: 2, osvobojen: 2, varen: 1, varnost: 1, zdravje: 1, zdrav: 2, zdravljenje: 2,
  praznovanje: 2, nagrada: 2, pohvala: 2,
  močan: 1, moč: 1, pravičnost: 2, napredek: 2, inovacija: 2,
};

// ─── Lithuanian ─────────────────────────────────────────────────────────────
const LT = {
  karas: -3, karo: -3, invazija: -3, ataka: -3, atakos: -3, bombardavimas: -3, bomba: -3, bombos: -3, sprogimas: -3, šaudymas: -3,
  mirtis: -2, mirė: -2, žūtis: -2, žuvo: -2, žuvę: -2, nužudymas: -4, žudymas: -3, žudynės: -4, masinis: -3,
  teroras: -3, terorizmas: -4, teroristas: -3, teroristai: -3, įkaitas: -3, įkaitai: -3, pagrobimas: -3,
  sužeistas: -2, sužeisti: -2, auka: -2, aukos: -2,
  katastrofa: -4, tragedija: -3, tragiškas: -3, žemės: -2, drebėjimas: -3, cunamis: -3, uraganas: -2, potvynis: -2, gaisras: -1, sausra: -2, badas: -3,
  krizė: -3, recesija: -3, bankrotas: -3, žlugimas: -3, kritimas: -1, nuostoliai: -2, skola: -1, nedarbas: -2, infliacija: -1,
  korupcija: -3, kyšis: -3, sukčiavimas: -3, skandalas: -3, nusikaltimas: -2, nusikaltėlis: -2, vagystė: -2, suimtas: -1, nuteistas: -2, kalėjimas: -1,
  protestas: -1, protestai: -1, riaušės: -3, smurtas: -3, žiaurus: -3,
  grėsmė: -2, sankcijos: -2, konfliktas: -2, įtampa: -1,
  baimė: -2, panika: -3, susirūpinimas: -1, nerimas: -1,
  nesėkmė: -2, pavojus: -2, pavojingas: -2, siaubingas: -3, baisus: -3,
  liūdnas: -1, kančia: -2, skausmas: -2, žala: -2, sunaikinimas: -3, sunaikintas: -3,
  neapykanta: -3, liga: -2, virusas: -1, pandemija: -3, epidemija: -3,
  // positive
  taika: 3, paliaubos: 3, susitarimas: 1, sutartis: 2, sąjunga: 2, bendradarbiavimas: 2,
  pergalė: 2, pergalės: 2, laimėjo: 2, triumfas: 3, sėkmė: 2, sėkmingas: 2, rekordas: 1,
  augimas: 2, gerinimas: 2, atsigavimas: 2,
  pelnas: 2, klestėjimas: 3,
  gelbėjimas: 2, išgelbėtas: 2, herojus: 3, didvyris: 3, drąsus: 2, pagalba: 1, parama: 1, solidarumas: 2,
  geras: 2, geresnis: 2, puikus: 3, nuostabus: 3, didelis: 1, neįtikėtinas: 3,
  laimingas: 2, laimė: 2, džiaugsmas: 3, meilė: 3, viltis: 2, optimizmas: 2,
  laisvas: 1, laisvė: 2, išlaisvintas: 2, saugus: 1, saugumas: 1, sveikata: 1, sveikas: 2, gijimas: 2,
  šventė: 2, apdovanojimas: 2, pagyrimas: 2,
  stiprus: 1, stiprybė: 1, teisingumas: 2, pažanga: 2, inovacija: 2,
};

// ─── Latvian ────────────────────────────────────────────────────────────────
const LV = {
  karš: -3, kara: -3, iebrukums: -3, uzbrukums: -3, uzbrukumi: -3, bombardēšana: -3, bumba: -3, bumbas: -3, sprādziens: -3, apšaude: -3,
  nāve: -2, miris: -2, miruši: -2, nogalināts: -3, slepkavība: -4, slaktiņš: -4,
  terors: -3, terorisms: -4, terorists: -3, teroristi: -3, ķīlnieks: -3, ķīlnieki: -3, nolaupīšana: -3,
  ievainots: -2, ievainotie: -2, upuris: -2, upuri: -2,
  katastrofa: -4, traģēdija: -3, traģisks: -3, zemestrīce: -3, cunami: -3, viesuļvētra: -2, plūdi: -2, ugunsgrēks: -1, sausums: -2, bads: -3,
  krīze: -3, recesija: -3, bankrots: -3, sabrukums: -3, kritums: -1, zaudējums: -2, zaudējumi: -2, parāds: -1, bezdarbs: -2, inflācija: -1,
  korupcija: -3, kukulis: -3, krāpšana: -3, skandāls: -3, noziegums: -2, noziedznieks: -2, zādzība: -2, apcietināts: -1, notiesāts: -2, cietums: -1,
  protests: -1, protesti: -1, nemieri: -3, vardarbība: -3, brutāls: -3,
  draudi: -2, sankcijas: -2, konflikts: -2, spriedze: -1,
  bailes: -2, panika: -3, bažas: -1, satraucošs: -2,
  neveiksme: -2, bīstami: -2, bīstams: -2, briesmīgs: -3, šausmīgs: -3,
  skumjš: -1, ciešanas: -2, sāpes: -2, kaitējums: -2, iznīcināšana: -3, iznīcināts: -3,
  naids: -3, slimība: -2, vīruss: -1, pandēmija: -3, epidēmija: -3,
  // positive
  miers: 3, pamiers: 3, vienošanās: 1, līgums: 2, alianse: 2, sadarbība: 2,
  uzvara: 2, uzvaras: 2, uzvarēja: 2, triumfs: 3, panākumi: 2, veiksmīgs: 2, rekords: 1,
  izaugsme: 2, uzlabojums: 2, atveseļošanās: 2,
  peļņa: 2, labklājība: 3,
  glābšana: 2, izglābts: 2, varonis: 3, varoņi: 3, drosmīgs: 2, palīdzība: 1, atbalsts: 1, solidaritāte: 2,
  labs: 2, labāks: 2, izcils: 3, brīnišķīgs: 3, liels: 1, neticams: 3,
  laimīgs: 2, laime: 2, prieks: 3, mīlestība: 3, cerība: 2, optimisms: 2,
  brīvs: 1, brīvība: 2, atbrīvots: 2, drošs: 1, drošība: 1, veselība: 1, vesels: 2, dziedināšana: 2,
  svētki: 2, balva: 2, uzslava: 2,
  stiprs: 1, spēks: 1, taisnīgums: 2, progress: 2, inovācija: 2,
};

// ─── Icelandic ──────────────────────────────────────────────────────────────
const IS = {
  stríð: -3, innrás: -3, árás: -3, árásir: -3, sprengjuárás: -3, sprengja: -3, sprengjur: -3, sprenging: -3, skotárás: -3,
  dauði: -2, dauða: -2, látinn: -2, látin: -2, drepinn: -3, morð: -4, myrtur: -4, fjöldamorð: -4,
  hryðjuverk: -4, hryðjuverkamaður: -3, gísl: -3, gíslar: -3, mannrán: -3,
  særður: -2, særðir: -2, fórnarlamb: -2, fórnarlömb: -2,
  hamfarir: -4, harmleikur: -3, harmrænn: -3, jarðskjálfti: -3, flóðbylgja: -3, fellibylur: -2, flóð: -2, eldsvoði: -1, þurrkur: -2, hungursneyð: -4,
  kreppa: -3, samdráttur: -3, gjaldþrot: -3, hrun: -3, fall: -1, tap: -2, tap: -2, skuld: -1, atvinnuleysi: -2, verðbólga: -1,
  spilling: -3, mútur: -3, svik: -3, hneyksli: -3, glæpur: -2, glæpamaður: -2, þjófnaður: -2, handtekinn: -1, dæmdur: -2, fangelsi: -1,
  mótmæli: -1, óeirðir: -3, ofbeldi: -3, grimmur: -3,
  hótun: -2, viðurlög: -2, átök: -2, spenna: -1,
  ótti: -2, skelfing: -3, áhyggjur: -1, áhyggjuefni: -2,
  mistök: -2, hætta: -2, hættulegur: -2, hræðilegur: -3, skelfilegur: -3,
  sorglegur: -1, þjáning: -2, verkur: -2, tjón: -2, eyðilegging: -3, eyðilagt: -3,
  hatur: -3, sjúkdómur: -2, veira: -1, heimsfaraldur: -3, faraldur: -2,
  // positive
  friður: 3, vopnahlé: 3, samningur: 1, bandalag: 2, samvinna: 2, samstarf: 2,
  sigur: 2, sigrar: 2, vann: 2, árangur: 2, velgengni: 2, met: 1,
  vöxtur: 2, bati: 2, viðreisn: 2,
  hagnaður: 2, velmegun: 3,
  björgun: 2, bjargað: 2, hetja: 3, hetjur: 3, hugrakkur: 2, hjálp: 1, stuðningur: 1, samstaða: 2,
  góður: 2, betri: 2, frábær: 3, stórkostlegur: 3, mikill: 1, ótrúlegur: 3,
  hamingjusamur: 2, hamingja: 2, gleði: 3, ást: 3, von: 2, bjartsýni: 2,
  frjáls: 1, frelsi: 2, leystur: 2, öruggur: 1, öryggi: 1, heilsa: 1, heilbrigður: 2, lækning: 2,
  fagnað: 2, verðlaun: 2, lof: 2,
  sterkur: 1, styrkur: 1, réttlæti: 2, framfarir: 2, nýsköpun: 2,
};

// ─── Albanian ───────────────────────────────────────────────────────────────
const SQ = {
  luftë: -3, lufta: -3, pushtim: -3, sulm: -3, sulme: -3, bombardim: -3, bombë: -3, bomba: -3, shpërthim: -3, të: 0, shtënat: -2,
  vdekje: -2, vdiq: -2, vdekur: -2, vrasje: -4, vrarë: -3, masakër: -4,
  terror: -3, terrorizëm: -4, terrorist: -3, terroristë: -3, peng: -3, rrëmbim: -3,
  plagos: -2, plagosur: -2, viktimë: -2, viktima: -2,
  fatkeqësi: -4, katastrofë: -4, tragjedi: -3, tragjik: -3, tërmet: -3, cunami: -3, uragan: -2, përmbytje: -2, zjarr: -1, thatësirë: -2, uri: -3,
  krizë: -3, recesion: -3, falimentim: -3, kolaps: -3, rënie: -1, humbje: -2, borxh: -1, papunësi: -2, inflacion: -1,
  korrupsion: -3, ryshfet: -3, mashtrim: -3, skandal: -3, krim: -2, kriminel: -2, vjedhje: -2, arrestuar: -1, dënuar: -2, burg: -1,
  protestë: -1, protesta: -1, trazira: -3, dhunë: -3, brutal: -3,
  kërcënim: -2, sanksione: -2, konflikt: -2, tension: -1,
  frikë: -2, panik: -3, shqetësim: -1, shqetësues: -2,
  dështim: -2, rrezik: -2, rrezikshëm: -2, tmerrshëm: -3, i: 0,
  trishtim: -1, vuajtje: -2, dhimbje: -2, dëm: -2, shkatërrim: -3, shkatërruar: -3,
  urrejtje: -3, sëmundje: -2, virus: -1, pandemi: -3, epidemi: -3,
  // positive
  paqe: 3, armëpushim: 3, marrëveshje: 1, aleancë: 2, bashkëpunim: 2,
  fitore: 2, fitoi: 2, triumf: 3, sukses: 2, suksesshëm: 2, arritje: 2, rekord: 1,
  rritje: 2, përmirësim: 2, rimëkëmbje: 2,
  fitim: 2, prosperitet: 3,
  shpëtim: 2, shpëtuar: 2, hero: 3, heronj: 3, trim: 2, ndihmë: 1, mbështetje: 1, solidaritet: 2,
  mirë: 2, më: 1, shkëlqyer: 3, mrekullueshëm: 3, madh: 1, i: 0, jashtëzakonshëm: 3,
  lumtur: 2, lumturi: 2, gëzim: 3, dashuri: 3, shpresë: 2, optimizëm: 2,
  lirë: 1, liri: 2, liruar: 2, i: 0, sigurt: 1, siguri: 1, shëndet: 1, shëndetshëm: 2, shërim: 2,
  festë: 2, çmim: 2, lavdërim: 2,
  fortë: 1, forcë: 1, drejtësi: 2, përparim: 2, inovacion: 2,
};

// ─── Catalan ────────────────────────────────────────────────────────────────
const CA = {
  guerra: -3, guerres: -3, invasió: -3, atac: -3, atacs: -3, bombardeig: -3, bomba: -3, bombes: -3, explosió: -3, tiroteig: -3,
  mort: -2, morts: -2, morir: -2, mort: -2, assassinat: -4, assassinats: -4, massacre: -4,
  terror: -3, terrorisme: -4, terrorista: -3, terroristes: -3, ostatge: -3, ostatges: -3, segrest: -3,
  ferit: -2, ferits: -2, víctima: -2, víctimes: -2,
  desastre: -3, catàstrofe: -4, tragèdia: -3, tràgic: -3, terratrèmol: -3, tsunami: -3, huracà: -2, inundació: -2, incendi: -2, sequera: -2, fam: -3, fams: -3,
  crisi: -3, recessió: -3, fallida: -3, col·lapse: -3, caiguda: -1, pèrdua: -2, pèrdues: -2, deute: -1, atur: -2, inflació: -1,
  corrupció: -3, suborn: -3, frau: -3, escàndol: -3, crim: -2, criminal: -2, robatori: -2, detingut: -1, condemnat: -2, presó: -1,
  protesta: -1, protestes: -1, aldarull: -3, violència: -3, brutal: -3,
  amenaça: -2, sancions: -2, conflicte: -2, tensió: -1,
  por: -2, pànic: -3, preocupació: -1, alarmant: -2,
  fracàs: -2, perill: -2, perillós: -2, terrible: -3, horrible: -3,
  trist: -1, patiment: -2, dolor: -2, dany: -2, destrucció: -3, destruït: -3,
  odi: -3, malaltia: -2, virus: -1, pandèmia: -3, epidèmia: -3,
  // positive
  pau: 3, treva: 3, acord: 1, tractat: 2, aliança: 2, cooperació: 2,
  victòria: 2, victòries: 2, guanyar: 2, triomf: 3, èxit: 2, reeixit: 2, rècord: 1,
  creixement: 2, millora: 2, recuperació: 2,
  benefici: 2, prosperitat: 3,
  rescat: 2, rescatat: 2, heroi: 3, herois: 3, valent: 2, ajuda: 1, suport: 1, solidaritat: 2,
  bo: 2, bona: 2, millor: 2, excel·lent: 3, fantàstic: 3, meravellós: 3, gran: 1, increïble: 3,
  feliç: 2, felicitat: 2, alegria: 3, amor: 3, esperança: 2, optimisme: 2,
  lliure: 1, llibertat: 2, alliberat: 2, segur: 1, seguretat: 1, salut: 1, sa: 2, curació: 2,
  celebrar: 2, premi: 2, elogi: 2,
  fort: 1, força: 1, justícia: 2, progrés: 2, innovació: 2,
};

// ─── Urdu ───────────────────────────────────────────────────────────────────
const UR = {
  جنگ: -3, حملہ: -3, حملے: -3, بمباری: -3, بم: -3, دھماکہ: -3, فائرنگ: -3, گولی: -2,
  موت: -2, ہلاک: -3, ہلاکت: -3, قتل: -4, قاتل: -3, قتلعام: -4,
  دہشت: -3, دہشتگرد: -3, دہشتگردی: -4, یرغمال: -3, اغوا: -3,
  زخمی: -2, زخمیوں: -2, متاثرہ: -2, شکار: -2,
  آفت: -4, سانحہ: -3, زلزلہ: -3, سونامی: -3, طوفان: -2, سیلاب: -2, آگ: -1, خشک: -1, قحط: -4,
  بحران: -3, کساد: -2, دیوالیہ: -3, نقصان: -2, قرض: -1, بیروزگاری: -2, مہنگائی: -1,
  کرپشن: -3, رشوت: -3, دھوکہ: -3, اسکینڈل: -3, جرم: -2, مجرم: -2, چوری: -2, گرفتار: -1, سزا: -2, جیل: -1,
  احتجاج: -1, فساد: -3, تشدد: -3, ظالم: -3,
  دھمکی: -2, پابندیاں: -2, تنازع: -2, کشیدگی: -1,
  خوف: -2, خطرہ: -2, خطرناک: -2, خوفناک: -3,
  ناکامی: -2, افسوس: -1, درد: -2, تکلیف: -2, نقصان: -2, تباہی: -3, تباہ: -3,
  نفرت: -3, بیماری: -2, وائرس: -1, وبا: -3,
  // positive
  امن: 3, جنگبندی: 3, معاہدہ: 1, اتحاد: 2, تعاون: 2,
  فتح: 2, کامیابی: 2, کامیاب: 2, ریکارڈ: 1,
  ترقی: 2, بحالی: 2, بہتری: 2,
  منافع: 2, خوشحالی: 3,
  بچایا: 2, نجات: 2, ہیرو: 3, بہادر: 2, مدد: 1, حمایت: 1, اتحاد: 2,
  اچھا: 2, بہترین: 3, شاندار: 3, زبردست: 3, عظیم: 2,
  خوش: 2, خوشی: 2, محبت: 3, امید: 2,
  آزاد: 1, آزادی: 2, محفوظ: 1, حفاظت: 1, صحت: 1, علاج: 2,
  جشن: 2, انعام: 2, تعریف: 2,
  مضبوط: 1, طاقت: 1, انصاف: 2, جدت: 2,
};

// Registry of per-language lexicons
const LEXICONS = {
  en: null,     // handled specially — uses NEGATIVE/POSITIVE
  es: ES, fr: FR, pt: PT, de: DE, it: IT, nl: NL, ru: RU,
  ar: AR, tr: TR, pl: PL, uk: UK, el: EL,
  cs: CS, sk: CS,                      // Slovak shares Czech lexicon (close enough for news)
  ro: RO, sr: SR, hr: SR, bs: SR,      // Croatian & Bosnian share Serbian Latin lexicon
  hu: HU, sv: SV, no: NO, nb: NO, nn: NO, da: DA, fi: FI,
  id: ID, ms: ID,                      // Malay shares Indonesian
  vi: VI, he: HE, bg: BG,
  zh: ZH, ja: JA, ko: KO, th: TH,
  sl: SL, lt: LT, lv: LV, is: IS, sq: SQ, ca: CA, ur: UR,
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
  // Lowercase, keep apostrophes so contractions survive, strip punctuation.
  // Unicode-aware: keeps all letters (Latin-accented, Cyrillic, etc.) and digits.
  return String(text)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]+/gu, ' ')
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
// Languages without clear word boundaries — tokenization by whitespace is
// unreliable, so we scan by substring instead.
const SUBSTRING_LANGS = new Set(['zh', 'ja', 'ko', 'th', 'vi']);

// Morphologically rich languages (heavy case declensions or agglutination)
// where tokens rarely match the lemma exactly. We use 4-character prefix
// stem matching as a cheap approximation of stemming.
const STEM_LANGS = new Set(['ru','uk','sr','hr','bs','cs','sk','pl','bg','fi','hu','sl','lt','lv','is','el','he','tr']);

// Cache of stem→weight maps, keyed by lexicon object identity.
const _stemCache = new WeakMap();
function getStems(lex) {
  let cached = _stemCache.get(lex);
  if (cached) return cached;
  const stems = Object.create(null);
  for (const key of Object.keys(lex)) {
    if (key.length >= 5 && !key.includes(' ')) {
      const stem = key.slice(0, 4);
      const w = lex[key];
      const existing = stems[stem];
      if (existing === undefined || Math.abs(w) > Math.abs(existing)) {
        stems[stem] = w;
      }
    }
  }
  _stemCache.set(lex, stems);
  return stems;
}

// Arabic scorer — strips common prefixes (ال, و, ف, ب, ل, ك) before lookup,
// since Arabic nouns usually appear with the definite article or conjunctions
// glued to the front. Also uses 4-char stem fallback for suffix variants.
function scoreArabic(tokens, lex) {
  const stems = getStems(lex);
  let sum = 0, matched = 0;
  for (let tok of tokens) {
    // Strip common prefix clusters
    if (tok.length > 3 && tok.startsWith('ال')) tok = tok.slice(2);
    if (tok.length > 3 && (tok.startsWith('و') || tok.startsWith('ف') || tok.startsWith('ب') || tok.startsWith('ل') || tok.startsWith('ك'))) tok = tok.slice(1);
    if (tok.length > 3 && tok.startsWith('ال')) tok = tok.slice(2);
    let w = 0;
    if (lex[tok] !== undefined) w = lex[tok];
    else if (tok.length >= 4) {
      const s = tok.slice(0, 4);
      if (stems[s] !== undefined) w = stems[s];
    }
    if (w === 0) continue;
    sum += w;
    matched++;
  }
  if (!matched) return null;
  const ALPHA = 15;
  return Math.max(-1, Math.min(1, sum / Math.sqrt(sum * sum + ALPHA)));
}

function scoreStem(tokens, lex) {
  const stems = getStems(lex);
  let sum = 0, matched = 0;
  for (const tok of tokens) {
    let w = 0;
    if (lex[tok] !== undefined) w = lex[tok];
    else if (tok.length >= 4) {
      const s = tok.slice(0, 4);
      if (stems[s] !== undefined) w = stems[s];
    }
    if (w === 0) continue;
    sum += w;
    matched++;
  }
  if (!matched) return null;
  const ALPHA = 15;
  return Math.max(-1, Math.min(1, sum / Math.sqrt(sum * sum + ALPHA)));
}

function scoreSubstring(text, lex) {
  if (!text) return null;
  const t = String(text);
  let sum = 0;
  let matched = 0;
  for (const key of Object.keys(lex)) {
    const w = lex[key];
    if (!w || !key) continue;
    let idx = 0, count = 0;
    while ((idx = t.indexOf(key, idx)) !== -1) {
      count++;
      idx += key.length;
      if (count > 8) break; // cap repeats per key
    }
    if (count > 0) {
      sum += w * count;
      matched += count;
    }
  }
  if (!matched) return null;
  const ALPHA = 15;
  return Math.max(-1, Math.min(1, sum / Math.sqrt(sum * sum + ALPHA)));
}

function scoreText(text, lang) {
  if (!text) return null;

  // Pick lexicon pair for the language. English (or unknown) uses the default
  // NEGATIVE/POSITIVE. Other languages use a single combined lexicon where
  // negative entries are negative numbers and positive entries are positive.
  const code = (lang || 'en').toLowerCase().slice(0, 2);

  // CJK / Thai / Vietnamese — no clean word boundaries; scan by substring.
  if (SUBSTRING_LANGS.has(code) && LEXICONS[code]) {
    return scoreSubstring(text, LEXICONS[code]);
  }

  const tokens = tokenize(text);
  if (!tokens.length) return null;

  // Arabic — special prefix stripping.
  if (code === 'ar' && LEXICONS.ar) {
    return scoreArabic(tokens, LEXICONS.ar);
  }

  // Morphologically rich languages — prefix-stem match.
  if (STEM_LANGS.has(code) && LEXICONS[code]) {
    return scoreStem(tokens, LEXICONS[code]);
  }

  const altLex = (code !== 'en' && LEXICONS[code]) ? LEXICONS[code] : null;

  let sum = 0;
  let absSum = 0;
  let matched = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let w = 0;
    if (altLex) {
      if (altLex[tok] !== undefined) w = altLex[tok];
    } else {
      if (NEGATIVE[tok] !== undefined)      w = NEGATIVE[tok];
      else if (POSITIVE[tok] !== undefined) w = POSITIVE[tok];
    }
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
  // If we have an English translation, prefer it and score with the English
  // lexicon. Otherwise fall back to the original-language text and dispatch
  // to the matching lexicon via row.language.
  const hasTranslation = !!(row.translated_title || row.translated_summary);
  const title   = hasTranslation ? (row.translated_title   || '') : (row.title   || '');
  const summary = hasTranslation ? (row.translated_summary || '') : (row.summary || '');
  const combined = `${title}. ${summary}`.trim();
  const lang = hasTranslation ? 'en' : (row.language || 'en');
  const s = scoreText(combined, lang);
  return { score: s, matched: s !== null };
}

/**
 * extractSignalWords(text, lang) -> [{ word, weight, polarity, negated, intensified }]
 *
 * Returns every lexicon-matched token in the input text with its effective
 * weight after negation/intensifier modifiers, in order of absolute magnitude
 * (strongest first). Intended for UI highlighting of "why this article scored
 * positive/negative" — not for numeric scoring (use scoreText for that).
 *
 * Only supports English + the other alt-lexicon languages via word boundary
 * matching. CJK/substring languages are skipped (returns []) since highlight
 * positions don't map cleanly to tokens there.
 */
function extractSignalWords(text, lang) {
  if (!text) return [];
  const code = (lang || 'en').toLowerCase().slice(0, 2);
  if (SUBSTRING_LANGS.has(code)) return []; // CJK/Thai/Viet — skip highlighting

  const tokens = tokenize(text);
  if (!tokens.length) return [];

  const altLex = (code !== 'en' && LEXICONS[code]) ? LEXICONS[code] : null;
  const signals = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let base = 0;
    if (altLex) {
      if (altLex[tok] !== undefined) base = altLex[tok];
    } else {
      if (NEGATIVE[tok] !== undefined)      base = NEGATIVE[tok];
      else if (POSITIVE[tok] !== undefined) base = POSITIVE[tok];
    }
    if (base === 0) continue;

    let w = base;
    let intensified = false;
    for (let k = 1; k <= 2 && i - k >= 0; k++) {
      const pv = tokens[i - k];
      if (INTENSIFIERS[pv] !== undefined) { w *= INTENSIFIERS[pv]; intensified = true; break; }
      if (DAMPENERS[pv]    !== undefined) { w *= DAMPENERS[pv];    break; }
    }

    let negated = false;
    for (let k = 1; k <= 3 && i - k >= 0; k++) {
      const pv = tokens[i - k];
      if (NEGATORS.has(pv) || pv.endsWith("n't")) { negated = true; break; }
    }
    if (negated) w = -w * 0.75;

    signals.push({
      word: tok,
      weight: w,
      polarity: w > 0 ? "pos" : "neg",
      negated,
      intensified
    });
  }

  // Strongest first, capped to keep payload reasonable.
  signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return signals.slice(0, 20);
}

/**
 * extractArticleSignals(row) -> { score, matched_words }
 *
 * Convenience wrapper: picks the best text (translated > original) and
 * returns both the article's sentiment score AND the list of signal words
 * that produced it, ready to ship to the frontend.
 */
function extractArticleSignals(row) {
  if (!row) return { score: null, matched_words: [] };
  const hasTranslation = !!(row.translated_title || row.translated_summary);
  const title   = hasTranslation ? (row.translated_title   || '') : (row.title   || '');
  const summary = hasTranslation ? (row.translated_summary || '') : (row.summary || '');
  const combined = `${title}. ${summary}`.trim();
  const lang = hasTranslation ? 'en' : (row.language || 'en');
  return {
    score: scoreText(combined, lang),
    matched_words: extractSignalWords(combined, lang)
  };
}

module.exports = { scoreText, scoreArticle, tokenize, extractSignalWords, extractArticleSignals };
