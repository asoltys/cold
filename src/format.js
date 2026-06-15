// Small formatting helpers. Internally amounts are integer satoshis (Number;
// safe because max BTC supply ~2.1e15 sats < Number.MAX_SAFE_INTEGER).

export const SATS = 100_000_000;

export function btc(sats) {
  return (Number(sats) / SATS).toFixed(8);
}

// "0.01234500" with the trailing-zero portion dimmed is done in CSS; here we
// just produce a clean fixed-8 string.
export function fmtBtc(sats) {
  return btc(sats);
}

export function fmtSats(sats) {
  return Number(sats).toLocaleString('en-US');
}

export function fmtUsd(sats, price) {
  if (!price) return '';
  const usd = (Number(sats) / SATS) * price;
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Parse a user-entered amount. Accepts BTC (default) or sats.
export function parseAmount(value, unit) {
  const n = Number(String(value).trim().replace(/,/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return unit === 'sats' ? Math.round(n) : Math.round(n * SATS);
}

export function shortAddr(a, head = 10, tail = 8) {
  if (!a || a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortTxid(t) {
  return shortAddr(t, 8, 8);
}

export function timeAgo(unixSeconds) {
  if (!unixSeconds) return 'pending';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  const units = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [secs, label] of units) {
    if (s >= secs) return `${Math.floor(s / secs)}${label} ago`;
  }
  return `${s}s ago`;
}
