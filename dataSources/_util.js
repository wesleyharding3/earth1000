'use strict';

async function fetchJson(url, opts = {}) {
  const maxRetries = opts.retries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 12000);
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
        signal:  ctrl.signal,
      });
      if (res.status === 429 && attempt < maxRetries) {
        clearTimeout(timer);
        const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
        const delay = (retryAfter && retryAfter > 0 ? retryAfter : 2 + attempt * 3) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: opts.headers || {} });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ISO-3 country code lookup for the World Bank / Comtrade APIs.
// Small curated list — covers ~all major world powers and hotspots.
const ISO3 = {
  'world':'WLD','global':'WLD',
  'united states':'USA','usa':'USA','us':'USA','america':'USA',
  'china':'CHN','japan':'JPN','south korea':'KOR','korea':'KOR','north korea':'PRK',
  'india':'IND','pakistan':'PAK','bangladesh':'BGD','sri lanka':'LKA','nepal':'NPL','afghanistan':'AFG',
  'russia':'RUS','ukraine':'UKR','belarus':'BLR','poland':'POL','germany':'DEU','france':'FRA',
  'united kingdom':'GBR','uk':'GBR','britain':'GBR','italy':'ITA','spain':'ESP','netherlands':'NLD',
  'sweden':'SWE','norway':'NOR','finland':'FIN','denmark':'DNK','greece':'GRC','turkey':'TUR','türkiye':'TUR',
  'iran':'IRN','iraq':'IRQ','israel':'ISR','saudi arabia':'SAU','uae':'ARE','united arab emirates':'ARE',
  'qatar':'QAT','kuwait':'KWT','oman':'OMN','bahrain':'BHR','yemen':'YEM','syria':'SYR','lebanon':'LBN','jordan':'JOR',
  'egypt':'EGY','libya':'LBY','tunisia':'TUN','algeria':'DZA','morocco':'MAR',
  'nigeria':'NGA','ethiopia':'ETH','kenya':'KEN','south africa':'ZAF','sudan':'SDN','dr congo':'COD','congo':'COD',
  'ghana':'GHA','tanzania':'TZA','uganda':'UGA','rwanda':'RWA','niger':'NER','mali':'MLI','somalia':'SOM',
  'mexico':'MEX','brazil':'BRA','argentina':'ARG','colombia':'COL','venezuela':'VEN','chile':'CHL','peru':'PER',
  'ecuador':'ECU','cuba':'CUB','haiti':'HTI','canada':'CAN',
  'australia':'AUS','new zealand':'NZL','indonesia':'IDN','philippines':'PHL','thailand':'THA','vietnam':'VNM',
  'malaysia':'MYS','singapore':'SGP','myanmar':'MMR','cambodia':'KHM','taiwan':'TWN',
};

function toIso3(name) {
  if (!name) return null;
  return ISO3[String(name).trim().toLowerCase()] || null;
}

function pickRecentYears(n = 10) {
  const now = new Date().getFullYear();
  const out = [];
  for (let y = now - n; y < now; y++) out.push(y);
  return out;
}

module.exports = { fetchJson, fetchText, toIso3, pickRecentYears };
