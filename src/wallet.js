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
import { hex, base64urlnopad, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { scrypt } from '@noble/hashes/scrypt';
import { randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';
import * as btc from '@scure/btc-signer';
import { p2wpkh } from '@scure/btc-signer/payment';

import { Api, pool, wsUrl } from './api.js';
import { NostrSync, getSyncConfig } from './nostr.js';

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
    this.historyLoading = false; // history is still being fetched in the background
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
  load({ mnemonic = '', passphrase = '', xpub = '', xprv = '', netName = 'mainnet', offline = false }) {
    this.stopRealtime();
    this.mnemonic = (mnemonic || '').trim().replace(/\s+/g, ' ');
    this.passphrase = passphrase;
    this.xpub = xpub || '';
    this.xprv = xprv || ''; // spending wallet imported from an extended private key
    this.watchOnly = !!this.xpub && !this.mnemonic && !this.xprv; // view/receive only
    this.netName = netName;
    this.offline = offline;
    this.api = new Api(netName);
    this.api.offline = offline;
    this._account = null;
    this._accountKey = null;
    this._addrCache.clear();
    this._reserved = null; // gift coins set aside from spending (lazy-loaded)
    this._reclaimed = null; // gift coins freed for spending but link still live
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

  // Rebuild the Api against the currently-configured explorer, then rescan and
  // reconnect realtime (called when the user switches explorer in Settings).
  async reloadExplorer() {
    this.stopRealtime();
    this.api = new Api(this.netName);
    this.api.offline = this.offline;
    if (this.offline) return;
    try {
      await this.scan();
    } catch {}
    this.startRealtime();
  }

  get netCfg() {
    return NETS[this.netName];
  }

  // --- derivation ---------------------------------------------------------
  account() {
    const { coin } = this.netCfg;
    // Cache key identifies the source so a reload rebuilds when it changes.
    const key = this.watchOnly ? 'pub:' + this.xpub
      : this.xprv ? 'prv:' + this.xprv
      : `${this.netName}|${this.mnemonic}|${this.passphrase}`;
    if (this._account && this._accountKey === key) return this._account;
    let acct;
    if (this.watchOnly) {
      acct = HDKey.fromExtendedKey(this.xpub); // account-level public key
    } else if (this.xprv) {
      // A master xprv (depth 0) needs the BIP84 account path derived from it;
      // an already account-level xprv is used as-is.
      const node = HDKey.fromExtendedKey(this.xprv);
      acct = node.depth === 0 ? node.derive(`m/84'/${coin}'/0'`) : node;
    } else {
      acct = HDKey.fromMasterSeed(mnemonicToSeedSync(this.mnemonic, this.passphrase)).derive(`m/84'/${coin}'/0'`);
    }
    this._account = acct;
    this._accountKey = key;
    this._addrCache.clear();
    return acct;
  }

  // The account-level extended public key (xpub / zpub) for export → watch-only.
  accountXpub() {
    return this.account().publicExtendedKey;
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
      const hasMempool = (ms.tx_count || 0) > 0;
      // Balance straight from chain_stats — no need to fetch /utxo just to total.
      const confirmed = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
      const pending = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
      found.push({ chain, index: i, address, used, confirmed, pending, hasMempool });
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
          const summary = this._txSummary(tx);
          const at = this.txs.findIndex((t) => t.txid === tx.txid);
          // Refresh in place so a tx that has since confirmed loses its pending
          // status — not just append new ones (which left confirmations stale).
          if (at >= 0) this.txs[at] = summary;
          else this.txs.push(summary);
        }
      }

      // Re-verify the addresses that currently hold coins, to catch spends from
      // an already-scanned address (the frontier walk above only looks forward,
      // so a coin spent here — including by a tx broadcast on another device —
      // would otherwise never reconcile without a full rescan).
      if (await this._reconcileHeld()) changed = true;

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

  // Re-check every address that currently holds a UTXO: refresh its balance from
  // chain/mempool stats and rebuild its UTXOs. This is what reconciles spends
  // (a held coin that's now gone) — confirmed or still in the mempool, regardless
  // of which device broadcast the spending transaction. Returns true if anything
  // changed. Only touches addresses we already know, so it stays cheap.
  async _reconcileHeld() {
    const addrs = [...new Set(this.utxos.map((u) => u.address))];
    let changed = false;
    for (const address of addrs) {
      const p = this.addrMap.get(address);
      if (!p) continue;
      let info;
      try {
        info = await this.api.addressInfo(address);
      } catch {
        continue;
      }
      const cs = info.chain_stats || {};
      const ms = info.mempool_stats || {};
      const confirmed = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
      const pending = (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0);
      const arr = p.chain === 0 ? this.receive : this.change;
      const entry = arr.find((e) => e.index === p.index);
      if (entry && entry.confirmed === confirmed && entry.pending === pending) continue;

      let us;
      try {
        us = await this.api.addressUtxos(address);
      } catch {
        continue;
      }
      if (entry) {
        entry.confirmed = confirmed;
        entry.pending = pending;
      }
      this.utxos = this.utxos.filter((u) => u.address !== address);
      for (const u of us) {
        this.utxos.push({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address,
          chain: p.chain,
          index: p.index,
          confirmed: !!u.status.confirmed,
        });
      }
      changed = true;
    }
    return changed;
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
      // Probe both chains at once — they're independent, so interleaving lets
      // their per-hit delays overlap instead of running back-to-back.
      const [receive, change] = await Promise.all([this.scanChain(0), this.scanChain(1)]);
      this.receive = receive;
      this.change = change;
      this.nextReceiveIndex = firstUnused(this.receive);
      this.nextChangeIndex = firstUnused(this.change);
      this._recomputeBalanceFromChains();

      // Only pull /utxo and /txs (the heavy part) on first load or when the
      // balance/addresses actually changed. Idle polls stay /address-only.
      const balanceChanged =
        `${this.confirmed}|${this.pending}|${this.nextReceiveIndex}|${this.nextChangeIndex}` !== prevBal;
      // Always re-pull history while any tx is still pending, so confirmations
      // get reconciled even when the balance itself hasn't changed (e.g. a
      // received coin that simply moved from mempool to a block).
      const hasPending = this.txs.some((t) => !t.confirmed);
      if (!silent || balanceChanged || !this.loaded || hasPending) {
        // Balance + receive address are already known from the chain_stats above.
        // Show them right away so the wallet looks ready, then keep loading the
        // heavier UTXO set and full history in the background.
        if (!silent) {
          this.loaded = true;
          this.historyLoading = true;
          this.emit();
        }
        if (!silent || !this.feeRates) this.feeRates = await this.api.feeRates();
        await this.refreshUtxos();
        await this.refreshHistory(!silent);
      }
      this.loaded = true;
      this.saveCache();
    } finally {
      this._refreshing = false;
      this.historyLoading = false; // clear even if an earlier step threw
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
    // An address whose confirmed balance is 0 and which has no mempool activity
    // is fully spent and settled — it cannot hold any UTXOs, so skip the /utxo
    // round-trip for it. In a wallet with history most addresses are spent, so
    // this avoids the bulk of the requests (and the 429s that come with them).
    const used = this.usedAddresses().filter(
      (a) => (a.confirmed || 0) > 0 || a.hasMempool
    );
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

  // progressive: emit after each address resolves so the History tab fills in
  // as transactions arrive (foreground load) instead of all at once at the end.
  async refreshHistory(progressive = false) {
    const used = this.usedAddresses();
    this.historyLoading = true;
    const seen = new Set(); // txids found in this pass (a tx can touch >1 address)
    try {
      await pool(used, async (a) => {
        const list = await this.api.addressTxs(a.address);
        let added = false;
        for (const tx of list) {
          if (seen.has(tx.txid)) continue;
          seen.add(tx.txid);
          const summary = this._txSummary(tx);
          const at = this.txs.findIndex((t) => t.txid === tx.txid);
          if (at >= 0) this.txs[at] = summary; // refresh confirmations/fee
          else { this.txs.push(summary); added = true; }
        }
        if (added && progressive) {
          this._sortTxs();
          this.emit();
        }
      });
      // Drop anything that no longer appears in any address's history.
      this.txs = this.txs.filter((t) => seen.has(t.txid));
      this._sortTxs();
    } finally {
      this.historyLoading = false;
    }
  }

  // --- balances -----------------------------------------------------------
  // confirmed/pending are plain fields, set from chain_stats during scan (and
  // from UTXOs when restoring an offline snapshot). total is derived.
  get total() {
    return this.confirmed + this.pending;
  }

  // Confirmed coins locked behind unclaimed gift links. The whole source coin is
  // committed until the gift is claimed (our change only comes back in the
  // claimer's tx), so it's already excluded from spending — and from the
  // spendable balance below.
  get lockedValue() {
    const res = this.reservedSet();
    return this.utxos.reduce((s, u) => s + (res.has(utxoId(u)) ? u.value : 0), 0);
  }
  // What the user can actually spend right now: everything minus gift locks.
  get spendable() {
    return this.total - this.lockedValue;
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
      : this.utxos.filter((u) => !this.isReserved(utxoId(u))); // skip coins set aside for gifts
    if (!pool_.length) throw new Error('No spendable coins selected.');

    const inputs = pool_.map((u) => {
      const { script, pubkey } = this.derive(u.chain, u.index);
      const pay = p2wpkh(pubkey, this.netCfg.net);
      return {
        ...pay,
        txid: u.txid,
        index: u.vout,
        sequence: 0xfffffffd, // signal opt-in RBF (BIP125) so sends are bumpable
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
    if (this.watchOnly) throw new Error('Watch-only wallet — no keys to sign with.');
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

  // Parse a raw (signed) transaction hex — used by scan-to-broadcast to show a
  // confirmation (txid + outputs) before relaying someone's exported tx.
  parseRawTx(rawHex) {
    const tx = btc.Transaction.fromRaw(hex.decode(rawHex.trim()), { allowUnknownOutputs: true });
    const network = NETS[this.netName].net;
    const outputs = [];
    let total = 0;
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      total += Number(o.amount);
      let address = '';
      try {
        address = btc.Address(network).encode(btc.OutScript.decode(o.script));
      } catch {}
      outputs.push({ address, value: Number(o.amount) });
    }
    return { txid: tx.id, total, outputs };
  }

  // RBF fee bumping, in three steps so the UI can preview a fee per rate before
  // building: prepareBump() fetches + reconstructs the original (async), then
  // planBump()/buildBump() are pure and reuse that prep.

  // Fetch an unconfirmed outgoing tx and reconstruct what's needed to replace it.
  async prepareBump(origTxid) {
    const orig = await this.api.getTx(origTxid);
    if (orig.status && orig.status.confirmed) throw new Error('Transaction already confirmed.');

    const ins = [];
    let totalIn = 0;
    for (const vin of orig.vin || []) {
      const a = vin.prevout && vin.prevout.scriptpubkey_address;
      const p = a && this.addrMap.get(a);
      if (!p) throw new Error('Can only bump your own transactions.');
      totalIn += vin.prevout.value;
      ins.push({ txid: vin.txid, vout: vin.vout, value: vin.prevout.value, chain: p.chain, index: p.index });
    }

    // Our first change-chain output is the change we'll shrink; the rest are
    // recipients and stay fixed.
    const recipients = [];
    let outTotal = 0;
    let changeSeen = false;
    for (const o of orig.vout || []) {
      outTotal += o.value;
      const p = o.scriptpubkey_address && this.addrMap.get(o.scriptpubkey_address);
      if (p && p.chain === 1 && !changeSeen) { changeSeen = true; continue; }
      recipients.push({ address: o.scriptpubkey_address, value: o.value });
    }
    const usedIds = new Set(ins.map((i) => `${i.txid}:${i.vout}`));
    const spare = this.utxos.filter((u) => u.confirmed && !usedIds.has(utxoId(u)));
    return {
      txid: origTxid,
      ins,
      recipients,
      totalIn,
      recipTotal: recipients.reduce((s, r) => s + r.value, 0),
      oldFee: totalIn - outTotal,
      spare,
    };
  }

  // Pure: pick the fee/change (and any extra inputs) for a given rate.
  planBump(prep, feeRate) {
    const rate = Math.max(1, Math.round(feeRate));
    const DUST = 294; // p2wpkh dust
    const vsizeOf = (nIn, nOut) => 11 + 68 * nIn + 31 * nOut;
    const spare = prep.spare.slice();
    const extra = [];
    const compute = () => {
      const nIn = prep.ins.length + extra.length;
      const inAmt = prep.totalIn + extra.reduce((s, u) => s + u.value, 0);
      let nOut = prep.recipients.length + 1;
      let fee = Math.ceil(vsizeOf(nIn, nOut) * rate);
      let change = inAmt - prep.recipTotal - fee;
      if (change < DUST) { nOut = prep.recipients.length; fee = inAmt - prep.recipTotal; change = 0; }
      const minFee = prep.oldFee + vsizeOf(nIn, nOut); // BIP125 incremental relay
      if (change > 0 && fee < minFee) {
        fee = minFee; change = inAmt - prep.recipTotal - fee;
        if (change < DUST) { fee = inAmt - prep.recipTotal; change = 0; }
      }
      return { fee, change, ok: inAmt - prep.recipTotal >= fee && fee > prep.oldFee };
    };
    let pl = compute();
    while (!pl.ok && spare.length) { extra.push(spare.shift()); pl = compute(); }
    return { fee: pl.fee, change: pl.change, extra, ok: pl.ok, rate };
  }

  // Build + sign the replacement at a rate. Returns { hex, txid, fee, oldFee, ... }.
  buildBump(prep, feeRate) {
    const pl = this.planBump(prep, feeRate);
    if (!pl.ok) throw new Error('Not enough funds to bump at this rate. Try a lower rate or CPFP.');
    const allIns = [...prep.ins, ...pl.extra.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, chain: u.chain, index: u.index }))];
    const t = new btc.Transaction();
    for (const i of allIns) {
      const pay = p2wpkh(this.derive(i.chain, i.index).pubkey, this.netCfg.net);
      t.addInput({ ...pay, txid: i.txid, index: i.vout, sequence: 0xfffffffd, witnessUtxo: { script: pay.script, amount: BigInt(i.value) } });
    }
    for (const r of prep.recipients) t.addOutputAddress(r.address, BigInt(r.value), this.netCfg.net);
    const changeAddr = this.freshChange().address;
    if (pl.change > 0) t.addOutputAddress(changeAddr, BigInt(pl.change), this.netCfg.net);
    for (let k = 0; k < allIns.length; k++) t.signIdx(this.node(allIns[k].chain, allIns[k].index).privateKey, k);
    t.finalize();

    const outputs = prep.recipients.map((r) => ({ address: r.address, value: r.value }));
    if (pl.change > 0) outputs.push({ address: changeAddr, value: pl.change, change: true });
    return { hex: t.hex, txid: t.id, fee: pl.fee, oldFee: prep.oldFee, feeRate: pl.rate, outputs, replaces: prep.txid };
  }

  // --- gift links (coins backing claimable presigned transactions) ---------
  // A gift coin is either RESERVED (set aside, skipped by coin selection) or
  // RECLAIMED (freed for spending, but its link stays live until the coin is
  // actually spent). Both are "outstanding"; both are persisted per-wallet.
  _giftKey() {
    return this._cacheKey() + ':gift';
  }
  _reclaimedKey() {
    return this._cacheKey() + ':giftfree';
  }
  _loadSet(key) {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch {
      return new Set();
    }
  }
  reservedSet() {
    if (!this._reserved) this._reserved = this._loadSet(this._giftKey());
    return this._reserved;
  }
  reclaimedSet() {
    if (!this._reclaimed) this._reclaimed = this._loadSet(this._reclaimedKey());
    return this._reclaimed;
  }
  isReserved(id) {
    return this.reservedSet().has(id);
  }
  _saveReserved() {
    try { localStorage.setItem(this._giftKey(), JSON.stringify([...this.reservedSet()])); } catch {}
  }
  _saveReclaimed() {
    try { localStorage.setItem(this._reclaimedKey(), JSON.stringify([...this.reclaimedSet()])); } catch {}
  }
  // Passive reclaim: free the coin for spending but keep tracking the live link
  // so it can still be revoked later (until the coin is spent).
  unreserve(id) {
    this.reservedSet().delete(id);
    this.reclaimedSet().add(id);
    this._saveReserved();
    this._saveReclaimed();
  }

  // Truly revoke an unclaimed gift: spend its coin back into our own wallet,
  // which double-spends the gift's presigned input so the link can't be claimed
  // once this confirms. Uses a high fee to win any race with a claimer.
  async revokeGift(id, feeRate) {
    const draft = this.buildTx({ recipients: [{ address: this.freshChange().address }], feeRate, coinIds: [id], sendMax: true });
    const hexTx = this.sign(draft.tx);
    const txid = await this.broadcast(hexTx);
    this.reservedSet().delete(id);
    this.reclaimedSet().delete(id);
    this._saveReserved();
    this._saveReclaimed();
    return txid;
  }
  // Outstanding gifts (reserved + reclaimed) whose coin is still unspent; prunes
  // any whose coin has since been claimed/spent. { id, reserved, value }.
  outstandingGifts() {
    const live = new Set(this.utxos.map((u) => utxoId(u)));
    const res = this.reservedSet();
    const rec = this.reclaimedSet();
    let changed = false;
    for (const id of [...res]) if (!live.has(id)) { res.delete(id); changed = true; }
    for (const id of [...rec]) if (!live.has(id)) { rec.delete(id); changed = true; }
    if (changed) { this._saveReserved(); this._saveReclaimed(); }
    return [...new Set([...res, ...rec])].map((id) => ({
      id,
      reserved: res.has(id),
      value: (this.utxos.find((u) => utxoId(u) === id) || {}).value,
    }));
  }

  // Build a SIGHASH_SINGLE-signed gift: input = a single coin, output0 = change
  // back to us (cryptographically fixed), leaving the rest for the claimer to
  // direct to their own fresh address. Reserves the coin. Returns { code, ... }.
  createGift(amountSats, feeRate) {
    const gift = BigInt(Math.round(amountSats));
    const rate = Math.max(1, Math.round(feeRate));
    const DUST = 294n;
    if (gift < BigInt(giftMinimum(rate))) throw new Error('Gift amount is too small.');

    // Select confirmed coins (largest first, to minimize inputs) until they
    // cover the gift plus a dust change. The change output goes back to us and
    // is protected; the rest — the full gift amount — is the claimer's to
    // direct. No fee is reserved here: the claimer's wallet looks up the fee
    // rate at claim time and subtracts it from this amount.
    const pool = this.utxos
      .filter((u) => u.confirmed && !this.isReserved(utxoId(u)))
      .sort((a, b) => b.value - a.value);
    const sel = [];
    let sum = 0n;
    for (const u of pool) {
      sel.push(u);
      sum += BigInt(u.value);
      if (sum >= gift + DUST) break;
    }
    if (sum < gift + DUST) throw new Error('Not enough confirmed funds for that gift amount.');

    const change = sum - gift; // back to us, >= DUST by construction
    const t = new btc.Transaction({ allowUnknownOutputs: true });
    // First input commits the change output (SIGHASH_SINGLE on output 0); the
    // rest commit only the inputs (SIGHASH_NONE). Together: inputs and our
    // change are locked, while the claimer is free to add their own output.
    sel.forEach((u, i) => {
      const pay = p2wpkh(this.derive(u.chain, u.index).pubkey, this.netCfg.net);
      t.addInput({ ...pay, txid: u.txid, index: u.vout, sighashType: i === 0 ? btc.SigHash.SINGLE : btc.SigHash.NONE, witnessUtxo: { script: pay.script, amount: BigInt(u.value) } });
    });
    t.addOutputAddress(this.freshChange().address, change, this.netCfg.net);
    sel.forEach((u, i) => t.signIdx(this.node(u.chain, u.index).privateKey, i, [i === 0 ? btc.SigHash.SINGLE : btc.SigHash.NONE]));

    for (const u of sel) this.reservedSet().add(utxoId(u));
    this._saveReserved();
    return { code: base64urlnopad.encode(t.toPSBT()), amount: Number(gift), reserved: sel.map(utxoId) };
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
    // never re-polled — the deep scan below covers spends/confirmations.
    this._pollTimer = setInterval(() => this.refreshLive(), 20000);
    // Periodic full scan: reconciles everything refreshLive can't see on its own
    // — pending→confirmed history, spends, and stale cache/relay state.
    this._deepTimer = setInterval(() => this.scan({ silent: true }).catch(() => {}), 120000);
    // Only mempool.space has a live socket; other explorers rely on the poll
    // and deep scan above (wsUrl returns null → no socket).
    if (typeof WebSocket === 'undefined' || !this.wsUrl()) return;
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
    const mine = new Set(this.addrMap.keys());
    for (const tx of txs) {
      if (!tx || !Array.isArray(tx.vout)) continue;
      let relevant = false;
      tx.vout.forEach((vo, i) => {
        const a = vo && vo.scriptpubkey_address;
        if (!a || !this.addrMap.has(a)) return;
        relevant = true;
        const id = `${tx.txid}:${i}`;
        if (have.has(id)) return;
        const p = this.addrMap.get(a);
        const confirmed = !!(tx.status && tx.status.confirmed);
        this.utxos.push({ txid: tx.txid, vout: i, value: vo.value, address: a, chain: p.chain, index: p.index, confirmed });
        have.add(id);
        // Mark the receiving address used + record its balance, so the fresh
        // index advances immediately (next address/QR shows right away).
        const arr = p.chain === 0 ? this.receive : this.change;
        let entry = arr.find((e) => e.index === p.index);
        if (!entry) {
          entry = { chain: p.chain, index: p.index, address: a, used: false, confirmed: 0, pending: 0 };
          arr.push(entry);
        }
        entry.used = true;
        if (confirmed) entry.confirmed = (entry.confirmed || 0) + vo.value;
        else entry.pending = (entry.pending || 0) + vo.value;
        changed = true;
      });
      for (const vin of tx.vin || []) {
        const a = vin.prevout && vin.prevout.scriptpubkey_address;
        if (a && mine.has(a)) relevant = true;
      }
      // Record it in history — or refresh it, so a pending tx flips to confirmed.
      if (relevant) {
        const idx = this.txs.findIndex((t) => t.txid === tx.txid);
        const summary = this._txSummary(tx);
        if (idx < 0) {
          this.txs.push(summary);
          changed = true;
        } else if (this.txs[idx].confirmed !== summary.confirmed) {
          this.txs[idx] = summary;
          changed = true;
        }
      }
    }
    if (changed) {
      this.nextReceiveIndex = firstUnused(this.receive);
      this.nextChangeIndex = firstUnused(this.change);
      this._recomputeBalanceFromChains();
      this._sortTxs();
      this.retrack(); // start watching the new fresh address
      this.emit();
    }
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
    const id = this.watchOnly ? this.xpub : this.xprv ? this.xprv : `${this.mnemonic}\n${this.passphrase}`;
    const bytes = new TextEncoder().encode(id);
    return 'btc-wallet-cache:' + hex.encode(sha256(bytes)).slice(0, 32);
  }

  // The fresh receive index the user has acknowledged (tapped past the
  // "payment received" screen for). Persisted so a received payment keeps
  // showing the celebration until acknowledged, even across refreshes.
  getReceiveAck() {
    try {
      const v = localStorage.getItem(this._cacheKey() + ':ack');
      return v == null ? null : Number(v);
    } catch {
      return null;
    }
  }

  setReceiveAck(i) {
    try {
      localStorage.setItem(this._cacheKey() + ':ack', String(i));
    } catch {}
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
    // Push to the configured relays too (debounced), so other devices get the
    // update — unless cross-device sync is turned off.
    const sync = getSyncConfig();
    if (!this.offline && sync.enabled) {
      this.nostr.setRelays(sync.relays);
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
    const sync = getSyncConfig();
    if (this.offline || !sync.enabled) return false;
    this.nostr.setRelays(sync.relays);
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

// Watch-only: accept a native-segwit account xpub or zpub and normalize it to
// xpub version bytes (the key material is identical; only the prefix differs),
// so HDKey can load it. Throws on anything else (private keys, wrong type).
const _b58c = base58check(sha256);
const _XPUB_VER = Uint8Array.from([0x04, 0x88, 0xb2, 0x1e]);
const _ZPUB_VER = Uint8Array.from([0x04, 0xb2, 0x47, 0x46]);
const _XPRV_VER = Uint8Array.from([0x04, 0x88, 0xad, 0xe4]);
const _ZPRV_VER = Uint8Array.from([0x04, 0xb2, 0x43, 0x0c]);

// Classify a pasted extended key. xpub/zpub → public (watch-only); xprv/zprv →
// private (spending). Version bytes are normalized to the standard xpub/xprv set
// (key material is identical; only the prefix differs) so HDKey can load it.
// Returns { kind: 'xpub' | 'xprv', key } or throws.
export function parseExtendedKey(s) {
  let data;
  try {
    data = _b58c.decode((s || '').trim());
  } catch {
    throw new Error('Not a valid recovery phrase or key.');
  }
  if (data.length !== 78) throw new Error('Not a valid recovery phrase or key.');
  const ver = hex.encode(data.slice(0, 4));
  let kind, norm;
  if (ver === hex.encode(_XPUB_VER) || ver === hex.encode(_ZPUB_VER)) { kind = 'xpub'; norm = _XPUB_VER; }
  else if (ver === hex.encode(_XPRV_VER) || ver === hex.encode(_ZPRV_VER)) { kind = 'xprv'; norm = _XPRV_VER; }
  else throw new Error('Unrecognized key type — use a native-segwit xpub/zpub or xprv/zprv.');
  const out = new Uint8Array(data);
  out.set(norm, 0);
  const key = _b58c.encode(out);
  try {
    HDKey.fromExtendedKey(key);
  } catch {
    throw new Error('Not a valid extended key.');
  }
  return { kind, key };
}

// Encrypted vault for persisting seed-bearing accounts on this device. Key is
// scrypt(password, salt); payload is XChaCha20-Poly1305 (authenticated, so a
// wrong password fails to decrypt rather than returning garbage). All fields
// are hex so the blob is JSON-serializable for localStorage.
const _SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };
function _vaultKey(password, salt) {
  return scrypt(utf8ToBytes(password), salt, _SCRYPT);
}
export function encryptVault(obj, password) {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(_vaultKey(password, salt), nonce).encrypt(utf8ToBytes(JSON.stringify(obj)));
  return { v: 1, salt: hex.encode(salt), nonce: hex.encode(nonce), ct: hex.encode(ct) };
}
export function decryptVault(blob, password) {
  const pt = xchacha20poly1305(_vaultKey(password, hex.decode(blob.salt)), hex.decode(blob.nonce)).decrypt(hex.decode(blob.ct));
  return JSON.parse(bytesToUtf8(pt));
}

// Convert a standard account xpub to a BIP84 zpub for export/interop.
export function xpubToZpub(xpub) {
  const data = new Uint8Array(_b58c.decode(xpub));
  data.set(_ZPUB_VER, 0);
  return _b58c.encode(data);
}

// Gift-link claiming (sender side is Wallet.createGift). A gift code is a
// base64url PSBT: one SIGHASH_SINGLE-signed input + the sender's change output.
// previewGift reports the room available to the claimer (before their fee);
// buildClaimTx adds the claimer's output and finalizes a broadcastable tx.
// Smallest sensible gift at a given fee rate: dust + one claim fee of headroom
// (floored at 546 sats), so the recipient clears dust even if fees climb.
export function giftMinimum(feeRate) {
  const rate = Math.max(1, Math.round(feeRate));
  const claimFee = Math.ceil((11 + 68 + 31 * 2) * rate);
  return Math.max(546, 294 + claimFee);
}

function _sumInputs(tx) {
  let inAmt = 0n;
  for (let i = 0; i < tx.inputsLength; i++) inAmt += tx.getInput(i).witnessUtxo.amount;
  return inAmt;
}
export function previewGift(code) {
  try {
    const tx = btc.Transaction.fromPSBT(base64urlnopad.decode(code));
    // room is the full amount the claimer receives (inputs minus our change);
    // the claim fee is subtracted from it at claim time, so report inputs too
    // so the caller can size that fee for this PSBT.
    return { room: Number(_sumInputs(tx) - tx.getOutput(0).amount), inputs: tx.inputsLength };
  } catch {
    return null;
  }
}

export function buildClaimTx(code, toAddress, feeRate, net) {
  const tx = btc.Transaction.fromPSBT(base64urlnopad.decode(code));
  const room = _sumInputs(tx) - tx.getOutput(0).amount;
  const fee = BigInt(Math.max(1, Math.ceil((11 + 68 * tx.inputsLength + 31 * 2) * Math.max(1, Math.round(feeRate)))));
  const out = room - fee;
  if (out < 294n) throw new Error('Gift is too small to claim at this fee rate.');
  tx.addOutputAddress(toAddress, out, net);
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, amount: Number(out), fee: Number(fee) };
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
