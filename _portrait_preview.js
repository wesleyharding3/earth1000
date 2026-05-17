'use strict';
const fs = require('fs');
const shareImg = require('./shareImageGenerator');

(async () => {
  const png = await shareImg.generate({
    kind:      'thread-portrait',
    cacheKey:  `preview-portrait-${Date.now()}`,
    title:     'Trump Tightens Iran Pressure Amid Stalled Diplomacy',
    description: 'Trump escalates economic and military pressure on Iran as diplomatic negotiations stall over enrichment limits. Allied nations split on the next round of sanctions, while Tehran signals readiness to retaliate via proxies in the region.',
    isos:      ['IR', 'US', 'IL', 'DE', 'FR', 'GB', 'CN', 'RU'],
    category:  'diplomacy',
    articleCount:  89,
    countryCount:  8,
    languageCount: 4,
  });
  fs.writeFileSync('/tmp/portrait-preview.png', png);
  console.log('Written /tmp/portrait-preview.png  (' + png.length + ' bytes)');
})().catch(err => { console.error(err); process.exit(1); });
