'use strict';
const shareImg = require('./shareImageGenerator');

const entity = {
  kind:        'thread-portrait',
  cacheKey:    'bench-portrait',
  title:       'Trump Tightens Iran Pressure Amid Stalled Diplomacy',
  description: 'Trump escalates economic and military pressure on Iran as diplomatic negotiations stall over enrichment limits. Allied nations split on the next round of sanctions, while Tehran signals readiness to retaliate via proxies in the region.',
  isos:        ['IR', 'US', 'IL', 'DE', 'FR', 'GB'],
  category:    'diplomacy',
  articleCount: 89, countryCount: 8, languageCount: 4,
};

(async () => {
  // Warm flag cache so the first timed run doesn't pay the network hit.
  await shareImg.generateFrame(entity, 1);

  const samples = [0.0, 0.25, 0.5, 0.75, 1.0];
  for (const p of samples) {
    const t0 = Date.now();
    const png = await shareImg.generateFrame(entity, p);
    console.log(`progress=${p} → ${png.length} bytes in ${Date.now() - t0}ms`);
  }
})().catch(err => { console.error(err); process.exit(1); });
