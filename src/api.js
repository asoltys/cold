// Wrapper around Esplora-compatible block explorer APIs (mempool.space and
// Blockstream — same REST shape). Every network call goes through here so that
// "offline mode" can be enforced in one place.
//
// Rate-limiting strategy: public explorers return 429 (which the browser shows
// as a CORS error, since a 429 response has no CORS headers) when you burst a
// scan's ~40 address lookups. We defend on three fronts:
//   1. Throttle: cap concurrency + space out request starts.
//   2. Spread: round-robin across multiple backends, halving per-host load.
//   3. Cooldown: when a host 429s, park it for a few seconds and use the others
//      instead of hammering it with retries (which only makes 429s worse).

const BACKENDS = {
  mainnet: ['https://mempool.space/api', 'https://blockstream.info/api'],
  testnet: ['https://mempool.space/testnet/api', 'https://blockstream.info/testnet/api'],
};

const COOLDOWN_MS = 8000;

export class Api {
  constructor(net = 'mainnet') {
    this.net = net;
    this.offline = false;

    this._hosts = (BACKENDS[net] || BACKENDS.mainnet).map((base) => ({
      base,
      cooldownUntil: 0,
    }));
    this._rr = 0;

    // Global throttle.
    this._maxConcurrent = 2;
    this._minGapMs = 200;
    this._active = 0;
    this._nextStart = 0;
    this._queue = [];
  }

  explorerTx(txid) {
    const path = this.net === 'testnet' ? 'testnet/tx' : 'tx';
    return `https://mempool.space/${path}/${txid}`;
  }

  // Schedule a task respecting max concurrency + a minimum gap between starts.
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
      const startAt = Math.max(now, this._nextStart);
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

  // Pick a non-cooling-down host (round-robin), or null if all are cooling.
  #pickHost() {
    const now = Date.now();
    const avail = this._hosts.filter((h) => h.cooldownUntil <= now);
    if (!avail.length) return null;
    return avail[this._rr++ % avail.length];
  }

  async #get(path, asText = false) {
    if (this.offline) throw new Error('offline');
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt++) {
      let host = this.#pickHost();
      if (!host) {
        // Everyone is cooling down — wait until the soonest is ready.
        const soonest = Math.min(...this._hosts.map((h) => h.cooldownUntil));
        await sleep(Math.max(300, soonest - Date.now()));
        host = this.#pickHost() || this._hosts[0];
      }
      try {
        return await this.#schedule(async () => {
          const res = await fetch(host.base + path);
          if (res.status === 429) {
            host.cooldownUntil = Date.now() + COOLDOWN_MS;
            throw new Error('rate limited');
          }
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
          return asText ? res.text() : res.json();
        });
      } catch (e) {
        lastErr = e;
        await sleep(300); // brief pause, then try another host
      }
    }
    throw lastErr;
  }

  // chain_stats / mempool_stats let us decide whether an address has ever been
  // used without downloading its full history.
  addressInfo(address) {
    return this.#get(`/address/${address}`);
  }

  addressUtxos(address) {
    return this.#get(`/address/${address}/utxo`);
  }

  // Returns the most recent transactions touching the address.
  addressTxs(address) {
    return this.#get(`/address/${address}/txs`);
  }

  async feeRates() {
    const now = Date.now();
    for (const h of this._hosts) {
      if (h.cooldownUntil > now) continue;
      const isMempool = h.base.includes('mempool');
      try {
        const res = await fetch(h.base + (isMempool ? '/v1/fees/recommended' : '/fee-estimates'));
        if (res.status === 429) {
          h.cooldownUntil = Date.now() + COOLDOWN_MS;
          continue;
        }
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


  async broadcast(hexTx) {
    if (this.offline) throw new Error('offline');
    let lastErr;
    for (const h of this._hosts) {
      try {
        const res = await fetch(h.base + '/tx', { method: 'POST', body: hexTx });
        const body = await res.text();
        if (res.status === 429) {
          h.cooldownUntil = Date.now() + COOLDOWN_MS;
          lastErr = new Error('rate limited');
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(body || `${res.status} broadcast failed`);
          continue;
        }
        return body.trim(); // txid
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
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

// Run async jobs with a small concurrency cap so we stay friendly to the API.
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
