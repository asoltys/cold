// BIP84 (native segwit, p2wpkh) HD wallet core.
//
// Derivation:  m / 84' / coin' / 0' / chain / index
//   chain 0 = receive (external) addresses
//   chain 1 = change  (internal) addresses
//
// All signing uses witnessUtxo only (script + amount). That is all segwit needs,
// which is what makes offline signing easy: we never have to fetch full previous
// transactions, only the (txid, vout, value, address) of each UTXO.

import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { p2wpkh } from '@scure/btc-signer/payment';

import { Api, pool } from './api.js';

const GAP_LIMIT = 20; // BIP44 standard gap limit

const NETS = {
  mainnet: { net: btc.NETWORK, coin: 0 },
  testnet: { net: btc.TEST_NETWORK, coin: 1 },
};

export function newMnemonic(strengthBits = 128) {
  return generateMnemonic(wordlist, strengthBits);
}

export function isValidMnemonic(m) {
  try {
    return validateMnemonic(m.trim().replace(/\s+/g, ' '), wordlist);
  } catch {
    return false;
  }
}

export class Wallet {
  constructor() {
    this.mnemonic = '';
    this.passphrase = '';
    this.netName = 'mainnet';

    this.api = new Api('mainnet');
    this.offline = false;

    // Scanned chains: arrays of { chain, index, address, used }
    this.receive = [];
    this.change = [];
    this.addrMap = new Map(); // address -> { chain, index }

    this.utxos = []; // { txid, vout, value, address, chain, index, confirmed }
    this.txs = []; // aggregated history
    this.feeRates = null;
    this.price = null;

    this.scanning = false;
    this.nextReceiveIndex = 0;
    this.nextChangeIndex = 0;

    this._account = null;
    this._accountKey = '';
    this._addrCache = new Map();

    // Realtime (mempool.space WebSocket)
    this.live = false;
    this._ws = null;
    this._wsWant = false;
    this._wsRetry = null;
    this._refreshTimer = null;

    this._subs = new Set();
  }

  // --- reactive glue (tiny pub/sub; the UI re-renders on change) ----------
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  emit() {
    for (const fn of this._subs) fn(this);
  }

  // --- setup --------------------------------------------------------------
  load({ mnemonic, passphrase = '', netName = 'mainnet', offline = false }) {
    this.stopRealtime();
    this.mnemonic = mnemonic.trim().replace(/\s+/g, ' ');
    this.passphrase = passphrase;
    this.netName = netName;
    this.offline = offline;
    this.api = new Api(netName);
    this.api.offline = offline;
    this._account = null;
    this._addrCache.clear();
    this.reset();
  }

  reset() {
    this.receive = [];
    this.change = [];
    this.addrMap = new Map();
    this.utxos = [];
    this.txs = [];
    this.nextReceiveIndex = 0;
    this.nextChangeIndex = 0;
  }

  setOffline(off) {
    this.offline = off;
    this.api.offline = off;
    if (off) this.stopRealtime();
    this.emit();
  }

  get netCfg() {
    return NETS[this.netName];
  }

  // --- derivation ---------------------------------------------------------
  account() {
    const key = `${this.netName}|${this.mnemonic}|${this.passphrase}`;
    if (this._account && this._accountKey === key) return this._account;
    const seed = mnemonicToSeedSync(this.mnemonic, this.passphrase);
    const root = HDKey.fromMasterSeed(seed);
    const { coin } = this.netCfg;
    this._account = root.derive(`m/84'/${coin}'/0'`);
    this._accountKey = key;
    this._addrCache.clear();
    return this._account;
  }

  node(chain, index) {
    // Relative derivation from the account node (chain/index are non-hardened).
    return this.account().deriveChild(chain).deriveChild(index);
  }

  // Returns { address, script, pubkey }
  derive(chain, index) {
    const cacheKey = `${chain}/${index}`;
    const hit = this._addrCache.get(cacheKey);
    if (hit) return hit;
    const node = this.node(chain, index);
    const pay = p2wpkh(node.publicKey, this.netCfg.net);
    const info = { address: pay.address, script: pay.script, pubkey: node.publicKey, chain, index };
    this._addrCache.set(cacheKey, info);
    return info;
  }

  // Derive a window of addresses on both chains and (re)build addrMap. Used in
  // offline mode where we cannot scan for usage but still must map a UTXO's
  // address back to its derivation path in order to sign it.
  deriveWindow(count) {
    this.addrMap = new Map();
    for (const chain of [0, 1]) {
      for (let i = 0; i < count; i++) {
        const { address } = this.derive(chain, i);
        this.addrMap.set(address, { chain, index: i });
      }
    }
  }

  // --- online scan --------------------------------------------------------
  async scanChain(chain) {
    const found = [];
    let gap = 0;
    let i = 0;
    while (gap < GAP_LIMIT) {
      const { address } = this.derive(chain, i);
      const info = await this.api.addressInfo(address);
      const used =
        info.chain_stats.tx_count > 0 || info.mempool_stats.tx_count > 0;
      found.push({ chain, index: i, address, used });
      this.addrMap.set(address, { chain, index: i });
      gap = used ? 0 : gap + 1;
      i++;
    }
    return found;
  }

  async scan() {
    if (this.offline) return;
    this.scanning = true;
    this.emit();
    try {
      this.addrMap = new Map();
      [this.receive, this.change] = await Promise.all([
        this.scanChain(0),
        this.scanChain(1),
      ]);
      this.nextReceiveIndex = firstUnused(this.receive);
      this.nextChangeIndex = firstUnused(this.change);

      [this.feeRates, this.price] = await Promise.all([
        this.api.feeRates(),
        this.api.price(),
      ]);

      await this.refreshUtxos();
      await this.refreshHistory();
    } finally {
      this.scanning = false;
      this.emit();
    }
  }

  usedAddresses() {
    return [...this.receive, ...this.change].filter((a) => a.used);
  }

  async refreshUtxos() {
    const used = this.usedAddresses();
    const lists = await pool(used, (a) => this.api.addressUtxos(a.address));
    const utxos = [];
    used.forEach((a, idx) => {
      for (const u of lists[idx]) {
        utxos.push({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: a.address,
          chain: a.chain,
          index: a.index,
          confirmed: !!u.status.confirmed,
        });
      }
    });
    utxos.sort((a, b) => b.value - a.value);
    this.utxos = utxos;
  }

  async refreshHistory() {
    const used = this.usedAddresses();
    const lists = await pool(used, (a) => this.api.addressTxs(a.address));
    const mine = new Set(this.addrMap.keys());
    const byId = new Map();
    for (const list of lists) {
      for (const tx of list) {
        if (byId.has(tx.txid)) continue;
        let received = 0;
        let sent = 0;
        for (const vin of tx.vin) {
          const a = vin.prevout && vin.prevout.scriptpubkey_address;
          if (a && mine.has(a)) sent += vin.prevout.value;
        }
        for (const vout of tx.vout) {
          if (vout.scriptpubkey_address && mine.has(vout.scriptpubkey_address))
            received += vout.value;
        }
        byId.set(tx.txid, {
          txid: tx.txid,
          net: received - sent, // >0 incoming, <0 outgoing
          fee: tx.fee || 0,
          confirmed: !!tx.status.confirmed,
          blockTime: tx.status.block_time || 0,
          blockHeight: tx.status.block_height || 0,
        });
      }
    }
    const txs = [...byId.values()];
    txs.sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1; // pending first
      return (b.blockTime || 0) - (a.blockTime || 0);
    });
    this.txs = txs;
  }

  // --- balances -----------------------------------------------------------
  get confirmed() {
    return this.utxos.reduce((s, u) => s + (u.confirmed ? u.value : 0), 0);
  }
  get pending() {
    return this.utxos.reduce((s, u) => s + (u.confirmed ? 0 : u.value), 0);
  }
  get total() {
    return this.confirmed + this.pending;
  }

  freshReceive() {
    return this.derive(0, this.nextReceiveIndex);
  }
  freshChange() {
    return this.derive(1, this.nextChangeIndex);
  }

  // --- spending -----------------------------------------------------------
  // recipients: [{ address, amount(sats) }]
  // coinIds: optional array of "txid:vout" to force manual coin control.
  // sendMax: drain all selected coins to the single recipient.
  buildTx({ recipients, feeRate, coinIds = null, sendMax = false }) {
    const pool_ = coinIds
      ? this.utxos.filter((u) => coinIds.includes(utxoId(u)))
      : this.utxos.slice();
    if (!pool_.length) throw new Error('No spendable coins selected.');

    const inputs = pool_.map((u) => {
      const { script, pubkey } = this.derive(u.chain, u.index);
      const pay = p2wpkh(pubkey, this.netCfg.net);
      return {
        ...pay,
        txid: u.txid,
        index: u.vout,
        witnessUtxo: { script: pay.script, amount: BigInt(u.value) },
      };
    });

    const changeAddress = this.freshChange().address;
    const feePerByte = BigInt(Math.max(1, Math.round(feeRate)));

    if (sendMax) {
      if (recipients.length !== 1)
        throw new Error('Send-max requires exactly one recipient.');
      // Drain everything: use the recipient as the "change" address with no
      // fixed outputs, so the estimator sends (total − exact fee) to them.
      const dest = recipients[0].address;
      const sel = btc.selectUTXO(inputs, [], 'all', {
        changeAddress: dest,
        feePerByte,
        network: this.netCfg.net,
        createTx: true,
        bip69: true,
      });
      if (!sel || !sel.tx) throw new Error('Fee exceeds balance.');
      return summarize(sel, this.netCfg.net);
    }

    const outputs = recipients.map((r) => ({
      address: r.address,
      amount: BigInt(r.amount),
    }));
    const strategy = coinIds ? 'all' : 'default';
    const sel = btc.selectUTXO(inputs, outputs, strategy, {
      changeAddress,
      feePerByte,
      network: this.netCfg.net,
      createTx: true,
      bip69: true,
    });
    if (!sel || !sel.tx)
      throw new Error('Insufficient funds for amount + fee.');
    return summarize(sel, this.netCfg.net);
  }

  // Sign every input of an already-built Transaction with the matching HD key.
  sign(tx) {
    const byOutpoint = new Map();
    for (const u of this.utxos) byOutpoint.set(utxoId(u), u);
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const id = `${hex.encode(inp.txid)}:${inp.index}`;
      const u = byOutpoint.get(id);
      if (!u) throw new Error(`Cannot find key for input ${id}`);
      const node = this.node(u.chain, u.index);
      tx.signIdx(node.privateKey, i);
    }
    tx.finalize();
    return tx.hex;
  }

  async broadcast(hexTx) {
    return this.api.broadcast(hexTx);
  }

  // --- realtime (mempool.space WebSocket) ---------------------------------
  // Pushes us new mempool/confirmed transactions for our addresses so history
  // and balances update with no polling.
  wsUrl() {
    return this.netName === 'testnet'
      ? 'wss://mempool.space/testnet/api/v1/ws'
      : 'wss://mempool.space/api/v1/ws';
  }

  // Addresses worth watching: those holding coins (to catch spends) plus a
  // window of upcoming fresh receive/change addresses (to catch deposits).
  watchedAddresses() {
    const set = new Set();
    for (const u of this.utxos) set.add(u.address);
    for (let i = 0; i < 10; i++) set.add(this.derive(0, this.nextReceiveIndex + i).address);
    for (let i = 0; i < 5; i++) set.add(this.derive(1, this.nextChangeIndex + i).address);
    return [...set];
  }

  startRealtime() {
    if (this.offline || typeof WebSocket === 'undefined') return;
    this.stopRealtime();
    this._wsWant = true;
    this._connectWs();
  }

  _connectWs() {
    if (!this._wsWant) return;
    let ws;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      this.live = true;
      this.retrack();
      this.emit();
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      // React only to address/block events — never the global tx firehose.
      if (
        msg['multi-address-transactions'] ||
        msg['address-transactions'] ||
        msg['block-transactions'] ||
        msg['txConfirmed']
      ) {
        this._scheduleRefresh();
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
    ws.onclose = () => {
      this.live = false;
      this._ws = null;
      this.emit();
      this._scheduleReconnect();
    };
  }

  retrack() {
    if (this._ws && this._ws.readyState === 1) {
      try {
        this._ws.send(JSON.stringify({ 'track-addresses': this.watchedAddresses() }));
      } catch {}
    }
  }

  _scheduleReconnect() {
    if (!this._wsWant) return;
    clearTimeout(this._wsRetry);
    this._wsRetry = setTimeout(() => this._connectWs(), 4000);
  }

  // Debounced: a payment may touch several of our addresses in one go.
  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(async () => {
      if (this.scanning || this.offline) return;
      try {
        await this.scan();
        this.retrack();
      } catch {}
    }, 1200);
  }

  stopRealtime() {
    this._wsWant = false;
    this.live = false;
    clearTimeout(this._wsRetry);
    clearTimeout(this._refreshTimer);
    if (this._ws) {
      try {
        this._ws.onclose = null;
        this._ws.close();
      } catch {}
      this._ws = null;
    }
  }

  // --- offline snapshot ---------------------------------------------------
  // Exported on the ONLINE device. Contains no secrets — just what an offline
  // signer needs: coins, fee rates, and which addresses are next/fresh.
  exportSnapshot() {
    return {
      app: 'bitcoin-wallet',
      version: 1,
      netName: this.netName,
      exportedAt: new Date().toISOString(),
      feeRates: this.feeRates,
      price: this.price,
      nextReceiveIndex: this.nextReceiveIndex,
      nextChangeIndex: this.nextChangeIndex,
      utxos: this.utxos.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        address: u.address,
        confirmed: u.confirmed,
      })),
    };
  }

  // Imported on the OFFLINE device (which already has the seed loaded).
  importSnapshot(snap) {
    if (!snap || !Array.isArray(snap.utxos))
      throw new Error('Not a valid wallet snapshot file.');
    if (snap.netName && snap.netName !== this.netName)
      throw new Error(
        `Snapshot is for ${snap.netName} but wallet is ${this.netName}.`
      );

    this.feeRates = snap.feeRates || this.feeRates;
    this.price = snap.price || this.price;
    this.nextReceiveIndex = snap.nextReceiveIndex || 0;
    this.nextChangeIndex = snap.nextChangeIndex || 0;

    // Derive a generous window so every UTXO address resolves to a path.
    const maxIdx = snap.utxos.reduce((m, _u) => m, 0);
    const window = Math.max(this.nextReceiveIndex, this.nextChangeIndex, maxIdx) + GAP_LIMIT + 5;
    this.deriveWindow(window);

    const utxos = [];
    const unmatched = [];
    for (const u of snap.utxos) {
      const path = this.addrMap.get(u.address);
      if (!path) {
        unmatched.push(u.address);
        continue;
      }
      utxos.push({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        address: u.address,
        chain: path.chain,
        index: path.index,
        confirmed: !!u.confirmed,
      });
    }
    utxos.sort((a, b) => b.value - a.value);
    this.utxos = utxos;
    this.emit();
    return { imported: utxos.length, unmatched };
  }
}

export function utxoId(u) {
  return `${u.txid}:${u.vout}`;
}

function firstUnused(chain) {
  const u = chain.find((a) => !a.used);
  return u ? u.index : chain.length;
}

function summarize(sel, network) {
  const outputs = sel.tx.outputs.map((o) => ({
    address: btc.Address(network).encode(btc.OutScript.decode(o.script)),
    amount: Number(o.amount),
  }));
  return {
    tx: sel.tx,
    fee: Number(sel.fee),
    hasChange: !!sel.change,
    inputsCount: sel.tx.inputsLength,
    outputs,
    weight: sel.weight,
    vsize: Math.ceil(Number(sel.weight) / 4),
  };
}
