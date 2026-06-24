// Dev server: rebuilds the inlined bundle on every request so you just refresh
// the browser to see changes. Same output as `bun run build`, unminified.

import { buildHtml, buildJsQr } from './build.js';

const port = Number(process.env.PORT || 5173);

Bun.serve({
  port,
  async fetch(req) {
    try {
      const path = new URL(req.url).pathname;
      if (path === '/jsqr.js') {
        return new Response(await buildJsQr({ minify: false }), {
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        });
      }
      const loc = path.match(/^\/locales\/([a-z]{2})\.json$/);
      if (loc) {
        const f = Bun.file('src/locales/' + loc[1] + '.json');
        return (await f.exists())
          ? new Response(f, { headers: { 'content-type': 'application/json; charset=utf-8' } })
          : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      const html = await buildHtml({ minify: false });
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
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
