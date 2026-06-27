// Verify the regtest electrum-ws bridge gives realtime push: subscribe to an
// address scripthash over ws://localhost:50003, fund it, expect a notification.
// Run (stack + ews up): bun tools/electrum-ws.test.js
import { $ } from 'bun';
import { p2wpkh } from '@scure/btc-signer/payment';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const REGTEST = { ...btc.TEST_NETWORK, bech32: 'bcrt' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bcli = (...a) => $`docker exec bc bitcoin-cli -regtest -rpcuser=admin1 -rpcpassword=123 ${a}`.text();

const pub = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
const pay = p2wpkh(pub, REGTEST);
const sh = sha256(pay.script).reverse();            // electrum scripthash (reversed)
const shHex = bytesToHex(sh);
console.log('address', pay.address, '\nscripthash', shHex);

const ws = new WebSocket('ws://localhost:50003');
let gotInitial = false, gotPush = false;
ws.onmessage = (ev) => {
  for (const line of String(ev.data).split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2) { gotInitial = true; console.log('subscribe ok (initial status:', m.result, ')'); }
    if (m.method === 'blockchain.scripthash.subscribe') { gotPush = true; console.log('PUSH notification received:', JSON.stringify(m.params)); }
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.send(JSON.stringify({ id: 1, method: 'server.version', params: ['test', '1.4'] }) + '\n');
ws.send(JSON.stringify({ id: 2, method: 'blockchain.scripthash.subscribe', params: [shHex] }) + '\n');

await sleep(1500);
if (!gotInitial) { console.log('FAIL — no subscribe response'); process.exit(1); }

console.log('funding the address…');
await bcli('-rpcwallet=coinos', 'sendtoaddress', pay.address, '0.005');
await bcli('generatetoaddress', '1', (await bcli('-rpcwallet=coinos', 'getnewaddress')).trim());

for (let i = 0; i < 20 && !gotPush; i++) await sleep(500);
console.log(gotPush ? '\nPASS — realtime push delivered over the WS bridge' : '\nFAIL — no push within timeout');
process.exit(gotPush ? 0 : 1);
