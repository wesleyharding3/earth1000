'use strict';
const fs = require('fs');
const anim = require('./animatedCardRenderer');

const sharedTitle = 'Trump Tightens Iran Pressure Amid Stalled Diplomacy';
const sharedCategory = 'diplomacy';

const portraitEntity = {
  kind:        'thread-portrait',
  cacheKey:    `preview-anim-portrait-${Date.now()}`,
  title:       sharedTitle,
  description: 'Trump escalates economic and military pressure on Iran as diplomatic negotiations stall over enrichment limits. Allied nations split on the next round of sanctions, while Tehran signals readiness to retaliate via proxies in the region.',
  isos:        ['IR', 'US', 'IL', 'DE', 'FR', 'GB'],
  category:    sharedCategory,
  articleCount: 89, countryCount: 8, languageCount: 4,
};

const pieEntity = {
  kind:        'thread-coverage',
  cacheKey:    `preview-anim-pie-${Date.now()}`,
  title:       sharedTitle,
  category:    sharedCategory,
  countryCounts: [
    { iso: 'us', name: 'United States', count: 14 },
    { iso: 'gb', name: 'United Kingdom', count:  9 },
    { iso: 'ir', name: 'Iran',           count:  7 },
    { iso: 'il', name: 'Israel',         count:  6 },
    { iso: 'de', name: 'Germany',        count:  5 },
    { iso: 'fr', name: 'France',         count:  4 },
    { iso: 'cn', name: 'China',          count:  3 },
    { iso: 'qa', name: 'Qatar',          count:  2 },
    { iso: 'ru', name: 'Russia',         count:  1 },
  ],
  articleCount: 89, sourceCount: 52,
};

const articlesEntity = {
  kind:        'thread-articles',
  cacheKey:    `preview-anim-articles-${Date.now()}`,
  title:       sharedTitle,
  category:    sharedCategory,
  articles: [
    {
      headline:     'White House signals new sanctions package targeting Iranian oil exports',
      source_name:  'Reuters',
      source_iso:   'gb',
      hero_url:     'https://images.unsplash.com/photo-1541872703-74c5e44368f4?w=400',
      published_at: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
    },
    {
      headline:     'Tehran says enrichment program will continue regardless of Western pressure',
      source_name:  'Al Jazeera',
      source_iso:   'qa',
      hero_url:     'https://images.unsplash.com/photo-1518709268805-4e9042af2176?w=400',
      published_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    },
    {
      headline:     'Germany and France urge return to negotiations as economic pressure mounts',
      source_name:  'Deutsche Welle',
      source_iso:   'de',
      hero_url:     'https://images.unsplash.com/photo-1495020689067-958852a7765e?w=400',
      published_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    },
    {
      headline:     'China calls for restraint as oil markets react to escalation risk',
      source_name:  'Xinhua',
      source_iso:   'cn',
      hero_url:     'https://images.unsplash.com/photo-1605792657660-596af9009e82?w=400',
      published_at: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
    },
  ],
};

(async () => {
  const args = process.argv.slice(2);
  const which = args[0] || 'all';   // 'portrait' | 'pie' | 'articles' | 'all'

  const jobs = [];
  if (which === 'portrait' || which === 'all') jobs.push({ name: 'portrait', entity: portraitEntity });
  if (which === 'pie'      || which === 'all') jobs.push({ name: 'pie',      entity: pieEntity      });
  if (which === 'articles' || which === 'all') jobs.push({ name: 'articles', entity: articlesEntity });

  for (const j of jobs) {
    process.stdout.write(`rendering ${j.name}... `);
    const t0 = Date.now();
    const mp4 = await anim.generateVideo(j.entity);
    const ms = Date.now() - t0;
    const outPath = `/tmp/anim-${j.name}.mp4`;
    fs.writeFileSync(outPath, mp4);
    console.log(`${outPath}  (${mp4.length} bytes, ${ms}ms)`);
  }
})().catch(err => { console.error(err); process.exit(1); });
