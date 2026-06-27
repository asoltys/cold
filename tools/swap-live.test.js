// Live integration check against the local Boltz (http://localhost:9001) +
// regtest CLN. Confirms Hal's locally-derived swap address + tapleaves match
// Boltz's lockupAddress + swapTree for BOTH flows — proving the MuSig2
// internal-key order ([boltzKey, halKey]), the taptweak, and leaf construction.
// Run (regtest Boltz stack up): bun tools/swap-live.test.js
import { $ } from 'bun';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/legacy';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { hash160, swapP2TR, buildSwapTree } from '../src/swap.js';

const BOLTZ = process.env.BOLTZ_API || 'http://localhost:9001';
const post = async (p, b) => {
  const r = await fetch(BOLTZ + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const kp = () => { const sk = secp256k1.utils.randomPrivateKey(); return { sk, pk: secp256k1.getPublicKey(sk, true) }; };
let fail = 0;
const eq = (n, g, w) => { if (g === w) console.log(`  ok  ${n}`); else { fail++; console.log(`FAIL ${n}\n  got:  ${g}\n  want: ${w}`); } };

// ---------- REVERSE (hal receives over LN; hal claims) ----------
{
  const claim = kp();
  const preimage = randomBytes(32);
  const res = await post('/v2/swap/reverse', {
    invoiceAmount: 100000, from: 'BTC', to: 'BTC',
    claimPublicKey: bytesToHex(claim.pk), preimageHash: bytesToHex(sha256(preimage)),
  });
  const boltzPub = hexToBytes(res.refundPublicKey); // Boltz refunds on reverse
  const d = swapP2TR({ kind: 'reverse', preimageHash160: hash160(preimage), boltzPub33: boltzPub, halPub33: claim.pk, lockTime: res.timeoutBlockHeight, network: 'regtest' });
  eq('reverse lockup address', d.address, res.lockupAddress);
  eq('reverse claim leaf', bytesToHex(d.claimLeaf), res.swapTree.claimLeaf.output);
  eq('reverse refund leaf', bytesToHex(d.refundLeaf), res.swapTree.refundLeaf.output);
}

// ---------- SUBMARINE (hal spends over LN; hal refunds) ----------
{
  const inv = JSON.parse(await $`docker exec clb lightning-cli --regtest invoice 100000000 hal-sub-${Date.now()} test`.text());
  const payHash = inv.payment_hash;
  const refund = kp(); // hal's refund key
  const res = await post('/v2/swap/submarine', {
    invoice: inv.bolt11, from: 'BTC', to: 'BTC', refundPublicKey: bytesToHex(refund.pk),
  });
  const boltzPub = hexToBytes(res.claimPublicKey); // Boltz claims on submarine
  // tapscript embeds hash160(preimage) = ripemd160(payment_hash)
  const ph160 = ripemd160(hexToBytes(payHash));
  const d = swapP2TR({ kind: 'submarine', preimageHash160: ph160, boltzPub33: boltzPub, halPub33: refund.pk, lockTime: res.timeoutBlockHeight, network: 'regtest' });
  eq('submarine lockup address', d.address, res.address);
  eq('submarine claim leaf', bytesToHex(d.claimLeaf), res.swapTree.claimLeaf.output);
  eq('submarine refund leaf', bytesToHex(d.refundLeaf), res.swapTree.refundLeaf.output);
}

console.log(fail ? `\n${fail} FAILED` : '\nall good');
process.exit(fail ? 1 : 0);
