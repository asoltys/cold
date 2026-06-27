// End-to-end SUBMARINE swap (hal spends over Lightning) on regtest:
//   1. `cl` issues an invoice (the payee/merchant)
//   2. hal creates a submarine swap for it (refund key it controls)
//   3. hal funds the on-chain lockup with expectedAmount (here: from bc)
//   4. Boltz detects the lockup, pays the LN invoice, and claims the lockup
//   5. the invoice is paid → hal's on-chain spend reached a LN payee
// Proves swap creation + address + the funded-lockup → Boltz-pays path.
// (Refund-path signing is the same buildSwapSpend validated by the reverse E2E.)
// Run (stack up): bun tools/swap-e2e-submarine.test.js
import { $ } from 'bun';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/legacy';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { swapP2TR } from '../src/swap.js';

const BOLTZ = 'http://localhost:9001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => {
  const r = await fetch(BOLTZ + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j)}`); return j;
};
const bcli = (...a) => $`docker exec bc bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123 ${a}`.text();
const clcli = (...a) => $`docker exec cl lightning-cli --regtest ${a}`.text();

// cl (payee) issues an invoice hal wants to pay.
const amount = 120000;
const inv = JSON.parse(await clcli('invoice', String(amount * 1000), `hal-${Date.now()}`, 'submarine test'));

// hal's refund key + submarine swap.
const refundPriv = secp256k1.utils.randomPrivateKey();
const refundPub = secp256k1.getPublicKey(refundPriv, true);
const swap = await post('/v2/swap/submarine', { invoice: inv.bolt11, from: 'BTC', to: 'BTC', refundPublicKey: bytesToHex(refundPub) });
console.log('swap', swap.id, 'lockup', swap.address, 'expected', swap.expectedAmount);

// Verify the lockup address before funding (don't-trust-verify).
const d = swapP2TR({ kind: 'submarine', preimageHash160: ripemd160(hexToBytes(inv.payment_hash)), boltzPub33: hexToBytes(swap.claimPublicKey), halPub33: refundPub, lockTime: swap.timeoutBlockHeight, network: 'regtest' });
if (d.address !== swap.address) throw new Error('address mismatch — abort');
console.log('lockup address verified ✓');

// Fund the lockup (in real hal this is wallet coin-selection; here: from bc).
await bcli('-rpcwallet=coinos', 'sendtoaddress', swap.address, (swap.expectedAmount / 1e8).toFixed(8));
const mineAddr = (await bcli('-rpcwallet=coinos', 'getnewaddress')).trim();
await bcli('generatetoaddress', '1', mineAddr); // confirm (maxZeroConfAmount=0)
console.log('lockup funded + confirmed; waiting for Boltz to pay the invoice…');

// Boltz should detect the lockup, pay the LN invoice, and claim.
let paid = false;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  const ls = JSON.parse(await clcli('listinvoices'));
  const mine = ls.invoices?.find((x) => x.payment_hash === inv.payment_hash);
  if (mine?.status === 'paid') { paid = true; break; }
}
if (!paid) throw new Error('invoice not paid by Boltz within timeout');
console.log(`\nPASS — Boltz paid hal's submarine invoice (${amount} sat) after the on-chain lockup. hal spent on-chain → LN payee.`);
process.exit(0);
