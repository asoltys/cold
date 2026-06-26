// Silent Payments (BIP-352).
//
// A silent payment address (sp1…) is a static, reusable address the receiver
// publishes once. The sender derives a unique one-time taproot output for each
// payment from the receiver's address plus the sender's own input keys (ECDH),
// so there's no on-chain link between payments and no address reuse — without
// any interaction with the receiver.
//
// ── Send ─────────────────────────────────────────────────────────────────
// Spend P2WPKH inputs → derive one-time taproot outputs for sp1…/tsp1…
// addresses.  Validated against the official BIP-352 send test vectors.
//
// ── Receive ──────────────────────────────────────────────────────────────
// Derive scan+spend keypairs from a BIP-352 path (m/352'/coin'/0'/{0,1}/0),
// generate the sp1… address, and detect incoming payments by scanning blocks
// or individual transactions with the Esplora API.
//
// Both sides handle only P2WPKH (compressed) inputs for now.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';
import { HDKey } from '@scure/bip32';

const Point = secp256k1.ProjectivePoint;
const G = Point.BASE;
const N = secp256k1.CURVE.n;

const modN = (x) => ((x % N) + N) % N;
const toInt = (bytes) => BigInt('0x' + bytesToHex(bytes));
const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const be32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; };

const tagged = (tag, msg) => {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
};

const taprootScript = (xonly) => concatBytes(Uint8Array.of(0x51, 0x20), xonly);

// ── Address encoding ─────────────────────────────────────────────────────

export function isSilentPaymentAddress(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.toLowerCase();
  if (!a.startsWith('sp1') && !a.startsWith('tsp1')) return false;
  try { decodeSilentPaymentAddress(addr); return true; }
  catch { return false; }
}

export function decodeSilentPaymentAddress(addr) {
  const { prefix, words } = bech32m.decode(addr.toLowerCase(), 1023);
  if (prefix !== 'sp' && prefix !== 'tsp') throw new Error('Not a silent payment address.');
  if (words[0] !== 0) throw new Error('Unsupported silent payment version.');
  const data = bech32m.fromWords(words.slice(1));
  if (data.length !== 66) throw new Error('Malformed silent payment address.');
  return { scan: data.slice(0, 33), spend: data.slice(33, 66), testnet: prefix === 'tsp' };
}

// Encode two 33-byte compressed pubkeys as a sp1…/tsp1… address.
export function encodeSilentPaymentAddress(scanPubKey, spendPubKey, testnet) {
  const prefix = testnet ? 'tsp' : 'sp';
  const words = bech32m.toWords(concatBytes(scanPubKey, spendPubKey));
  return bech32m.encode(prefix, [0, ...words], 1023);
}

// ── Key derivation (BIP-352) ─────────────────────────────────────────────
// BIP-352 doesn't specify a finalized derivation path, but the convention used
// here follows the reference implementation:
//   scan  key: m/352'/<coin>'/0'/0/0
//   spend key: m/352'/<coin>'/0'/1/0

export function deriveSilentPaymentKeys(seed, coin = 0) {
  const master = HDKey.fromMasterSeed(seed);
  const path = `m/352'/${coin}'/0'`;
  const acct = master.derive(path);
  const scanNode  = acct.deriveChild(0).deriveChild(0);
  const spendNode = acct.deriveChild(1).deriveChild(0);
  if (!scanNode.privateKey || !spendNode.privateKey) throw new Error('SP key derivation failed (watch-only).');
  return {
    scanPrivateKey:  scanNode.privateKey,
    scanPublicKey:   scanNode.publicKey,
    spendPrivateKey: spendNode.privateKey,
    spendPublicKey:  spendNode.publicKey,
  };
}

// Generate the wallet's silent payment address.
export function walletSilentPaymentAddress(seed, coin = 0, testnet = false) {
  const keys = deriveSilentPaymentKeys(seed, coin);
  return encodeSilentPaymentAddress(keys.scanPublicKey, keys.spendPublicKey, testnet);
}

// ── Sending ──────────────────────────────────────────────────────────────

export function silentPaymentPlaceholder(index) {
  return taprootScript(sha256(concatBytes(new TextEncoder().encode('halsp-placeholder'), be32(index))));
}

export function silentPaymentScripts(inputs, outputs) {
  if (!inputs.length) throw new Error('Silent payment needs at least one input.');

  let a = 0n;
  for (const i of inputs) a = modN(a + toInt(i.priv));
  if (a === 0n) throw new Error('Silent payment input key sum is zero.');
  const A = G.multiply(a);

  let smallest = null;
  for (const i of inputs) {
    const op = concatBytes(hexToBytes(i.txid).reverse(), le32(i.vout));
    if (!smallest || bytesToHex(op) < bytesToHex(smallest)) smallest = op;
  }
  const inputHash = modN(toInt(tagged('BIP0352/Inputs', concatBytes(smallest, A.toRawBytes(true)))));

  const counters = new Map();
  return outputs.map(({ scan, spend }) => {
    const rkey = bytesToHex(scan) + bytesToHex(spend);
    const k = counters.get(rkey) || 0;
    counters.set(rkey, k + 1);
    const ecdh = Point.fromHex(scan).multiply(modN(inputHash * a)).toRawBytes(true);
    const tk = modN(toInt(tagged('BIP0352/SharedSecret', concatBytes(ecdh, be32(k)))));
    const Pout = Point.fromHex(spend).add(G.multiply(tk));
    return taprootScript(Pout.toRawBytes(true).slice(1));
  });
}

// ── Receiving (detection) ────────────────────────────────────────────────

// Extract the compressed public key from a P2WPKH input's witness data.
// The Esplora tx JSON witness field is an array of hex strings.
// For P2WPKH: [signature (71-73 bytes), pubkey (33 bytes)]
function pubkeyFromWitness(witness) {
  if (!witness || witness.length < 2) return null;
  const pk = hexToBytes(witness[1]);
  if (pk.length === 33 && (pk[0] === 0x02 || pk[0] === 0x03)) return pk;
  return null;
}

// Check whether a single transaction contains a silent-payment output intended
// for the holder of scanPrivateKey / spendPublicKey.
//   tx    — Esplora JSON transaction object
//   a     — scan private key as BigInt
//   Bspend — spend public key as secp256k1 Point
// Returns the outpoint info of matched outputs, or empty array.
export function detectSilentPaymentInTx(tx, a, Bspend) {
  // Only consider transactions with taproot outputs (starts with 0x5120).
  const taprootOuts = [];
  for (let vout = 0; vout < (tx.vout || []).length; vout++) {
    const out = tx.vout[vout];
    if (out.scriptpubkey && out.scriptpubkey.startsWith('5120')) {
      taprootOuts.push({ vout, script: out.scriptpubkey, value: out.value });
    }
  }
  if (!taprootOuts.length) return [];

  // Sum input pubkeys → A
  const inputs = tx.vin || [];
  let A = null;
  for (const inp of inputs) {
    const pk = pubkeyFromWitness(inp.witness);
    if (!pk) return []; // can't compute A without all pubkeys
    const P = Point.fromHex(pk);
    A = A ? A.add(P) : P;
  }
  if (!A) return [];

  // Smallest outpoint (wire-order txid reversed + LE vout)
  let smallest = null;
  for (const inp of inputs) {
    const op = concatBytes(hexToBytes(inp.txid).reverse(), le32(inp.vout));
    if (!smallest || bytesToHex(op) < bytesToHex(smallest)) smallest = op;
  }
  if (!smallest) return [];

  const inputHash = modN(toInt(tagged('BIP0352/Inputs', concatBytes(smallest, A.toRawBytes(true)))));
  const ecdh = A.multiply(modN(inputHash * a)).toRawBytes(true);

  const hits = [];
  for (let k = 0; k < taprootOuts.length; k++) {
    const out = taprootOuts[k];
    const tk = modN(toInt(tagged('BIP0352/SharedSecret', concatBytes(ecdh, be32(k)))));
    const expected = Bspend.add(G.multiply(tk));
    const expectedXonly = bytesToHex(expected.toRawBytes(true).slice(1));
    // The taproot script is OP_1 (51) PUSH32 (20) <32-byte x-only key>.
    const actualXonly = out.script.slice(4); // skip "5120"
    if (expectedXonly === actualXonly) {
      hits.push({ txid: tx.txid, vout: out.vout, value: out.value, tweak: tk });
    }
  }
  return hits;
}

// Parse a private key (Uint8Array 32) into a BigInt.
export function privKeyToBigInt(priv) {
  return toInt(priv);
}

// Compute the spend private key for a detected silent payment UTXO:
//   spendPrivKey + tweak  (mod N)
export function spendPrivKeyFor(priv, tweak) {
  return modN(toInt(priv) + tweak);
}

// Derive the taproot address for a detected silent payment output (for display).
export function silentPaymentOutputAddress(spendPubKey, tweak, net) {
  const Pout = Point.fromHex(spendPubKey).add(G.multiply(tweak));
  const xonly = Pout.toRawBytes(true).slice(1);
  return taprootScript(xonly);
}
