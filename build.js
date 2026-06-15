// Build a single, self-contained dist/index.html.
//
// Everything — app code, the @scure/@noble crypto libs, the QR generator, and
// all CSS — is bundled and inlined so the result is one file you can save and
// open offline straight from the filesystem (file://). No server, no network.

import { mkdir } from 'node:fs/promises';

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f7931a"/><text x="16" y="23" font-size="20" font-family="Arial" font-weight="bold" text-anchor="middle" fill="#fff">₿</text></svg>`
  );

export async function buildHtml({ minify = true } = {}) {
  const result = await Bun.build({
    entrypoints: ['./src/app.js'],
    target: 'browser',
    minify,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('bundle failed');
  }
  let js = await result.outputs[0].text();
  // Guard against a literal </script> inside the bundle closing our tag early.
  js = js.replaceAll('</script', '<\\/script');
  const css = await Bun.file('./src/style.css').text();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="color-scheme" content="light">
<title>Bitcoin Wallet</title>
<link rel="icon" href="${FAVICON}">
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;
}

if (import.meta.main) {
  await mkdir('dist', { recursive: true });
  const html = await buildHtml({ minify: true });
  await Bun.write('dist/index.html', html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`✓ dist/index.html written (${kb} KB) — open it offline, no server needed`);
}
