// End-to-end REVERSE swap (hal receives over Lightning) on regtest:
//   1. hal requests a reverse swap (preimage it controls)
//   2. coinos `cl` pays the hold invoice (HTLC locked)
//   3. Boltz locks funds on-chain to the swap address
//   4. hal claims them on-chain via the taproot SCRIPT PATH (preimage + sig)
//   5. Boltz extracts the preimage, settles the LN payment
// Proves buildSwapSpend (reverse claim) against the live stack.
// Run (stack up): bun tools/swap-e2e-reverse.test.js
import { $ } from 'bun';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as btc from '@scure/btc-signer';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hash160, swapP2TR, buildSwapSpend, REGTEST } from '../src/swap.js';

const BOLTZ = 'http://localhost:9001';
const ESPLORA = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jget = async (u) => { const r = await fetch(u); return r.ok ? r.json() : null; };
const post = async (p, b) => {
  const r = await fetch(BOLTZ + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j)}`); return j;
};

// hal's claim key, preimage, and a destination address it controls.
const claimPriv = secp256k1.utils.randomPrivateKey();
const claimPub = secp256k1.getPublicKey(claimPriv, true);
const preimage = randomBytes(32);
const destPriv = secp256k1.utils.randomPrivateKey();
const destAddr = btc.p2wpkh(secp256k1.getPublicKey(destPriv, true), REGTEST).address;

const amount = 120000;
const swap = await post('/v2/swap/reverse', {
  invoiceAmount: amount, from: 'BTC', to: 'BTC',
  claimPublicKey: bytesToHex(claimPub), preimageHash: bytesToHex(sha256(preimage)),
});
console.log('swap', swap.id, 'lockup', swap.lockupAddress, 'onchain', swap.onchainAmount);

const boltzPub = hexToBytes(swap.refundPublicKey);
const d = swapP2TR({ kind: 'reverse', preimageHash160: hash160(preimage), boltzPub33: boltzPub, halPub33: claimPub, lockTime: swap.timeoutBlockHeight, network: 'regtest' });
if (d.address !== swap.lockupAddress) throw new Error('address mismatch — abort');

// Pay the hold invoice from cl (backgrounded — it stays pending until we claim).
console.log('paying hold invoice from cl…');
Bun.spawn(['docker', 'exec', 'cl', 'lightning-cli', '--regtest', 'pay', swap.invoice], { stdout: 'ignore', stderr: 'ignore' });

// Wait for Boltz to lock funds on-chain to the swap address.
let utxo = null;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const us = await jget(`${ESPLORA}/address/${swap.lockupAddress}/utxo`);
  if (us && us.length) { utxo = us[0]; break; }
}
if (!utxo) throw new Error('lockup not seen on-chain (esplora)');
console.log('lockup utxo', utxo.txid, 'vout', utxo.vout, 'value', utxo.value);

// Claim it on-chain via the script path.
const fee = 300;
const claimHex = buildSwapSpend({
  pay: d.pay, leaf: d.claimLeaf, halPriv: claimPriv, preimage,
  lockupTxid: utxo.txid, lockupVout: utxo.vout, lockupValue: utxo.value,
  destAddress: destAddr, fee, network: 'regtest',
});
const br = await fetch(`${ESPLORA}/tx`, { method: 'POST', body: claimHex });
const claimTxid = await br.text();
if (!br.ok) throw new Error('broadcast failed: ' + claimTxid);
console.log('claim broadcast', claimTxid);

// Verify hal's destination received the funds.
let got = null;
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  const us = await jget(`${ESPLORA}/address/${destAddr}/utxo`);
  if (us && us.length) { got = us[0]; break; }
}
if (!got) throw new Error('destination did not receive claim');
console.log(`\nPASS — hal received ${got.value} sat on-chain at ${destAddr} (reverse swap claimed via script path)`);
process.exit(0);
