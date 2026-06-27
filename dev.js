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
