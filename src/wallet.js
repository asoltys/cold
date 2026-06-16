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
import { sha256 } from '@noble/hashes/sha256';
import * as btc from '@scure/btc-signer';
import { p2wpkh } from '@scure/btc-signer/payment';

import { Api, pool, wsUrl } from './api.js';
import { NostrSync } from './nostr.js';

// No look-ahead: stop scanning a chain at the first unused address. This wallet
// only ever exposes ONE unused address at a time (freshReceive = first unused;
// there is no "generate another address" button), so used addresses stay
// contiguous and there is never a gap to look past. Keeps scans tiny.
const GAP_LIMIT = 1;

// Extra pause after finding a used address, before querying the next index —
// keeps us gentle on the explorers' rate limits when a wallet has activity.
const USED_HIT_DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.confirmed = 0;
    this.pending = 0;

    this.scanning = false;
    this.loaded = false; // true once a scan/snapshot has populated balances once
    this._refreshing = false; // a scan/refresh is in flight
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
    this._pollTimer = null;
    this._deepTimer = null; // periodic full-scan safety net
    this._polling = false; // a light poll is in flight
    this._hbTimer = null; // heartbeat / liveness watchdog
    this._lastMsg = 0; // time of last WS message (incl. pong)
    this._wakeHooked = false;

    // Encrypted cross-device state sync over Nostr.
    this.nostr = new NostrSync();
    this._savedAt = 0;
    this._nostrPubTimer = null;

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
    this._savedAt = 0;
    try {
      if (this.mnemonic) this.nostr.load(this.mnemonic, this.passphrase);
      else this.nostr.unload();
    } catch {}
    this.reset();
  }

  reset() {
    this.receive = [];
    this.change = [];
    this.addrMap = new Map();
    this.utxos = [];
    this.txs = [];
    this.confirmed = 0;
    this.pending = 0;
    this.loaded = false;
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
  // Query one address at a time; stop at the first unused one (no look-ahead).
  async scanChain(chain) {
    const found = [];
    let gap = 0;
    let i = 0;
    while (gap < GAP_LIMIT) {
      const { address } = this.derive(chain, i);
      const info = await this.api.addressInfo(address);
      const cs = info.chain_stats || {};
      const ms = info.mempool_stats || {};
      const used = (cs.tx_count || 0) > 0 || (ms.tx_count || 0) > 0;
      // Balance straight from chain_stats — no need to fetch /utxo just to total.
      const confirmed = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
      const pending = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
      found.push({ chain, index: i, address, used, confirmed, pending });
      this.addrMap.set(address, { chain, index: i });
      if (used) {
        gap = 0;
        await sleep(USED_HIT_DELAY_MS); // slow down before fetching the next one
      } else {
        gap += 1;
      }
      i++;
    }
    return found;
  }

  // A short signature of the user-visible state, so background ("silent")
  // refreshes only re-render when something actually changed.
  _sig() {
    return JSON.stringify({
      bc: this.confirmed,
      bp: this.pending,
      u: this.utxos.map((u) => `${u.txid}:${u.vout}:${u.value}:${u.confirmed ? 1 : 0}`),
      t: this.txs.map((t) => `${t.txid}:${t.confirmed ? 1 : 0}`),
      r: this.nextReceiveIndex,
      c: this.nextChangeIndex,
    });
  }

  _addrInfo(chain, index) {
    const arr = chain === 0 ? this.receive : this.change;
    return arr.find((a) => a.index === index);
  }

  // Light poll: only check the fresh frontier — the next receive and change
  // address — for new activity. Already-scanned addresses are never re-polled;
  // changes to them (spends) arrive over the WebSocket while connected, and a
  // manual rescan covers anything missed (e.g. address reuse). If the frontier
  // moved, escalate to a full scan once to reconcile.
  async refreshLive() {
    if (this.offline || this._refreshing || this._polling) return;
    this._polling = true;
    let changed = false;
    try {
      const fresh = []; // frontier addresses found to be active this pass
      for (const chain of [0, 1]) {
        let idx = chain === 0 ? this.nextReceiveIndex : this.nextChangeIndex;
        // Walk forward from the frontier while addresses are used; stop at the
        // first unused one. Never revisits already-passed (cached) addresses.
        for (let guard = 0; guard < 100; guard++) {
          const { address } = this.derive(chain, idx);
          const info = await this.api.addressInfo(address);
          const cs = info.chain_stats || {};
          const ms = info.mempool_stats || {};
          const used = (cs.tx_count || 0) > 0 || (ms.tx_count || 0) > 0;
          const confirmed = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
          const pending = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);

          const arr = chain === 0 ? this.receive : this.change;
          let entry = arr.find((a) => a.index === idx);
          if (!entry) {
            entry = { chain, index: idx, address };
            arr.push(entry);
            this.addrMap.set(address, { chain, index: idx });
          }
          if (entry.used !== used || entry.confirmed !== confirmed || entry.pending !== pending) {
            changed = true;
            if (used) fresh.push({ chain, index: idx, address });
          }
          entry.used = used;
          entry.confirmed = confirmed;
          entry.pending = pending;

          if (!used) break; // frontier still fresh — done with this chain
          idx++;
        }
        if (chain === 0) this.nextReceiveIndex = idx;
        else this.nextChangeIndex = idx;
      }

      // Fetch coins + history for ONLY the newly-active frontier addresses.
      for (const a of fresh) {
        const us = await this.api.addressUtxos(a.address);
        this.utxos = this.utxos.filter((u) => u.address !== a.address);
        for (const u of us) {
          this.utxos.push({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            address: a.address,
            chain: a.chain,
            index: a.index,
            confirmed: !!u.status.confirmed,
          });
        }
        const list = await this.api.addressTxs(a.address);
        for (const tx of list) {
          if (!this.txs.some((t) => t.txid === tx.txid)) this.txs.push(this._txSummary(tx));
        }
      }

      if (changed) {
        this.utxos.sort((x, y) => y.value - x.value);
        this._sortTxs();
        this._recomputeBalanceFromChains();
        this.loaded = true;
        this.saveCache();
        this.emit();
      }
    } catch {
      /* transient; next poll/ws retries */
    } finally {
      this._polling = false;
    }
  }

  // silent=false: foreground load (shows loading state, always re-renders).
  // silent=true:  background refresh (poll / WS) — no spinner, and only emits
  //               if the visible state changed, so it never disrupts typing.
  async scan({ silent = false } = {}) {
    if (this.offline || this._refreshing) return;
    this._refreshing = true;
    const before = silent ? this._sig() : null;
    if (!silent) {
      this.scanning = true;
      this.emit();
    }
    try {
      const prevBal = `${this.confirmed}|${this.pending}|${this.nextReceiveIndex}|${this.nextChangeIndex}`;
      this.addrMap = new Map();
      this.receive = await this.scanChain(0);
      this.change = await this.scanChain(1);
      this.nextReceiveIndex = firstUnused(this.receive);
      this.nextChangeIndex = firstUnused(this.change);
      this._recomputeBalanceFromChains();

      // Only pull /utxo and /txs (the heavy part) on first load or when the
      // balance/addresses actually changed. Idle polls stay /address-only.
      const balanceChanged =
        `${this.confirmed}|${this.pending}|${this.nextReceiveIndex}|${this.nextChangeIndex}` !== prevBal;
      if (!silent || balanceChanged || !this.loaded) {
        if (!silent || !this.feeRates) this.feeRates = await this.api.feeRates();
        await this.refreshUtxos();
        await this.refreshHistory();
      }
      this.loaded = true;
      this.saveCache();
    } finally {
      this._refreshing = false;
      if (!silent) {
        this.scanning = false;
        this.emit();
      } else if (this._sig() !== before) {
        this.emit();
      }
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

  // Summarize a raw esplora tx into our history shape (net to us, fee, status).
  _txSummary(tx) {
    const mine = new Set(this.addrMap.keys());
    let received = 0;
    let sent = 0;
    for (const vin of tx.vin || []) {
      const a = vin.prevout && vin.prevout.scriptpubkey_address;
      if (a && mine.has(a)) sent += vin.prevout.value;
    }
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address && mine.has(vout.scriptpubkey_address)) received += vout.value;
    }
    return {
      txid: tx.txid,
      net: received - sent, // >0 incoming, <0 outgoing
      fee: tx.fee || 0,
      confirmed: !!(tx.status && tx.status.confirmed),
      blockTime: (tx.status && tx.status.block_time) || 0,
      blockHeight: (tx.status && tx.status.block_height) || 0,
    };
  }

  _sortTxs() {
    this.txs.sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1; // pending first
      return (b.blockTime || 0) - (a.blockTime || 0);
    });
  }

  async refreshHistory() {
    const used = this.usedAddresses();
    const lists = await pool(used, (a) => this.api.addressTxs(a.address));
    const byId = new Map();
    for (const list of lists) {
      for (const tx of list) {
        if (!byId.has(tx.txid)) byId.set(tx.txid, this._txSummary(tx));
      }
    }
    this.txs = [...byId.values()];
    this._sortTxs();
  }

  // --- balances -----------------------------------------------------------
  // confirmed/pending are plain fields, set from chain_stats during scan (and
  // from UTXOs when restoring an offline snapshot). total is derived.
  get total() {
    return this.confirmed + this.pending;
  }

  _recomputeBalanceFromChains() {
    let c = 0;
    let p = 0;
    for (const a of [...this.receive, ...this.change]) {
      c += a.confirmed || 0;
      p += a.pending || 0;
    }
    this.confirmed = c;
    this.pending = p;
  }

  _recomputeBalanceFromUtxos() {
    this.confirmed = this.utxos.reduce((s, u) => s + (u.confirmed ? u.value : 0), 0);
    this.pending = this.utxos.reduce((s, u) => s + (u.confirmed ? 0 : u.value), 0);
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
    return wsUrl(this.netName);
  }

  // Only the fresh frontier needs realtime watching: the next receive address
  // (incoming deposits) and the next change address (our change landing). Coin
  // spends are handled by the post-send refresh and cross-device Nostr sync, so
  // we don't track coin addresses — which also stays under the relay's 10-addr
  // per-connection limit.
  watchedAddresses() {
    return [
      this.derive(0, this.nextReceiveIndex).address,
      this.derive(1, this.nextChangeIndex).address,
    ];
  }

  startRealtime() {
    if (this.offline) return;
    this.stopRealtime();
    // Safety-net poll: only the fresh frontier (next receive/change address),
    // in case the WebSocket misses a deposit. Already-scanned addresses are
    // never re-polled. No periodic full scan — use the manual Rescan for that.
    this._pollTimer = setInterval(() => this.refreshLive(), 20000);
    if (typeof WebSocket === 'undefined') return;
    this._wsWant = true;

    // Heartbeat: ping every 15s; if no message (incl. pong) for 45s the socket
    // is half-open (died without firing onclose) — force a reconnect.
    this._hbTimer = setInterval(() => {
      if (this.offline || !this._ws || this._ws.readyState !== 1) return;
      if (Date.now() - this._lastMsg > 45000) {
        this._reconnectNow();
      } else {
        try {
          this._ws.send(JSON.stringify({ action: 'ping' }));
        } catch {}
      }
    }, 15000);

    // Reconnect + refresh when the tab refocuses or the network returns.
    if (!this._wakeHooked && typeof document !== 'undefined') {
      this._wakeHooked = true;
      const wake = () => {
        if (this.offline || !this._wsWant) return;
        if (!this._ws || this._ws.readyState !== 1) this._reconnectNow();
        this.scan({ silent: true }).catch(() => {});
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') wake();
      });
      window.addEventListener('online', wake);
    }

    this._connectWs();
  }

  _reconnectNow() {
    clearTimeout(this._wsRetry);
    if (this._ws) {
      try {
        this._ws.onclose = null;
        this._ws.close();
      } catch {}
      this._ws = null;
    }
    this.live = false;
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
      this._lastMsg = Date.now();
      this.retrack();
      this.emit();
    };
    ws.onmessage = (ev) => {
      this._lastMsg = Date.now();
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
        // Update instantly from the pushed tx data, then reconcile via a scan.
        this._ingestWs(msg);
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

  // Optimistically apply transactions from a WS push so an incoming deposit
  // shows the instant mempool.space pushes it — no extra round-trip. The
  // debounced scan that follows reconciles everything (spends, confirmations).
  _ingestWs(msg) {
    const txs = [];
    const multi = msg['multi-address-transactions'];
    if (multi && typeof multi === 'object') {
      for (const addr of Object.keys(multi)) {
        const g = multi[addr] || {};
        for (const t of g.mempool || []) txs.push(t);
        for (const t of g.confirmed || []) txs.push(t);
      }
    }
    const single = msg['address-transactions'];
    if (Array.isArray(single)) txs.push(...single);

    let changed = false;
    const have = new Set(this.utxos.map(utxoId));
    for (const tx of txs) {
      if (!tx || !Array.isArray(tx.vout)) continue;
      tx.vout.forEach((vo, i) => {
        const a = vo && vo.scriptpubkey_address;
        if (!a || !this.addrMap.has(a)) return;
        const id = `${tx.txid}:${i}`;
        if (have.has(id)) return;
        const p = this.addrMap.get(a);
        const confirmed = !!(tx.status && tx.status.confirmed);
        this.utxos.push({ txid: tx.txid, vout: i, value: vo.value, address: a, chain: p.chain, index: p.index, confirmed });
        have.add(id);
        if (confirmed) this.confirmed += vo.value;
        else this.pending += vo.value;
        changed = true;
      });
    }
    if (changed) this.emit();
    return changed;
  }

  _scheduleReconnect() {
    if (!this._wsWant) return;
    clearTimeout(this._wsRetry);
    this._wsRetry = setTimeout(() => this._connectWs(), 4000);
  }

  // Debounced: a payment may touch several of our addresses in one go.
  // Reconcile incrementally (frontier only) — never re-scans old coins.
  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(async () => {
      try {
        await this.refreshLive();
        this.retrack();
      } catch {}
    }, 400);
  }

  stopRealtime() {
    this._wsWant = false;
    this.live = false;
    clearTimeout(this._wsRetry);
    clearTimeout(this._refreshTimer);
    clearInterval(this._pollTimer);
    clearInterval(this._deepTimer);
    clearInterval(this._hbTimer);
    clearTimeout(this._nostrPubTimer);
    if (this._ws) {
      try {
        this._ws.onclose = null;
        this._ws.close();
      } catch {}
      this._ws = null;
    }
  }

  // --- local history cache ------------------------------------------------
  // Cache the scanned state in localStorage, keyed by a hash of the seed (the
  // seed itself is never stored). Re-importing the same seed in this browser
  // then shows the last-known balance/history instantly while a fresh scan
  // runs in the background.
  _cacheKey() {
    const bytes = new TextEncoder().encode(`${this.mnemonic}\n${this.passphrase}`);
    return 'btc-wallet-cache:' + hex.encode(sha256(bytes)).slice(0, 32);
  }

  // The serializable wallet state, shared by the localStorage cache and the
  // Nostr sync. savedAt lets us pick the newest copy across devices.
  _snapshot() {
    return {
      v: 1,
      savedAt: Date.now(),
      receive: this.receive,
      change: this.change,
      utxos: this.utxos,
      txs: this.txs,
      nextReceiveIndex: this.nextReceiveIndex,
      nextChangeIndex: this.nextChangeIndex,
      feeRates: this.feeRates,
    };
  }

  _applySnapshot(d) {
    this.receive = d.receive || [];
    this.change = d.change || [];
    this.utxos = d.utxos || [];
    this.txs = d.txs || [];
    this.nextReceiveIndex = d.nextReceiveIndex || 0;
    this.nextChangeIndex = d.nextChangeIndex || 0;
    this.feeRates = d.feeRates || this.feeRates;
    this.addrMap = new Map();
    for (const a of [...this.receive, ...this.change]) {
      this.addrMap.set(a.address, { chain: a.chain, index: a.index });
    }
    this._recomputeBalanceFromChains();
    this._savedAt = d.savedAt || 0;
    this.loaded = true;
  }

  saveCache() {
    const snap = this._snapshot();
    this._savedAt = snap.savedAt;
    try {
      localStorage.setItem(this._cacheKey(), JSON.stringify(snap));
    } catch {}
    // Push to Nostr too (debounced), so other devices get the update.
    if (!this.offline) {
      clearTimeout(this._nostrPubTimer);
      this._nostrPubTimer = setTimeout(() => this.nostr.publish(snap), 2500);
    }
  }

  restoreCache() {
    try {
      const raw = localStorage.getItem(this._cacheKey());
      if (!raw) return false;
      this._applySnapshot(JSON.parse(raw));
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  // Pull the latest state from Nostr; apply it if it's newer than what we have.
  // Returns true if state was applied (so the caller can skip a full scan).
  async syncFromNostr() {
    if (this.offline) return false;
    let remote;
    try {
      remote = await this.nostr.fetch();
    } catch {
      return false;
    }
    if (!remote) return false;
    if ((remote.savedAt || 0) > (this._savedAt || 0)) {
      this._applySnapshot(remote);
      this.saveCache(); // mirror into localStorage
      this.emit();
      return true;
    }
    // Our local copy is newer (or equal) — push it up so the relay catches up.
    if ((this._savedAt || 0) > (remote.savedAt || 0)) this.saveCache();
    return true; // remote existed, so no full scan needed
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
    this._recomputeBalanceFromUtxos();
    this.loaded = true;
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
