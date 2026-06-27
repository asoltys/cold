// Minimal BIP-352 silent-payment tweak indexer (an "oracle") for regtest dev.
//
// It walks the chain from a Bitcoin Core node and, per block, emits one entry per
// silent-payment-eligible transaction: the tweak (input_hash·A over the tx's
// eligible inputs) plus that transaction's taproot outputs. A wallet fetches
// these, computes ecdh = scan_priv·tweak on-device, derives P_k = B_spend + t_k·G,
// and matches it against the entry's outputs — the scan key never leaves the
// client. Discovered outputs are ordinary taproot UTXOs, so spends/confirmations
// are tracked by the normal Electrum backend; this server only does discovery.
//
// Shares the SP crypto with the wallet (../src/silentpay.js) so the tweak math is
// the same code validated against the BIP-352 vectors. In-memory, regtest-sized;
// re-indexes on restart. Run with bun.

import { inputPubKey, silentPaymentTweak } from '../src/silentpay.js';

const RPC = process.env.CORE_RPC || 'http://127.0.0.1:18443';
const RPC_USER = process.env.RPC_USER || 'admin1';
const RPC_PASS = process.env.RPC_PASS || '123';
const PORT = Number(process.env.SP_PORT || 8888);
const START = Number(process.env.START_HEIGHT || 0);
const POLL_MS = Number(process.env.POLL_MS || 2000);

const auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
let rpcId = 0;
async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

// height -> { hash, items: [{ txid, tweak(hex), outputs: [{ vout, value(sat), xonly(hex) }] }] }
const blocks = new Map();
let indexed = -1; // highest indexed height

// Is a scriptPubKey (hex) a P2TR output? OP_1 PUSH32 <x-only> = 5120<64 hex>.
const taprootXonly = (hex) => (hex && hex.length === 68 && hex.startsWith('5120') ? hex.slice(4) : null);

function scanTx(tx) {
  // Eligible-input set: every input with its recovered pubkey (null if ineligible
  // or coinbase); the tweak needs all outpoints but only eligible pubkeys.
  if (tx.vin.some((i) => i.coinbase)) return null; // coinbase is never a silent payment
  const inputs = tx.vin.map((i) => ({
    txid: i.txid,
    vout: i.vout,
    pubkey: inputPubKey({
      scriptSig: (i.scriptSig && i.scriptSig.hex) || '',
      witness: i.txinwitness || [],
      scriptPubKey: (i.prevout && i.prevout.scriptPubKey && i.prevout.scriptPubKey.hex) || '',
    }) || undefined,
  }));
  const outputs = [];
  for (const o of tx.vout) {
    const x = taprootXonly(o.scriptPubKey && o.scriptPubKey.hex);
    if (x) outputs.push({ vout: o.n, value: Math.round(o.value * 1e8), xonly: x });
  }
  if (!outputs.length) return null; // no taproot output → can't be an SP payment
  let tweak;
  try { tweak = silentPaymentTweak(inputs); } catch { return null; }
  if (!tweak) return null; // no eligible inputs
  return { txid: tx.txid, tweak: Buffer.from(tweak).toString('hex'), outputs };
}

async function indexBlock(height) {
  const hash = await rpc('getblockhash', [height]);
  const block = await rpc('getblock', [hash, 3]); // verbosity 3: full txs with prevouts
  const items = [];
  for (const tx of block.tx) { const it = scanTx(tx); if (it) items.push(it); }
  blocks.set(height, { hash, items });
  indexed = height;
}

async function sync() {
  try {
    const tip = await rpc('getblockcount', []);
    for (let h = Math.max(START, indexed + 1); h <= tip; h++) {
      await indexBlock(h);
      if (h % 100 === 0 || h === tip) console.log(`indexed height ${h}/${tip} (${blocks.get(h).items.length} sp-tx)`);
    }
  } catch (e) {
    console.error('sync error:', e.message);
  }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (p === '/height') return json({ height: indexed });
    let m;
    if ((m = p.match(/^\/block\/(\d+)$/))) {
      const h = Number(m[1]);
      const b = blocks.get(h);
      if (!b) return json({ error: 'not indexed', height: h, tip: indexed }, 404);
      return json({ height: h, hash: b.hash, items: b.items });
    }
    if ((m = p.match(/^\/tweaks\/(\d+)$/))) {
      const b = blocks.get(Number(m[1]));
      return json(b ? b.items.map((i) => i.tweak) : []);
    }
    return json({ error: 'not found' }, 404);
  },
});

console.log(`sp-indexer: core=${RPC} start=${START} serving :${PORT}`);
await sync();
setInterval(sync, POLL_MS);
