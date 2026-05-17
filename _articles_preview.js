'use strict';
const fs = require('fs');
const shareImg = require('./shareImageGenerator');

(async () => {
  const png = await shareImg.generate({
    kind:      'thread-articles',
    cacheKey:  `preview-articles-${Date.now()}`,
    title:     'Trump Tightens Iran Pressure Amid Stalled Diplomacy',
    category:  'diplomacy',
    articles:  [
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
  });
  fs.writeFileSync('/tmp/articles-preview.png', png);
  console.log('Written /tmp/articles-preview.png  (' + png.length + ' bytes)');
})().catch(err => { console.error(err); process.exit(1); });
