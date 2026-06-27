// Verify Hal's swap tapscript/tree construction byte-for-byte against
// boltz-core's published test vectors (boltz-core/src/bitcoin/scripts/*.rs).
// Run: bun tools/swap-vectors.test.js
import {
  submarineClaimLeaf, reverseClaimLeaf, refundLeaf, swapMerkleRoot,
  hexToBytes, bytesToHex,
} from '../src/swap.js';
import { p2tr, taprootListToTree } from '@scure/btc-signer/payment';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n   got:  ${got}\n   want: ${want}`); }
};

// --- swap_tree.rs vector ---
const claimPk = hexToBytes('814fe2b5ce0e3fe5787fade9a4357a743c4ce6de473e5f29daf42112e47db25a');
const refundPk = hexToBytes('0095b23ac89f523cdbcd791d3325ada7ddb30fd6134bb7fff22ba1e00414cb7d');
const ph = hexToBytes('34e64e5b1373a872019ee2c7791cf4264d1079de'); // hash160(preimage)

eq('submarine claim leaf',
  bytesToHex(submarineClaimLeaf(ph, claimPk)),
  'a91434e64e5b1373a872019ee2c7791cf4264d1079de8820814fe2b5ce0e3fe5787fade9a4357a743c4ce6de473e5f29daf42112e47db25aac');

// Cross-check our two-leaf merkle root against @scure's own taproot tree
// builder (BIP341) for the same leaves — proves the TapBranch/sort logic.
const claim = submarineClaimLeaf(ph, claimPk);
const refund = refundLeaf(refundPk, 123);
const scureRoot = bytesToHex(
  p2tr(claimPk, taprootListToTree([{ script: claim }, { script: refund }]), undefined, true).tapMerkleRoot,
);
eq('merkle root matches @scure tree builder', bytesToHex(swapMerkleRoot(claim, refund)), scureRoot);

// --- reverse_tree.rs vector ---
const rClaimPk = hexToBytes('97f2ea5402afd2e90130e84d97e455f67493a956c20faedce32086516ef9f12e');
const rPh = hexToBytes('761de3d1f1f54cc8b3beec0a1ad03820a2e12b90');
eq('reverse claim leaf',
  bytesToHex(reverseClaimLeaf(rPh, rClaimPk)),
  '82012088a914761de3d1f1f54cc8b3beec0a1ad03820a2e12b90882097f2ea5402afd2e90130e84d97e455f67493a956c20faedce32086516ef9f12eac');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
