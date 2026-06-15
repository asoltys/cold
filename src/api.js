// Thin wrapper around the mempool.space REST API.
//
// Every network call goes through here so that "offline mode" can be enforced
// in exactly one place: when offline, any call throws and the UI relies on an
// imported snapshot instead.

const BASES = {
  mainnet: 'https://mempool.space/api',
  testnet: 'https://mempool.space/testnet/api',
};

export class Api {
  constructor(net = 'mainnet') {
    this.net = net;
    this.offline = false;

    // Global request throttle. mempool.space rate-limits bursts; an unthrottled
    // scan (~40 address lookups at once) gets a chunk of requests rejected, and
    // a throttled response arrives WITHOUT CORS headers, so the browser reports
    // it as a CORS error. We cap concurrency and space out request starts so we
    // stay under the limit, with exponential backoff to absorb the rest.
    this._maxConcurrent = 2;
    this._minGapMs = 250;
    this._active = 0;
    this._nextStart = 0;
    this._queue = [];
  }

  base() {
    return BASES[this.net] || BASES.mainnet;
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
      const delay = startAt - now;
      setTimeout(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this._active--;
            this.#pump();
          });
      }, delay);
    }
  }

  async #get(path, asText = false) {
    if (this.offline) throw new Error('offline');
    const url = this.base() + path;
    // Each attempt (including retries) goes back through the throttle so a burst
    // of retries can't re-trip the rate limit.
    const backoffs = [0, 700, 1500, 3000, 5000];
    let lastErr;
    for (const wait of backoffs) {
      if (wait) await sleep(wait);
      try {
        return await this.#schedule(async () => {
          const res = await fetch(url);
          if (res.status === 429) throw new Error('rate limited');
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
          return asText ? res.text() : res.json();
        });
      } catch (e) {
        lastErr = e; // network/CORS rejection (TypeError) or thrown above
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

  // Returns up to ~50 of the most recent transactions touching the address
  // (mempool first, then confirmed).
  addressTxs(address) {
    return this.#get(`/address/${address}/txs`);
  }

  async feeRates() {
    try {
      return await this.#get('/v1/fees/recommended');
    } catch {
      return { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 };
    }
  }

  async price() {
    try {
      const p = await this.#get('/v1/prices');
      return p && p.USD ? p.USD : null;
    } catch {
      return null;
    }
  }

  async broadcast(hexTx) {
    if (this.offline) throw new Error('offline');
    const res = await fetch(this.base() + '/tx', { method: 'POST', body: hexTx });
    const body = await res.text();
    if (!res.ok) throw new Error(body || `${res.status} broadcast failed`);
    return body.trim(); // txid
  }
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
