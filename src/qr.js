// QR rendering via the zero-dependency `qrcode-generator` library, output as a
// crisp SVG path (scales perfectly, no canvas, prints well on a paper wallet).

import qrcode from 'qrcode-generator';

// ec: error-correction level. 'M' by default; pass 'L' for long payloads (e.g.
// gift links) where a smaller, chunkier grid scans more easily — on-screen QRs
// are scanned immediately and don't need the damage tolerance of higher levels.
// mode: pass 'Alphanumeric' for an all-uppercase QR-alphanumeric string (0-9 A-Z
// space $%*+-./:) to pack it at 5.5 bits/char instead of byte mode's 8 — a much
// smaller grid for the same data. Falls back to byte mode if the text doesn't fit.
export function qrSvg(text, { margin = 2, ec = 'M', mode } = {}) {
  let qr;
  try {
    qr = qrcode(0, ec);
    qr.addData(text, mode);
    qr.make();
  } catch {
    qr = qrcode(0, ec); // mode mismatch (e.g. a non-alphanumeric char) — plain byte mode
    qr.addData(text);
    qr.make();
  }

  const count = qr.getModuleCount();
  const size = count + margin * 2;

  let path = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        path += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" class="qr">
    <rect width="${size}" height="${size}" fill="#fff"/>
    <path d="${path}" fill="#111"/>
  </svg>`;
}
