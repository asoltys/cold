// Dev server: rebuilds the inlined bundle on every request so you just refresh
// the browser to see changes. Same output as `bun run build`, unminified.

import { buildHtml } from './build.js';

const port = Number(process.env.PORT || 5173);

Bun.serve({
  port,
  async fetch() {
    try {
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
