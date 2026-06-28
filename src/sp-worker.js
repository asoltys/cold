// Web Worker: the EC-heavy silent-payment crypto, kept off the main thread so a
// large scan never janks the UI. Memoizes per tweak (a tweak's outcome is fixed),
// so repeated mempool pushes — which re-send the same tweaks — stay cheap.
//
// Protocol (request/response by id):
//   { id, op:'keys', scanPriv, spendPub }                  → { id, ok:true }
//   { id, op:'candidates', blocks:[{height,tweaks,filter}] } → { id, hits:[height] }
//   { id, op:'scan', items:[{txid,tweak,outputs}] }        → { id, found:[utxo] }

import { hex } from '@scure/base';
import { silentPaymentScan, silentPaymentCandidate, bloomHas } from './silentpay.js';

let scanPriv = null;
let spendPub = null;
const scanCache = new Map(); // tweakHex -> matches
const candCache = new Map(); // tweakHex -> candidate x-only hex

self.onmessage = (e) => {
  const { id, op } = e.data;
  try {
    if (op === 'keys') {
      scanPriv = e.data.scanPriv;
      spendPub = e.data.spendPub;
      scanCache.clear();
      candCache.clear();
      self.postMessage({ id, ok: true });
      return;
    }
    if (op === 'candidates') {
      // Return the heights of blocks whose Bloom filter could contain one of our
      // outputs (derive a candidate per tweak, test the filter, stop on first hit).
      const hits = [];
      for (const b of e.data.blocks) {
        for (const tw of b.tweaks) {
          let c = candCache.get(tw);
          if (!c) {
            if (candCache.size > 100000) candCache.clear();
            c = silentPaymentCandidate({ scanPriv, spendPub, tweak: hex.decode(tw) });
            candCache.set(tw, c);
          }
          if (bloomHas(b.filter, c)) { hits.push(b.height); break; }
        }
      }
      self.postMessage({ id, hits });
      return;
    }
    if (op === 'scan') {
      // Full scan: return resolved utxos {txid,vout,value,xonly,tweak} for ours.
      const found = [];
      for (const it of e.data.items) {
        let m = scanCache.get(it.tweak);
        if (!m) {
          if (scanCache.size > 100000) scanCache.clear();
          m = silentPaymentScan({ scanPriv, spendPub, tweak: hex.decode(it.tweak), outputs: it.outputs.map((o) => o.xonly) });
          scanCache.set(it.tweak, m);
        }
        for (const mm of m) {
          const o = it.outputs.find((x) => x.xonly === mm.output);
          if (o) found.push({ txid: it.txid, vout: o.vout, value: o.value, xonly: mm.output, tweak: mm.tweak });
        }
      }
      self.postMessage({ id, found });
      return;
    }
    self.postMessage({ id, error: 'unknown op ' + op });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
