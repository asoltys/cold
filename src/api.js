// Wrapper around Esplora-compatible block explorer APIs (mempool.space and
// Blockstream — same REST shape). Every outgoing request goes through one
// rate-aware proxy (#run) so that:
//   - offline mode can be enforced in a single place,
//   - requests are serialized and spaced (one at a time), and
//   - a 429 from ANY request immediately backs off ALL subsequent requests
//     (global exponential pause), easing back as requests succeed.

// Block explorer selection, stored per network (see the per-network presets +
// nk() helper below). Each network defaults to its first esplora preset; users
// can pick another or a custom Esplora/electrs REST URL (their own node).
const EXPLORER_KEY = 'btc-wallet-explorer';

export function getExplorerConfig(net = getNetwork()) {
  try {
    const c = JSON.parse(localStorage.getItem(nk(EXPLORER_KEY, net)) || 'null');
    if (c && c.server) return { server: c.server, url: c.url || '' };
  } catch {}
  return { server: netDefaults(net).explorer, url: '' };
}

export function setExplorerConfig({ server, url }, net = getNetwork()) {
  try {
    localStorage.setItem(nk(EXPLORER_KEY, net), JSON.stringify({ server, url: url || '' }));
  } catch {}
}

// Active Bitcoin network, persisted globally. mutinynet is a public signet (30s
// blocks) for testing — same address format as testnet, its own explorer at
// mutinynet.com. Data-source choices are stored per network (see nk()).
const NETWORK_KEY = 'btc-wallet-network';
export const NETWORKS = [
  { id: 'mainnet', label: 'Mainnet' },
  { id: 'testnet', label: 'Testnet' },
  { id: 'mutinynet', label: 'Mutinynet' },
  { id: 'regtest', label: 'Regtest' },
];
export function getNetwork() {
  try {
    const n = localStorage.getItem(NETWORK_KEY);
    if (NETWORKS.some((x) => x.id === n)) return n;
  } catch {}
  return 'mainnet';
}
export function setNetwork(net) {
  try { localStorage.setItem(NETWORK_KEY, net); } catch {}
}

// Per-network data-source presets — the single place network-specific endpoints
// live (so there are no duplicate URL fields elsewhere). Each network has its own
// Electrum servers and block explorers; the selection is stored per network, so
// switching networks remembers each one's choice. 'custom' points at your node.
const ELECTRUM_PRESETS_BY_NET = {
  mainnet: [
    { id: 'coinos', label: 'coinos', url: 'wss://halwallet.app/electrum' },
    { id: 'blockstream', label: 'blockstream.info', url: 'wss://blockstream.info/electrum-websocket/' },
    { id: 'electroncash', label: 'btc.electroncash.dk', url: 'wss://btc.electroncash.dk:60004' },
    { id: 'blackie', label: 'blackie.c3-soft.com', url: 'wss://blackie.c3-soft.com:57004' },
    { id: 'jochen', label: 'electrum.jochen-hoenicke.de', url: 'wss://electrum.jochen-hoenicke.de:50010' },
    { id: 'mempoolguide', label: 'mempool.guide', url: 'wss://mempool.guide/electrum-websocket/' },
    { id: 'custom', label: 'Custom (your node)', url: '' },
  ],
  testnet: [
    { id: 'blockstream', label: 'blockstream.info', url: 'wss://blockstream.info/testnet/electrum-websocket/' },
    { id: 'custom', label: 'Custom (your node)', url: '' },
  ],
  mutinynet: [
    { id: 'custom', label: 'Custom (your node)', url: '' },
  ],
  regtest: [
    { id: 'local', label: 'Local Fulcrum', url: 'ws://localhost:50003' },
    { id: 'custom', label: 'Custom', url: '' },
  ],
};
const EXPLORER_PRESETS_BY_NET = {
  mainnet: [
    { id: 'mempool', label: 'mempool.space', base: 'https://mempool.space/api', web: 'https://mempool.space', kind: 'mempool' },
    { id: 'blockstream', label: 'blockstream.info', base: 'https://blockstream.info/api', web: 'https://blockstream.info', kind: 'esplora' },
    { id: 'custom', label: 'Custom', base: '', web: '', kind: 'esplora' },
  ],
  testnet: [
    { id: 'mempool', label: 'mempool.space', base: 'https://mempool.space/testnet/api', web: 'https://mempool.space/testnet', kind: 'mempool' },
    { id: 'blockstream', label: 'blockstream.info', base: 'https://blockstream.info/testnet/api', web: 'https://blockstream.info/testnet', kind: 'esplora' },
    { id: 'custom', label: 'Custom', base: '', web: '', kind: 'esplora' },
  ],
  mutinynet: [
    { id: 'mutinynet', label: 'mutinynet.com', base: 'https://mutinynet.com/api', web: 'https://mutinynet.com', kind: 'esplora' },
    { id: 'custom', label: 'Custom', base: '', web: '', kind: 'esplora' },
  ],
  regtest: [
    { id: 'local', label: 'Local (localhost:3000)', base: 'http://localhost:3000', web: 'http://localhost:3000', kind: 'esplora' },
    { id: 'custom', label: 'Custom', base: '', web: '', kind: 'esplora' },
  ],
};
// Per-network defaults: the mode + server a network starts on before any choice.
const NET_DEFAULTS = {
  mainnet: { mode: 'electrum', electrum: 'coinos', explorer: 'mempool' },
  testnet: { mode: 'explorer', electrum: 'blockstream', explorer: 'mempool' },
  mutinynet: { mode: 'explorer', electrum: 'custom', explorer: 'mutinynet' },
  regtest: { mode: 'electrum', electrum: 'local', explorer: 'local' },
};
export function electrumPresets(net = getNetwork()) { return ELECTRUM_PRESETS_BY_NET[net] || ELECTRUM_PRESETS_BY_NET.mainnet; }
export function explorerPresets(net = getNetwork()) { return EXPLORER_PRESETS_BY_NET[net] || EXPLORER_PRESETS_BY_NET.mainnet; }
function netDefaults(net) { return NET_DEFAULTS[net] || NET_DEFAULTS.mainnet; }
// Per-network storage keys: mainnet keeps the bare key (backward compat), others
// get a ":<net>" suffix.
function nk(base, net) { return net === 'mainnet' ? base : `${base}:${net}`; }

// Boltz swap provider — the api-v2 REST endpoint the SwapManager talks to; the
// swap-status WebSocket is derived from it (http->ws + /v2/ws) unless given.
// Presets are independent Boltz-compatible instances from SwapMarket's list
// (swapmarket.github.io); `local` is the regtest stack. Non-custodial either
// way: a provider can fail a swap but never steal (we claim/refund on-chain).
export const BOLTZ_PRESETS = [
  { id: 'local', label: 'Local (regtest)', api: 'http://localhost:9001', ws: 'ws://localhost:9004/v2/ws' },
  { id: 'boltz', label: 'Boltz Exchange', api: 'https://api.boltz.exchange' },
  { id: 'middleway', label: 'Middle Way', api: 'https://api.middle-way.space' },
  { id: 'zeus', label: 'ZEUS Swaps', api: 'https://swaps.zeuslsp.com/api' },
  { id: 'eldamar', label: 'Eldamar', api: 'https://boltz-api.eldamar.icu' },
  { id: 'custom', label: 'Custom…', api: '', ws: '' },
];
const BOLTZ_PROVIDER_KEY = 'btc-wallet-boltz-provider'; // selected preset id
const BOLTZ_CUSTOM_KEY = 'btc-wallet-boltz-custom';     // { api, ws } for custom

export function getBoltzCustom() {
  try { const c = JSON.parse(localStorage.getItem(BOLTZ_CUSTOM_KEY) || 'null'); if (c) return { api: c.api || '', ws: c.ws || '' }; } catch {}
  return { api: '', ws: '' };
}
export function setBoltzCustom({ api, ws }) {
  try { localStorage.setItem(BOLTZ_CUSTOM_KEY, JSON.stringify({ api: (api || '').trim(), ws: (ws || '').trim() })); } catch {}
}
export function getBoltzProviderId() {
  try { const id = localStorage.getItem(BOLTZ_PROVIDER_KEY); if (id && BOLTZ_PRESETS.some((p) => p.id === id)) return id; } catch {}
  return getNetwork() === 'regtest' ? 'local' : 'boltz'; // default per network
}
export function setBoltzProviderId(id) { try { localStorage.setItem(BOLTZ_PROVIDER_KEY, id); } catch {} }

export function getBoltzProvider() {
  const p = BOLTZ_PRESETS.find((x) => x.id === getBoltzProviderId()) || BOLTZ_PRESETS[1];
  if (p.id === 'custom') { const c = getBoltzCustom(); return { id: 'custom', api: c.api, ws: c.ws }; }
  return { id: p.id, api: p.api, ws: p.ws || '' };
}
const deriveBoltzWs = (api) => api ? api.replace(/^http/, 'ws').replace(/\/+$/, '') + '/v2/ws' : '';
export function getBoltzApi() { return getBoltzProvider().api; }
export function getBoltzWs() { const p = getBoltzProvider(); return p.ws || deriveBoltzWs(p.api); }

// Resolve the configured explorer to the host list the Api tries in order.
function resolveHosts(net) {
  const cfg = getExplorerConfig(net);
  const presets = explorerPresets(net);
  const mk = (p) => ({ base: p.base, kind: p.kind, web: p.web, cooldownUntil: 0 });
  if (cfg.server === 'custom' && cfg.url) {
    const base = cfg.url.trim().replace(/\/+$/, '');
    return [{ base, kind: 'esplora', web: base.replace(/\/api$/, ''), cooldownUntil: 0 }];
  }
  const p = presets.find((x) => x.id === cfg.server && x.base) || presets.find((x) => x.base) || presets[0];
  // Mainnet silently fails mempool.space over to blockstream.info.
  if (net === 'mainnet' && p.id === 'mempool') return [mk(p), mk(presets.find((x) => x.id === 'blockstream'))];
  return [mk(p)];
}

// The "data source" setting (stored per network) picks where chain data +
// payment notifications come from:
//   electrum — an Electrum-over-WS server for both data and instant push. The
//              default server is coinos's own Fulcrum on mainnet (see the
//              per-network presets), or point it at your own node.
//   explorer — block-explorer REST data only; polls for payments, no node.
// getBackend() derives from it. Old global 'coinos' mode maps to 'electrum'.
const DATA_MODE_KEY = 'btc-wallet-mode';
export function getDataMode(net = getNetwork()) {
  try {
    const m = localStorage.getItem(nk(DATA_MODE_KEY, net));
    if (m === 'electrum' || m === 'explorer') return m;
    if (m === 'coinos') return 'electrum'; // coinos is now the default Electrum server
  } catch {}
  return netDefaults(net).mode;
}
export function setDataMode(m, net = getNetwork()) {
  try { localStorage.setItem(nk(DATA_MODE_KEY, net), m === 'explorer' ? 'explorer' : 'electrum'); } catch {}
}

export function getBackend() {
  return getDataMode() === 'electrum' ? 'electrum' : 'esplora';
}
// The legacy coinos watcher shim is retired (coinos is a full Electrum server
// now); 'explorer' mode polls for payments instead of subscribing.
export function getRealtimeEnabled() { return false; }

const ELECTRUM_SERVER_KEY = 'btc-wallet-electrum-server';
export function getElectrumServerConfig(net = getNetwork()) {
  try {
    const c = JSON.parse(localStorage.getItem(nk(ELECTRUM_SERVER_KEY, net)) || 'null');
    if (c && c.server) return { server: c.server, url: c.url || '' };
  } catch {}
  return { server: netDefaults(net).electrum, url: '' };
}
export function setElectrumServerConfig({ server, url }, net = getNetwork()) {
  try { localStorage.setItem(nk(ELECTRUM_SERVER_KEY, net), JSON.stringify({ server, url: url || '' })); } catch {}
}
// Ordered Electrum WS candidates for the current selection — the wallet tries
// them in turn, advancing when one fails to connect. A named public preset falls
// over to the network's other public servers for resilience; a custom your-node
// URL does NOT fall over — we won't silently leak your addresses to a server you
// didn't pick.
const PUBLIC_ELECTRUM = (net) => electrumPresets(net).filter((x) => x.url).map((x) => x.url);
export function electrumCandidates(net = getNetwork()) {
  const cfg = getElectrumServerConfig(net);
  const presets = electrumPresets(net);
  if (cfg.server === 'custom') return cfg.url.trim() ? [cfg.url.trim()] : [];
  const primary = (presets.find((x) => x.id === cfg.server) || presets[0]).url;
  if (!primary) return [];
  return [primary, ...PUBLIC_ELECTRUM(net).filter((u) => u !== primary)];
}
export function resolveElectrumUrl() {
  return electrumCandidates()[0] || null;
}

// The Electrum backend (data + realtime push) selects/rotates candidates in the
// wallet via electrumCandidates(); the esplora backend has no push and polls. So
// there's no separate watcher URL anymore — wsUrl is always null.
export function wsUrl() { return null; }

// Web base for tx links (Electrum has no web UI — reuse the chosen explorer host).
export function explorerWeb(net = getNetwork()) {
  const hosts = resolveHosts(net);
  return (hosts[0] && hosts[0].web) || 'https://mempool.space';
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
    // web already carries any network path prefix (e.g. .../testnet, mutinynet.com).
    const web = (this._hosts[0] && this._hosts[0].web) || 'https://mempool.space';
    return web + '/tx/' + txid;
  }

  get isRegtest() { return this.net === 'regtest'; }

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

  // Spend status of one output: { spent, txid (spender), vin, status }. Reports
  // a spend even by an unconfirmed tx — used to tell if a gift was already claimed.
  outspend(txid, vout) {
    return this.#get(`/tx/${txid}/outspend/${vout}`);
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
      try {
        // Keep the abort timer active across BOTH the request and the body read —
        // a stalled response body must not hang the broadcast forever.
        const res = await fetch(host.base + '/tx', { method: 'POST', body: hexTx, signal: ctrl.signal });
        const body = await res.text();
        if (res.status === 429) {
          host.cooldownUntil = Date.now() + 30000;
          this.#penalize();
        }
        if (!res.ok) throw new Error(body || `${res.status} broadcast failed`);
        return body.trim(); // txid
      } finally {
        clearTimeout(timer);
      }
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
