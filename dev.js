// Dev server: rebuilds the inlined bundle on every request so you just refresh
// the browser to see changes. Same output as `bun run build`, unminified.

import { buildHtml, buildJsQr } from './build.js';

const port = Number(process.env.PORT || 5173);

Bun.serve({
  port,
  async fetch(req) {
    // Never let the browser cache (or bfcache) dev assets — every load rebuilds
    // from source, so a stale HTTP cache or restored tab can't pin old code.
    const NO_STORE = 'no-store, must-revalidate';
    try {
      const path = new URL(req.url).pathname;
      // The regtest boltz API (localhost:9001) sends no CORS headers, so the
      // browser can't fetch it cross-origin. Proxy /boltz/* to it (adding CORS)
      // so Lightning swaps work same-origin in dev.
      if (path === '/boltz' || path.startsWith('/boltz/')) {
        const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        const target = 'http://localhost:9001' + path.replace(/^\/boltz/, '') + new URL(req.url).search;
        const r = await fetch(target, {
          method: req.method,
          headers: req.headers.get('content-type') ? { 'content-type': req.headers.get('content-type') } : {},
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text(),
        });
        return new Response(await r.text(), { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json', ...CORS } });
      }
      if (path === '/jsqr.js') {
        return new Response(await buildJsQr({ minify: false }), {
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': NO_STORE },
        });
      }
      const loc = path.match(/^\/locales\/([a-z]{2})\.json$/);
      if (loc) {
        const f = Bun.file('src/locales/' + loc[1] + '.json');
        return (await f.exists())
          ? new Response(f, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE } })
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json', 'cache-control': NO_STORE } });
      }
      const html = await buildHtml({ minify: false });
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': NO_STORE },
      });
    } catch (e) {
      return new Response(`Build error:\n\n${e.stack || e}`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
});

console.log(`dev server → http://localhost:${port}`);
