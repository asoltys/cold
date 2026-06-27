// Drives the SwapManager reverse flow end-to-end with a minimal wallet shim:
// startReverse -> pay the hold invoice from cl -> manager auto-claims on-chain.
// Run (stack up): bun tools/swap-manager.test.js
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes } from '@noble/hashes/utils';
import { SwapManager, REGTEST } from '../src/swap.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESPLORA = 'http://localhost:3000';
// Fresh random seed per run (real wallet persists swaps so swapNode indices
// increment; this shim's store is in-memory, so randomize to avoid preimage reuse).
const acct = HDKey.fromMasterSeed(randomBytes(64)).derive("m/84'/1'/0'");

let store = [];
const wallet = {
  loadSwaps: () => store,
  saveSwaps: (l) => { store = l; },
  nextSwapIndex: () => store.reduce((m, s) => Math.max(m, (s.swapIndex ?? -1) + 1), 0),
  swapNode: (i) => acct.deriveChild(2).deriveChild(i),
  freshReceive: () => ({ address: btc.p2wpkh(secp256k1.getPublicKey(acct.deriveChild(0).deriveChild(7).privateKey, true), REGTEST).address }),
  api: {
    addressUtxos: async (a) => { const r = await fetch(`${ESPLORA}/address/${a}/utxo`); return r.ok ? r.json() : []; },
    broadcast: async (hex) => { const r = await fetch(`${ESPLORA}/tx`, { method: 'POST', body: hex }); const t = await r.text(); if (!r.ok) throw new Error(t); return t; },
  },
};

const sm = new SwapManager({ wallet, network: 'regtest', getApi: () => 'http://localhost:9001', feeRate: 2, onUpdate: () => {} });
const rec = await sm.startReverse(120000);
console.log('startReverse ->', rec.id, rec.status, 'lockup', rec.lockupAddress);

console.log('paying hold invoice from cl…');
Bun.spawn(['docker', 'exec', 'cl', 'lightning-cli', '--regtest', 'pay', rec.invoice], { stdout: 'ignore', stderr: 'ignore' });

for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = sm.list().find((s) => s.id === rec.id);
  if (r.status === 'claimed') { console.log(`\nPASS — SwapManager auto-claimed: ${r.received} sats, txid ${r.claimTxid}`); process.exit(0); }
  if (r.lastError && i % 5 === 0) console.log('  …', r.lastError);
}
console.log('FAIL — not claimed:', JSON.stringify(sm.list()));
process.exit(1);
