// yt-rss-proxy — Cloudflare Worker that proxies YouTube RSS feeds through
// CF's edge network. YouTube's bot detection has Render's IP range in
// deep penalty (~85% 404/500 rate from there); CF edge IPs are clean.
// 5-minute edge cache absorbs duplicate hits within a cron run.
//
// Free tier limits (more than enough for our load):
//   100,000 requests/day, 10ms CPU/req, 100k cache reads, 1k writes
//
// Deploy:
//   1. dash.cloudflare.com → Workers & Pages → Create Worker
//   2. Name it (e.g. "yt-rss-proxy") and Deploy with placeholder
//   3. Edit code → paste this file → Deploy
//   4. Note the worker URL: https://yt-rss-proxy.<your-subdomain>.workers.dev
//   5. Render env: YOUTUBE_RSS_PROXY=<that URL>
//   6. Test: curl 'https://<worker>/?channel_id=UCSaj7CR2pMGrTrKhGHoX73w'
//      → should return atom XML, not 404
//
// Caller (youtubeFetcher.js) does the URL rewrite:
//   https://www.youtube.com/feeds/videos.xml?channel_id=X
//   →  https://<worker>/?channel_id=X
//
// Caching: only successful upstream responses are cached. 404/500
// pass through with no-store so a transient YouTube hiccup doesn't
// poison the cache for 5 minutes.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const channelId = url.searchParams.get('channel_id');

    // Defensive: only allow valid YouTube channel-id chars.
    if (!channelId || !/^[A-Za-z0-9_-]{10,40}$/.test(channelId)) {
      return new Response('invalid channel_id', { status: 400 });
    }

    const ytUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const cacheKey = new Request(ytUrl, { method: 'GET' });
    const cache = caches.default;

    // Edge cache first
    const cached = await cache.match(cacheKey);
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('X-Worker-Cache', 'HIT');
      h.set('Access-Control-Allow-Origin', '*');
      return new Response(cached.body, { status: cached.status, headers: h });
    }

    // Cache miss — fetch from YouTube with realistic browser headers
    const upstream = await fetch(ytUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cf: { cacheEverything: false },
    });

    const respHeaders = new Headers(upstream.headers);
    respHeaders.set('X-Worker-Cache', 'MISS');
    respHeaders.set('Access-Control-Allow-Origin', '*');
    if (upstream.ok) {
      respHeaders.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    } else {
      respHeaders.set('Cache-Control', 'no-store');
    }
    const response = new Response(upstream.body, { status: upstream.status, headers: respHeaders });

    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  },
};
