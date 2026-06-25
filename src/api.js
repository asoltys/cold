// Wrapper around Esplora-compatible block explorer APIs (mempool.space and
// Blockstream — same REST shape). Every outgoing request goes through one
// rate-aware proxy (#run) so that:
//   - offline mode can be enforced in a single place,
//   - requests are serialized and spaced (one at a time), and
//   - a 429 from ANY request immediately backs off ALL subsequent requests
//     (global exponential pause), easing back as requests succeed.

// Block explorer selection (global, persisted in localStorage). Defaults to
// mempool.space, with blockstream.info as a silent failover for reliability.
// Users can pick blockstream.info only, or a custom Esplora/electrs REST URL
// (e.g. their own node) in Settings.
const EXPLORER_KEY = 'btc-wallet-explorer';

export const EXPLORER_PRESETS = [
  { id: 'mempool', label: 'mempool.space' },
  { id: 'blockstream', label: 'blockstream.info' },
  { id: 'custom', label: 'Custom' },
];

export function getExplorerConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(EXPLORER_KEY) || 'null');
    if (c && c.server) return { server: c.server, url: c.url || '' };
  } catch {}
  return { server: 'mempool', url: '' };
}

export function setExplorerConfig({ server, url }) {
  try {
    localStorage.setItem(EXPLORER_KEY, JSON.stringify({ server, url: url || '' }));
  } catch {}
}

// Resolve the configured explorer to the host list the Api tries in order.
function resolveHosts(net) {
  const cfg = getExplorerConfig();
  const apiPath = net === 'testnet' ? '/testnet/api' : '/api';
  const host = (web, kind) => ({ base: web + apiPath, kind, web, cooldownUntil: 0 });
  if (cfg.server === 'custom' && cfg.url) {
    const base = cfg.url.trim().replace(/\/+$/, '');
    return [{ base, kind: 'esplora', web: base.replace(/\/api$/, ''), cooldownUntil: 0 }];
  }
  if (cfg.server === 'blockstream') return [host('https://blockstream.info', 'esplora')];
  return [host('https://mempool.space', 'mempool'), host('https://blockstream.info', 'esplora')];
}

// Realtime is a private Fulcrum (Electrum protocol over WebSocket-Secure). It
// reliably pushes a scripthash-status notification the moment a tx touches a
// watched address — unlike the public Esplora/blockchain.info sockets, whose
// address push doesn't fire. Independent of the REST explorer choice. Mainnet
// only; testnet falls back to polling (null). Overridable for staging/testing.
const ELECTRUM_KEY = 'btc-wallet-electrum';
export function getElectrumWsUrl() {
  try {
    const u = localStorage.getItem(ELECTRUM_KEY);
    if (u) return u;
  } catch {}
  // Served as a path under coinos.io (a dedicated subdomain hit a Cloudflare
  // WebSocket quirk; the main hostname proxies WS cleanly).
  return 'wss://coinos.io/electrum';
}
export function wsUrl(net) {
  if (net === 'testnet') return null;
  return getElectrumWsUrl();
}

const REQUEST_TIMEOUT_MS = 10000;

export class Api {
  constructor(net = 'mainnet') {
    this.net = net;
    this.offline = false;

    // Hosts are tried in order; a host that 429s is parked on cooldown so we
    // stop hammering it (Blockstream rate-limits aggressively).
    this._hosts = resolveHosts(net);
    this._timeoutMs = REQUEST_TIMEOUT_MS;

    // Serialized scheduler: one request at a time, min gap between starts.
    this._active = 0;
    this._maxConcurrent = 1;
    this._minGapMs = 500;
    this._nextStart = 0;
    this._queue = [];

    // Global rate-limit state, shared across every request and host.
    this._pauseUntil = 0; // no request may start before this time
    this._penalty = 0; // current backoff level
    this._okStreak = 0; // consecutive successes (used to ease the penalty)
  }

  explorerTx(txid) {
    const web = (this._hosts[0] && this._hosts[0].web) || 'https://mempool.space';
    return web + (this.net === 'testnet' ? '/testnet/tx/' : '/tx/') + txid;
  }

  // ---- rate-aware global scheduler --------------------------------------
  #schedule(task) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    while (this._active < this._maxConcurrent && this._queue.length) {
      const { task, resolve, reject } = this._queue.shift();
      this._active++;
      const now = Date.now();
      // Respect both the per-request spacing AND any global backoff pause.
      const startAt = Math.max(now, this._nextStart, this._pauseUntil);
      this._nextStart = startAt + this._minGapMs;
      setTimeout(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this._active--;
            this.#pump();
          });
      }, startAt - now);
    }
  }

  // A 429 anywhere → pause every outgoing request, growing the pause each time.
  #penalize() {
    this._penalty = Math.min(this._penalty + 1, 6);
    this._okStreak = 0;
    const backoff = Math.min(2000 * 2 ** (this._penalty - 1), 30000); // 2s→30s
    this._pauseUntil = Date.now() + backoff;
  }

  #reward() {
    if (this._penalty === 0) return;
    if (++this._okStreak >= 4) {
      this._penalty--;
      this._okStreak = 0;
    }
  }

  // The single choke-point: fetch a given host through the scheduler. A 429
  // parks that host on cooldown (so we route away from it) and triggers the
  // global backoff pause.
  async #run(host, path, opts) {
    if (this.offline) throw new Error('offline');
    return this.#schedule(async () => {
      // Hard timeout: an unresponsive host must not stall the (serialized)
      // queue. On timeout/network error, park the host and fail over.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);
      let res;
      try {
        res = await fetch(host.base + path, { ...opts, signal: ctrl.signal });
      } catch (e) {
        host.cooldownUntil = Date.now() + 20000; // unresponsive — route away
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) {
        host.cooldownUntil = Date.now() + 30000;
        this.#penalize();
        const e = new Error('rate limited');
        e.rateLimited = true;
        throw e;
      }
      this.#reward();
      return res;
    });
  }

  // First host not on cooldown (mempool preferred), or null if all are cooling.
  #pickHost() {
    const now = Date.now();
    for (const h of this._hosts) if (h.cooldownUntil <= now) return h;
    return null;
  }

  async #get(path, asText = false) {
    if (this.offline) throw new Error('offline');
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      let host = this.#pickHost();
      if (!host) {
        // Every host is cooling down — wait for the soonest to recover.
        const soonest = Math.min(...this._hosts.map((h) => h.cooldownUntil));
        await sleep(Math.max(300, soonest - Date.now()));
        host = this.#pickHost() || this._hosts[0];
      }
      try {
        const res = await this.#run(host, path);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
        return asText ? await res.text() : await res.json();
      } catch (e) {
        lastErr = e;
        if (!e.rateLimited) await sleep(300);
      }
    }
    throw lastErr;
  }

  // chain_stats / mempool_stats tell us whether an address has ever been used.
  addressInfo(address) {
    return this.#get(`/address/${address}`);
  }

  addressUtxos(address) {
    return this.#get(`/address/${address}/utxo`);
  }

  addressTxs(address) {
    return this.#get(`/address/${address}/txs`);
  }

  // Full transaction (vin with prevouts, vout, status) — used for fee bumping.
  getTx(txid) {
    return this.#get(`/tx/${txid}`);
  }

  async feeRates() {
    for (const host of this._hosts) {
      if (host.cooldownUntil > Date.now()) continue;
      const isMempool = host.kind === 'mempool';
      try {
        const res = await this.#run(host, isMempool ? '/v1/fees/recommended' : '/fee-estimates');
        if (!res.ok) continue;
        const data = await res.json();
        if (isMempool && data && data.halfHourFee) return data;
        if (!isMempool && data) return mapEsploraFees(data);
      } catch {
        /* try next host */
      }
    }
    return { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 };
  }

  // Broadcast to ALL explorers in parallel (not via the throttle — a send is
  // urgent) so the tx is visible regardless of which explorer the recipient
  // watches. Resolves with the txid if any accept it; rejects only if all fail.
  async broadcast(hexTx) {
    if (this.offline) throw new Error('offline');
    const attempts = this._hosts.map(async (host) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this._timeoutMs);
      let res;
      try {
        res = await fetch(host.base + '/tx', { method: 'POST', body: hexTx, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      const body = await res.text();
      if (res.status === 429) {
        host.cooldownUntil = Date.now() + 30000;
        this.#penalize();
      }
      if (!res.ok) throw new Error(body || `${res.status} broadcast failed`);
      return body.trim(); // txid
    });
    const results = await Promise.allSettled(attempts);
    const ok = results.find((r) => r.status === 'fulfilled');
    if (ok) return ok.value;
    throw (results.find((r) => r.status === 'rejected') || {}).reason || new Error('broadcast failed');
  }
}

// Esplora /fee-estimates is { blockTarget: sat/vB }. Map to the named tiers the
// UI expects. Round up so we never underpay.
function mapEsploraFees(est) {
  const at = (n, d) => Math.max(1, Math.ceil(est[n] || d));
  return {
    fastestFee: at(1, 10),
    halfHourFee: at(3, 5),
    hourFee: at(6, 3),
    economyFee: at(144, 2),
    minimumFee: at(1008, 1),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run async jobs with a small concurrency cap. (The global scheduler is the
// real limiter; this just bounds how many are queued at once.)
export async function pool(items, worker, concurrency = 4) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}
