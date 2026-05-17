'use strict';
const fs = require('fs');
const shareImg = require('./shareImageGenerator');

(async () => {
  const png = await shareImg.generate({
    kind:     'thread-coverage',
    cacheKey: `preview-pie-${Date.now()}`,
    title:    'Trump Tightens Iran Pressure Amid Stalled Diplomacy',
    category: 'diplomacy',
    // Country spread: distinct sources per country. Top-N get their own slice;
    // remainder collapses into "+N more" via the template.
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
      { iso: 'jp', name: 'Japan',          count:  1 },
    ],
    articleCount: 89,
    sourceCount:  52,
  });
  fs.writeFileSync('/tmp/pie-preview.png', png);
  console.log('Written /tmp/pie-preview.png  (' + png.length + ' bytes)');
})().catch(err => { console.error(err); process.exit(1); });
