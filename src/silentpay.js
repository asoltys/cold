// Silent Payments (BIP-352) — sending and receiving.
//
// A silent payment address (sp1…) is a static, reusable address the receiver
// publishes once. The sender derives a unique one-time taproot output for each
// payment from the receiver's address plus the sender's own input keys (ECDH),
// so there's no on-chain link between payments and no address reuse — without
// any interaction with the receiver.
//
// Sending (silentPaymentScripts) derives the output; we only spend compressed
// P2WPKH inputs, so each input contributes its private key as-is. Receiving (see
// the second half) can't scan the chain in a browser, so an indexing server
// supplies per-tx tweaks + taproot UTXOs and we match them on-device.
//
// Validated against the official BIP-352 send + receive test vectors.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';

const hash160 = (b) => ripemd160(sha256(b));

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

// ===========================================================================
// Receiving (BIP-352).
//
// A browser light client can't scan the chain itself, so an indexing server (an
// SP "oracle") provides, per block, the tweaks — one 33-byte point (input_hash·A,
// the sum of a tx's eligible input pubkeys folded with its input hash) per
// eligible transaction — plus the taproot UTXOs created in that block. The
// receiver then does the private part on-device: ecdh = b_scan · tweak, then for
// k = 0,1,… derives P_k = B_spend + t_k·G and matches it against the block's
// outputs. The scan key never leaves the device.
//
// The first half here (input pubkey extraction + tweak) is what the indexer
// computes from raw blocks; the second half (scan, output key, key derivation,
// address) is what the wallet uses. They share one implementation so the math
// is validated once, against the official BIP-352 vectors.
// ===========================================================================

const numTo32 = (x) => hexToBytes(x.toString(16).padStart(64, '0'));

// secp256k1 NUMS point H (BIP-341): a taproot input whose script-path reveals
// this as the internal key is provably unspendable and NOT an eligible input.
const NUMS_H = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

// Parse a serialized witness (hex): compact-size item count, then each item as
// compact-size length + bytes.
function parseWitness(hex) {
  if (!hex) return [];
  const b = hexToBytes(hex);
  let o = 0;
  const rd = () => {
    let n = b[o++];
    if (n === 0xfd) { n = b[o] | (b[o + 1] << 8); o += 2; }
    else if (n === 0xfe) { n = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000); o += 4; }
    return n;
  };
  const count = rd();
  const items = [];
  for (let i = 0; i < count; i++) { const len = rd(); items.push(b.slice(o, o + len)); o += len; }
  return items;
}

// Witness stack items as byte arrays. Accepts either a serialized witness (hex
// string, as in the BIP-352 vectors) or an array of hex stack items (as Core's
// getblock RPC returns in txinwitness).
function witnessItems(witness) {
  if (Array.isArray(witness)) return witness.map(hexToBytes);
  return parseWitness(witness);
}

// Pull the data pushes out of a scriptSig (hex) — enough to recover the pubkey
// from P2PKH or the redeemScript from P2SH (push opcodes only).
function scriptPushes(hex) {
  if (!hex) return [];
  const b = hexToBytes(hex);
  let o = 0;
  const pushes = [];
  while (o < b.length) {
    const op = b[o++];
    let len = -1;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) len = b[o++];
    else if (op === 0x4d) { len = b[o] | (b[o + 1] << 8); o += 2; }
    else if (op === 0x4e) { len = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000); o += 4; }
    else continue; // non-push opcode
    if (len < 0 || o + len > b.length) break;
    pushes.push(b.slice(o, o + len)); o += len;
  }
  return pushes;
}

// Only compressed pubkeys are eligible — uncompressed-key inputs are skipped.
const looksLikePubKey = (b) => !!b && b.length === 33 && (b[0] === 0x02 || b[0] === 0x03);

// Recover the BIP-352-eligible input public key (33-byte compressed) from a tx
// input, or null if the input type isn't eligible. Handles P2PKH, P2WPKH,
// P2SH-P2WPKH and P2TR (key-path) inputs.
export function inputPubKey({ scriptSig = '', witness = '', scriptPubKey = '' }) {
  try {
    const spk = hexToBytes(scriptPubKey);
    // P2TR: OP_1 PUSH32 <x-only>
    if (spk.length === 34 && spk[0] === 0x51 && spk[1] === 0x20) {
      let w = witnessItems(witness);
      if (w.length > 1 && w[w.length - 1][0] === 0x50) w = w.slice(0, -1); // strip annex
      if (w.length > 1 && bytesToHex(w[w.length - 1].slice(1, 33)) === NUMS_H) return null; // NUMS script-path
      return Point.fromHex(concatBytes(Uint8Array.of(0x02), spk.slice(2, 34))).toRawBytes(true); // even-Y lift
    }
    // P2WPKH: OP_0 PUSH20
    if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14) {
      const w = witnessItems(witness);
      const pk = w[w.length - 1];
      return looksLikePubKey(pk) ? Point.fromHex(pk).toRawBytes(true) : null;
    }
    // P2SH-P2WPKH: scriptSig pushes redeemScript 0014<20>; witness = [sig, pubkey]
    if (spk.length === 23 && spk[0] === 0xa9 && spk[1] === 0x14 && spk[22] === 0x87) {
      const rs = scriptPushes(scriptSig)[0];
      if (!rs || rs.length !== 22 || rs[0] !== 0x00 || rs[1] !== 0x14) return null;
      const w = witnessItems(witness);
      const pk = w[w.length - 1];
      return looksLikePubKey(pk) ? Point.fromHex(pk).toRawBytes(true) : null;
    }
    // P2PKH: OP_DUP OP_HASH160 PUSH20 <hash> ... — the eligible pubkey is the
    // scriptSig push whose hash160 matches <hash> (handles malleated scriptSigs).
    if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14) {
      const target = bytesToHex(spk.slice(3, 23));
      const pushes = scriptPushes(scriptSig);
      for (let i = pushes.length - 1; i >= 0; i--) {
        const pk = pushes[i];
        if (looksLikePubKey(pk) && bytesToHex(hash160(pk)) === target) return Point.fromHex(pk).toRawBytes(true);
      }
      return null;
    }
  } catch {}
  return null;
}

// The oracle tweak for a transaction: 33-byte point input_hash·A, where A is the
// sum of the eligible input pubkeys and input_hash = H_BIP0352/Inputs(outpoint_L
// || A) with outpoint_L the smallest outpoint among ALL the tx's inputs.
//   inputs: [{ txid (display hex), vout, pubkey? (Uint8Array 33) }] — every input
//           of the tx; `pubkey` present only for BIP-352-eligible inputs.
// Returns null if the tx has no eligible inputs (so it can't be a silent payment).
export function silentPaymentTweak(inputs) {
  let A = null;
  for (const i of inputs) if (i.pubkey) A = A ? A.add(Point.fromHex(i.pubkey)) : Point.fromHex(i.pubkey);
  if (!A) return null;
  let Abytes;
  try { Abytes = A.toRawBytes(true); } catch { return null; } // A is the point at infinity → not a silent payment
  let smallest = null;
  for (const i of inputs) {
    const op = concatBytes(hexToBytes(i.txid).reverse(), le32(i.vout));
    if (!smallest || bytesToHex(op) < bytesToHex(smallest)) smallest = op;
  }
  const inputHash = modN(toInt(tagged('BIP0352/Inputs', concatBytes(smallest, Abytes))));
  return A.multiply(inputHash).toRawBytes(true);
}

// Scan a transaction's taproot outputs for payments to us.
//   scanPriv: Uint8Array(32)  our scan private key (b_scan)
//   spendPub: Uint8Array(33)  our spend public key (B_spend)
//   tweak:    Uint8Array(33)  the oracle tweak for this tx (input_hash·A)
//   outputs:  array of 32-byte x-only output pubkeys (hex) in the tx
// Returns the matched outputs: [{ output (x-only hex), k, tweak (t_k hex 32) }];
// `tweak` (t_k) is added to the spend private key to spend the coin.
export function silentPaymentScan({ scanPriv, spendPub, tweak, outputs, maxK = 30 }) {
  const ecdh = Point.fromHex(tweak).multiply(modN(toInt(scanPriv))).toRawBytes(true);
  const B = Point.fromHex(spendPub);
  const remaining = new Set(outputs.map((o) => o.toLowerCase()));
  const found = [];
  for (let k = 0; k < maxK && remaining.size; k++) {
    const tk = modN(toInt(tagged('BIP0352/SharedSecret', concatBytes(ecdh, be32(k)))));
    const xonly = bytesToHex(B.add(G.multiply(tk)).toRawBytes(true).slice(1));
    if (!remaining.has(xonly)) break; // no output at this k → done with this tx
    found.push({ output: xonly, k, tweak: bytesToHex(numTo32(tk)) });
    remaining.delete(xonly);
  }
  return found;
}

// Spend private key for a found SP output: d = (spend_priv + t_k) mod n. Used as
// the taproot key-path key (the signer negates for odd-Y per BIP-340).
export function silentPaymentOutputPrivKey(spendPriv, tweakK) {
  return numTo32(modN(toInt(spendPriv) + toInt(tweakK)));
}

// Derive the BIP-352 scan + spend keys from a BIP32 master node.
//   spend: m/352'/coin'/account'/0'/0   scan: m/352'/coin'/account'/1'/0
export function deriveSilentPaymentKeys(master, coin, account = 0) {
  const spend = master.derive(`m/352'/${coin}'/${account}'/0'/0`);
  const scan = master.derive(`m/352'/${coin}'/${account}'/1'/0`);
  return {
    scanPriv: scan.privateKey, scanPub: scan.publicKey,
    spendPriv: spend.privateKey, spendPub: spend.publicKey,
  };
}

// Encode an sp1…/tsp1… address from scan + spend public keys (33 bytes each).
export function encodeSilentPaymentAddress(scanPub, spendPub, { testnet = false } = {}) {
  const hrp = testnet ? 'tsp' : 'sp';
  const words = [0, ...bech32m.toWords(concatBytes(scanPub, spendPub))];
  return bech32m.encode(hrp, words, 1023);
}
