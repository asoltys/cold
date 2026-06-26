// Silent Payments (BIP-352) — sending side only.
//
// A silent payment address (sp1…) is a static, reusable address the receiver
// publishes once. The sender derives a unique one-time taproot output for each
// payment from the receiver's address plus the sender's own input keys (ECDH),
// so there's no on-chain link between payments and no address reuse — without
// any interaction with the receiver.
//
// This module only does the SENDER half (deriving the output). Receiving needs
// chain scanning (a per-tx ECDH tweak), which a light client can't do without a
// dedicated index server — out of scope here.
//
// Validated against the official BIP-352 send test vectors. We only spend
// compressed P2WPKH inputs, which keeps the eligible-input rules trivial: each
// input contributes its private key as-is (no taproot even-Y negation, no
// uncompressed-key or P2SH edge cases).

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';

const Point = secp256k1.ProjectivePoint;
const G = Point.BASE;
const N = secp256k1.CURVE.n;

const modN = (x) => ((x % N) + N) % N;
const toInt = (bytes) => BigInt('0x' + bytesToHex(bytes));
// tagged hash: sha256(sha256(tag) || sha256(tag) || msg)
const tagged = (tag, msg) => {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
};
const le32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const be32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
};
// A taproot scriptPubKey for a 32-byte x-only key: OP_1 (0x51) PUSH32 (0x20) key.
const taprootScript = (xonly) => concatBytes(Uint8Array.of(0x51, 0x20), xonly);

export function isSilentPaymentAddress(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.toLowerCase();
  if (!a.startsWith('sp1') && !a.startsWith('tsp1')) return false;
  try {
    decodeSilentPaymentAddress(addr);
    return true;
  } catch {
    return false;
  }
}

// Decode sp1…/tsp1… → { scan, spend } (33-byte compressed pubkeys each) + net.
export function decodeSilentPaymentAddress(addr) {
  const { prefix, words } = bech32m.decode(addr.toLowerCase(), 1023);
  if (prefix !== 'sp' && prefix !== 'tsp') throw new Error('Not a silent payment address.');
  if (words[0] !== 0) throw new Error('Unsupported silent payment version.');
  const data = bech32m.fromWords(words.slice(1));
  if (data.length !== 66) throw new Error('Malformed silent payment address.');
  return { scan: data.slice(0, 33), spend: data.slice(33, 66), testnet: prefix === 'tsp' };
}

// Derive the one-time taproot output scripts for a set of silent-payment outputs
// that this transaction's inputs are funding.
//   inputs:  [{ txid (display hex), vout, priv (Uint8Array 32) }] — ALL eligible
//            (P2WPKH) inputs of the tx; the derivation commits to every one.
//   outputs: [{ scan, spend }] — one entry per desired output (repeat the same
//            recipient to pay it multiple times; the k counter is handled here).
// Returns a taproot scriptPubKey (Uint8Array) for each entry, in order.
export function silentPaymentScripts(inputs, outputs) {
  if (!inputs.length) throw new Error('Silent payment needs at least one input.');

  // a = Σ input private keys (mod n); A = a·G
  let a = 0n;
  for (const i of inputs) a = modN(a + toInt(i.priv));
  if (a === 0n) throw new Error('Silent payment input key sum is zero.');
  const A = G.multiply(a);

  // input_hash = H(smallest_outpoint || A); outpoint = txid(wire order) || vout(LE)
  let smallest = null;
  for (const i of inputs) {
    const op = concatBytes(hexToBytes(i.txid).reverse(), le32(i.vout));
    if (!smallest || bytesToHex(op) < bytesToHex(smallest)) smallest = op;
  }
  const inputHash = modN(toInt(tagged('BIP0352/Inputs', concatBytes(smallest, A.toRawBytes(true)))));

  const counters = new Map(); // recipient → next k
  return outputs.map(({ scan, spend }) => {
    const rkey = bytesToHex(scan) + bytesToHex(spend);
    const k = counters.get(rkey) || 0;
    counters.set(rkey, k + 1);
    // ecdh = input_hash·a·B_scan ; t_k = H(ecdh || ser32(k)) ; P = B_spend + t_k·G
    const ecdh = Point.fromHex(scan).multiply(modN(inputHash * a)).toRawBytes(true);
    const tk = modN(toInt(tagged('BIP0352/SharedSecret', concatBytes(ecdh, be32(k)))));
    const Pout = Point.fromHex(spend).add(G.multiply(tk));
    return taprootScript(Pout.toRawBytes(true).slice(1)); // x-only
  });
}

// A unique, valid placeholder taproot scriptPubKey used to size a silent-payment
// output during coin selection, before the real script can be derived (which
// needs the final input set). Swapped out for the real one afterward.
export function silentPaymentPlaceholder(index) {
  return taprootScript(sha256(concatBytes(new TextEncoder().encode('halsp-placeholder'), be32(index))));
}
