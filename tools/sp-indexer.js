// BIP-352 silent-payment tweak indexer (an "oracle").
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
// the same code validated against the BIP-352 vectors. Persists to SQLite (set
// SP_DB to a file to survive restarts; defaults to in-memory). New blocks are
// pushed to subscribed wallets over WebSocket (/ws). Run with bun.

import { Database } from 'bun:sqlite';
import net from 'node:net';
import http from 'node:http';
import { inputPubKey, silentPaymentTweak, buildBloom } from '../src/silentpay.js';

const RPC = process.env.CORE_RPC || 'http://127.0.0.1:18443';
const RPC_USER = process.env.RPC_USER || 'admin1';
const RPC_PASS = process.env.RPC_PASS || '123';
const PORT = Number(process.env.SP_PORT || 8888);
const START = Number(process.env.START_HEIGHT || 0);
const POLL_MS = Number(process.env.POLL_MS || 2000);
const DB_PATH = process.env.SP_DB || ':memory:';
// Mempool (unconfirmed) discovery is great for fast feedback but adds RPC load on
// Core (a getrawtransaction + prevout lookups per new taproot-output tx). On by
// default; set SP_MEMPOOL=0 to disable (e.g. to spare a busy production node).
const MEMPOOL = process.env.SP_MEMPOOL !== '0';

const auth = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');
let rpcId = 0;
// Serialize all RPC so the block sync and mempool poll don't hammer Core
// concurrently (which was dropping sockets).
let rpcLock = Promise.resolve();
function rpc(method, params = [], retry = 2) {
  const p = rpcLock.then(() => rpcCall(method, params, retry));
  rpcLock = p.then(() => {}, () => {});
  return p;
}
const RPC_URL = new URL(RPC);
function rpcCall(method, params = [], retry = 2) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params });
    const req = http.request({
      hostname: RPC_URL.hostname, port: RPC_URL.port || 80, path: RPC_URL.pathname || '/', method: 'POST',
      agent: false, // fresh connection each call — no keep-alive sockets to go stale
      headers: { 'content-type': 'application/json', authorization: auth, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { const j = JSON.parse(data); if (j.error) reject(new Error(`rpc ${method}: ${j.error.message}`)); else resolve(j.result); }
        catch (e) { reject(new Error(`rpc ${method}: ${e.message}`)); }
      });
    });
    req.on('error', (e) => (retry > 0 ? resolve(rpcCall(method, params, retry - 1)) : reject(e)));
    req.write(body);
    req.end();
  });
}

// The scriptPubKey of a previous output (for mempool txs, whose getrawtransaction
// doesn't carry prevouts). Cached within a mempool pass via the parent tx.
async function prevoutScriptPubKey(txid, vout) {
  const ptx = await rpc('getrawtransaction', [txid, true]);
  return (ptx.vout[vout] && ptx.vout[vout].scriptPubKey.hex) || '';
}

// ---- persistent store (SQLite) --------------------------------------------
// blocks(height, hash, items-json); meta(indexed). Survives restarts so we don't
// re-walk the chain — important on mainnet where the initial index is slow.
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.run('CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT, items TEXT)');
db.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)');
const qGetMeta = db.query('SELECT v FROM meta WHERE k = ?');
const qSetMeta = db.query('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
const qPutBlock = db.query('INSERT OR REPLACE INTO blocks (height, hash, items) VALUES (?, ?, ?)');
const qGetBlock = db.query('SELECT hash, items FROM blocks WHERE height = ?');
const qScanFrom = db.query('SELECT height, items FROM blocks WHERE height >= ? ORDER BY height');
let indexed = qGetMeta.get('indexed')?.v ?? (START - 1);

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
  qPutBlock.run(height, hash, JSON.stringify(items));
  qSetMeta.run('indexed', height);
  indexed = height;
  return items;
}

let live = false; // true once caught up to the tip — then new blocks are pushed over WS

async function sync() {
  try {
    const tip = await rpc('getblockcount', []);
    for (let h = Math.max(START, indexed + 1); h <= tip; h++) {
      const items = await indexBlock(h);
      // Push each newly-indexed block (once live) to subscribed wallets, so they
      // scan on arrival instead of polling. The payload carries the items so
      // there's no follow-up fetch.
      if (live) server.publish('blocks', JSON.stringify({ type: 'block', height: h, items }));
      if (h % 100 === 0 || h === tip) console.log(`indexed height ${h}/${tip} (${items.length} sp-tx)`);
    }
    if (!live) { live = true; console.log('caught up — pushing new blocks over websocket'); }
    if (MEMPOOL) await mempoolSync(); // blocks just changed the mempool — reconcile pending
  } catch (e) {
    console.error('sync error:', e.message);
  }
}

// ---- mempool (unconfirmed) SP discovery -----------------------------------
// So a payment shows the moment it's broadcast, not only once mined. We track
// which mempool txs are SP-eligible (getrawtransaction verbosity 2 carries the
// prevouts needed for the tweak) and push the set whenever it changes.
const mempoolSeen = new Map(); // txid -> item | null (null = seen, not an SP tx)
let mempoolItems = [];

// Like scanTx but for a mempool txid: getrawtransaction has no prevouts, so we
// fetch each input's prevout scriptPubKey (only for txs with a taproot output).
async function scanMempoolTx(txid) {
  const tx = await rpc('getrawtransaction', [txid, true]);
  if (tx.vin.some((i) => i.coinbase)) return null;
  const outputs = [];
  for (const o of tx.vout) { const x = taprootXonly(o.scriptPubKey && o.scriptPubKey.hex); if (x) outputs.push({ vout: o.n, value: Math.round(o.value * 1e8), xonly: x }); }
  if (!outputs.length) return null; // not SP-relevant — skip the prevout lookups
  const inputs = [];
  for (const i of tx.vin) {
    let spk = '';
    try { spk = await prevoutScriptPubKey(i.txid, i.vout); } catch {}
    inputs.push({ txid: i.txid, vout: i.vout, pubkey: inputPubKey({ scriptSig: (i.scriptSig && i.scriptSig.hex) || '', witness: i.txinwitness || [], scriptPubKey: spk }) || undefined });
  }
  let tweak;
  try { tweak = silentPaymentTweak(inputs); } catch { return null; }
  if (!tweak) return null;
  return { txid: tx.txid, tweak: Buffer.from(tweak).toString('hex'), outputs };
}

async function mempoolSync() {
  try {
    const txids = await rpc('getrawmempool', []);
    const inPool = new Set(txids);
    let changed = false;
    for (const txid of txids) {
      if (mempoolSeen.has(txid)) continue;
      mempoolSeen.set(txid, null); // mark seen so we don't refetch
      let it = null;
      try { it = await scanMempoolTx(txid); } catch {}
      if (it) { mempoolSeen.set(txid, it); changed = true; }
    }
    for (const txid of mempoolSeen.keys()) if (!inPool.has(txid)) { if (mempoolSeen.get(txid)) changed = true; mempoolSeen.delete(txid); }
    if (changed) {
      mempoolItems = [...mempoolSeen.values()].filter(Boolean);
      if (live) server.publish('blocks', JSON.stringify({ type: 'mempool', items: mempoolItems }));
    }
  } catch (e) {
    console.error('mempool sync error:', e.message);
  }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    // WebSocket: subscribers get a {type:'block', height, items} push per new block.
    if (p === '/ws') {
      if (server.upgrade(req)) return undefined;
      return new Response('expected websocket', { status: 400 });
    }
    if (p === '/height') return json({ height: indexed });
    let m;
    if ((m = p.match(/^\/block\/(\d+)$/))) {
      const b = qGetBlock.get(Number(m[1]));
      if (!b) return json({ error: 'not indexed', height: Number(m[1]), tip: indexed }, 404);
      return json({ height: Number(m[1]), hash: b.hash, items: JSON.parse(b.items) });
    }
    if ((m = p.match(/^\/tweaks\/(\d+)$/))) {
      const b = qGetBlock.get(Number(m[1]));
      return json(b ? JSON.parse(b.items).map((i) => i.tweak) : []);
    }
    // Catch-up over a height range: per block, the tweaks (dust-filtered) + a
    // Bloom filter over that block's taproot output keys — NOT the outputs. The
    // client derives its candidate key per tweak, tests the filter, and only
    // fetches /block for the rare hits. dustLimit (sats) drops txs whose taproot
    // outputs are all below it (fewer tweaks to check).
    if ((m = p.match(/^\/scan\/(\d+)$/))) {
      const dust = Number(url.searchParams.get('dustLimit') || 0);
      const blocks = [];
      for (const row of qScanFrom.all(Number(m[1]))) {
        let items = JSON.parse(row.items);
        if (dust > 0) items = items.filter((it) => it.outputs.some((o) => o.value >= dust));
        if (!items.length) continue;
        const outKeys = items.flatMap((it) => it.outputs.map((o) => o.xonly));
        blocks.push({ height: row.height, tweaks: items.map((it) => it.tweak), filter: buildBloom(outKeys) });
      }
      return json({ tip: indexed, blocks });
    }
    // Current unconfirmed (mempool) SP-eligible txs — for the pending catch-up on
    // connect; live updates arrive as {type:'mempool'} WS pushes.
    if (p === '/mempool') return json({ items: mempoolItems });
    return json({ error: 'not found' }, 404);
  },
  websocket: {
    open(ws) { ws.subscribe('blocks'); ws.send(JSON.stringify({ type: 'height', height: indexed })); },
    message() {}, // clients don't send anything
    close(ws) { ws.unsubscribe('blocks'); },
  },
});

// Instant block detection via Core's `hashblock` ZMQ — trigger a sync the moment
// a block arrives, instead of waiting for the poll. A minimal ZMTP/3.0 SUB client
// (no native dep, so the bundle stays self-contained). The poll below remains a
// backstop if the socket drops.
function subscribeHashblock(endpoint, onBlock) {
  const [host, port] = endpoint.replace(/^tcp:\/\//, '').split(':');
  const sock = net.connect(Number(port), host);
  let buf = Buffer.alloc(0);
  let greeted = false;
  const sendFrame = (flags, body) => {
    const head = body.length < 256
      ? Buffer.from([flags, body.length])
      : Buffer.concat([Buffer.from([flags | 0x02]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(body.length)); return b; })()]);
    sock.write(Buffer.concat([head, body]));
  };
  sock.on('connect', () => {
    const g = Buffer.alloc(64);
    g[0] = 0xff; g[9] = 0x7f; g[10] = 3; g[11] = 0; // signature + ZMTP version 3.0
    g.write('NULL', 12); // security mechanism, null-padded to 20 bytes
    sock.write(g);
  });
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!greeted) {
      if (buf.length < 64) return;
      buf = buf.subarray(64);
      greeted = true;
      // READY (command) advertising Socket-Type=SUB, then subscribe to "hashblock".
      sendFrame(0x04, Buffer.concat([
        Buffer.from([5]), Buffer.from('READY'),
        Buffer.from([11]), Buffer.from('Socket-Type'), Buffer.from([0, 0, 0, 3]), Buffer.from('SUB'),
      ]));
      sendFrame(0x00, Buffer.concat([Buffer.from([0x01]), Buffer.from('hashblock')]));
    }
    while (buf.length >= 2) {
      const flags = buf[0];
      const long = flags & 0x02;
      const headerLen = long ? 9 : 2;
      if (buf.length < headerLen) break;
      const size = long ? Number(buf.readBigUInt64BE(1)) : buf[1];
      if (buf.length < headerLen + size) break;
      const body = buf.subarray(headerLen, headerLen + size);
      buf = buf.subarray(headerLen + size);
      if (!(flags & 0x04) && body.length >= 9 && body.subarray(0, 9).toString() === 'hashblock') onBlock();
    }
  });
  sock.on('error', (e) => console.error('zmq error:', e.message));
  sock.on('close', () => setTimeout(() => subscribeHashblock(endpoint, onBlock), 3000)); // reconnect
}

console.log(`sp-indexer: core=${RPC} db=${DB_PATH} start=${START} resume-from=${indexed + 1} serving :${PORT}`);
await sync();
if (process.env.SP_ZMQ) {
  let t;
  subscribeHashblock(process.env.SP_ZMQ, () => { clearTimeout(t); t = setTimeout(sync, 50); }); // debounce a burst
  console.log(`zmq: subscribed to hashblock at ${process.env.SP_ZMQ}`);
}
setInterval(sync, POLL_MS); // backstop (and the only trigger when SP_ZMQ is unset)
if (MEMPOOL) setInterval(mempoolSync, Number(process.env.MEMPOOL_POLL_MS || 2500)); // unconfirmed SP discovery
