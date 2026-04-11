/**
 * leaderAccounts.js
 *
 * Curated list of world leaders and government accounts for Twitter/X polling.
 * Each entry maps a Twitter handle to metadata used for display and geo-linking.
 */

'use strict';

const LEADER_ACCOUNTS = [
  // ── Americas ──
  { handle: 'realDonaldTrump',   name: 'Donald Trump',              title: 'President',           country: 'US', iso: 'us' },
  { handle: 'StateDept',         name: 'U.S. Department of State',  title: 'Government',          country: 'US', iso: 'us' },
  { handle: 'Claudiashein',      name: 'Claudia Sheinbaum',         title: 'President',           country: 'Mexico', iso: 'mx' },
  { handle: 'JMilei',            name: 'Javier Milei',              title: 'President',           country: 'Argentina', iso: 'ar' },
  { handle: 'LulaOficial',       name: 'Luiz Inácio Lula da Silva', title: 'President',           country: 'Brazil', iso: 'br' },
  { handle: 'petrogustavo',      name: 'Gustavo Petro',             title: 'President',           country: 'Colombia', iso: 'co' },
  { handle: 'AlboMP',            name: 'Anthony Albanese',          title: 'Prime Minister',      country: 'Australia', iso: 'au' },

  // ── Europe ──
  { handle: 'EmmanuelMacron',    name: 'Emmanuel Macron',           title: 'President',           country: 'France', iso: 'fr' },
  { handle: '_FriedrichMerz',    name: 'Friedrich Merz',            title: 'Chancellor',          country: 'Germany', iso: 'de' },
  { handle: 'GiorgiaMeloni',     name: 'Giorgia Meloni',            title: 'Prime Minister',      country: 'Italy', iso: 'it' },
  { handle: 'vonderleyen',       name: 'Ursula von der Leyen',      title: 'EC President',        country: 'EU', iso: 'eu' },
  { handle: 'donaldtusk',        name: 'Donald Tusk',               title: 'Prime Minister',      country: 'Poland', iso: 'pl' },
  { handle: 'sanchezcastejon',   name: 'Pedro Sánchez',             title: 'Prime Minister',      country: 'Spain', iso: 'es' },
  { handle: 'SecGenNATO',        name: 'Mark Rutte',                title: 'NATO Secretary General', country: 'NATO', iso: 'nl' },
  { handle: 'SwedishPM',         name: 'Ulf Kristersson',           title: 'Prime Minister',      country: 'Sweden', iso: 'se' },
  { handle: 'jonasgahrstore',    name: 'Jonas Gahr Støre',          title: 'Prime Minister',      country: 'Norway', iso: 'no' },
  { handle: 'Statsmin',          name: 'Mette Frederiksen',         title: 'Prime Minister',      country: 'Denmark', iso: 'dk' },
  { handle: 'SimonHarrisTD',     name: 'Simon Harris',              title: 'Taoiseach',           country: 'Ireland', iso: 'ie' },
  { handle: 'RishiSunak',        name: 'Rishi Sunak',               title: 'Former PM',           country: 'UK', iso: 'gb' },

  // ── Eastern Europe / Eurasia ──
  { handle: 'ZelenskyyUa',       name: 'Volodymyr Zelenskyy',       title: 'President',           country: 'Ukraine', iso: 'ua' },
  { handle: 'KremlinRussia_E',   name: 'Kremlin',                   title: 'Government',          country: 'Russia', iso: 'ru' },
  { handle: 'presidentaz',       name: 'Ilham Aliyev',              title: 'President',           country: 'Azerbaijan', iso: 'az' },
  { handle: 'TokayevKZ',         name: 'Kassym-Jomart Tokayev',     title: 'President',           country: 'Kazakhstan', iso: 'kz' },

  // ── Middle East ──
  { handle: 'netanyahu',         name: 'Benjamin Netanyahu',        title: 'Prime Minister',      country: 'Israel', iso: 'il' },
  { handle: 'yoavgallant',       name: 'Yoav Gallant',              title: 'Defense Minister',    country: 'Israel', iso: 'il' },
  { handle: 'RTErdogan',         name: 'Recep Tayyip Erdoğan',      title: 'President',           country: 'Turkey', iso: 'tr' },
  { handle: 'IRIMFA_EN',         name: 'Iran MFA',                  title: 'Government',          country: 'Iran', iso: 'ir' },
  { handle: 'raisi_com',         name: 'Ebrahim Raisi',             title: 'Former President',    country: 'Iran', iso: 'ir' },
  { handle: 'FaisalbinFarhan',   name: 'Faisal bin Farhan Al Saud', title: 'Foreign Minister',    country: 'Saudi Arabia', iso: 'sa' },
  { handle: 'AnwarGargash',      name: 'Anwar Gargash',             title: 'Presidential Adviser',country: 'UAE', iso: 'ae' },
  { handle: 'PresidentPS',       name: 'Mahmoud Abbas',             title: 'President',           country: 'Palestine', iso: 'ps' },
  { handle: 'KingAbdullahII',    name: 'King Abdullah II',          title: 'King',                country: 'Jordan', iso: 'jo' },
  { handle: 'Najib_Mikati',      name: 'Najib Mikati',              title: 'Prime Minister',      country: 'Lebanon', iso: 'lb' },
  { handle: 'AlsisiOfficial',    name: 'Abdel Fattah el-Sisi',      title: 'President',           country: 'Egypt', iso: 'eg' },

  // ── Asia ──
  { handle: 'narendramodi',      name: 'Narendra Modi',             title: 'Prime Minister',      country: 'India', iso: 'in' },
  { handle: 'MFA_China',         name: 'Chinese MFA',               title: 'Government',          country: 'China', iso: 'cn' },
  { handle: 'ChingteLai',        name: 'Lai Ching-te',              title: 'President',           country: 'Taiwan', iso: 'tw' },
  { handle: 'President_KR',      name: 'Yoon Suk Yeol',             title: 'President',           country: 'South Korea', iso: 'kr' },
  { handle: 'kishida230',        name: 'Fumio Kishida',             title: 'Former PM',           country: 'Japan', iso: 'jp' },
  { handle: 'leehsienloong',     name: 'Lee Hsien Loong',           title: 'Senior Minister',     country: 'Singapore', iso: 'sg' },
  { handle: 'KhurelsukhUkhn',    name: 'Ukhnaagiin Khürelsükh',     title: 'President',           country: 'Mongolia', iso: 'mn' },
  { handle: 'CMShehbaz',         name: 'Shehbaz Sharif',            title: 'Prime Minister',      country: 'Pakistan', iso: 'pk' },
  { handle: 'VietnamGov',        name: 'Government of Vietnam',     title: 'Government',          country: 'Vietnam', iso: 'vn' },

  // ── Southeast Asia ──
  { handle: 'prabowo',           name: 'Prabowo Subianto',          title: 'President',           country: 'Indonesia', iso: 'id' },
  { handle: 'anwaribrahim',      name: 'Anwar Ibrahim',             title: 'Prime Minister',      country: 'Malaysia', iso: 'my' },
  { handle: 'bongbongmarcos',    name: 'Bongbong Marcos',           title: 'President',           country: 'Philippines', iso: 'ph' },

  // ── Africa ──
  { handle: 'officialABAT',      name: 'Bola Tinubu',               title: 'President',           country: 'Nigeria', iso: 'ng' },
  { handle: 'WilliamsRuto',      name: 'William Ruto',              title: 'President',           country: 'Kenya', iso: 'ke' },
  { handle: 'AbiyAhmedAli',      name: 'Abiy Ahmed',                title: 'Prime Minister',      country: 'Ethiopia', iso: 'et' },
  { handle: 'CyrilRamaphosa',    name: 'Cyril Ramaphosa',           title: 'President',           country: 'South Africa', iso: 'za' },
  { handle: 'PaulKagame',        name: 'Paul Kagame',               title: 'President',           country: 'Rwanda', iso: 'rw' },
];

module.exports = LEADER_ACCOUNTS;
