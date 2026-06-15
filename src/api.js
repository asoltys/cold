// Wrapper around Esplora-compatible block explorer APIs (mempool.space and
// Blockstream — same REST shape). Every outgoing request goes through one
// rate-aware proxy (#run) so that:
//   - offline mode can be enforced in a single place,
//   - requests are serialized and spaced (one at a time), and
//   - a 429 from ANY request immediately backs off ALL subsequent requests
//     (global exponential pause), easing back as requests succeed.

const BACKENDS = {
  mainnet: ['https://mempool.space/api', 'https://blockstream.info/api'],
  testnet: ['https://mempool.space/testnet/api', 'https://blockstream.info/testnet/api'],
};

export class Api {
  constructor(net = 'mainnet') {
    this.net = net;
    this.offline = false;

    this._hosts = BACKENDS[net] || BACKENDS.mainnet;
    this._rr = 0;

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
    const path = this.net === 'testnet' ? 'testnet/tx' : 'tx';
    return `https://mempool.space/${path}/${txid}`;
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

  // The single choke-point: fetch through the scheduler with 429 handling.
  async #run(url, opts) {
    if (this.offline) throw new Error('offline');
    return this.#schedule(async () => {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        this.#penalize();
        const e = new Error('rate limited');
        e.rateLimited = true;
        throw e;
      }
      this.#reward();
      return res;
    });
  }

  #host() {
    return this._hosts[this._rr++ % this._hosts.length];
  }

  async #get(path, asText = false) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await this.#run(this.#host() + path);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
        return asText ? await res.text() : await res.json();
      } catch (e) {
        lastErr = e;
        // On a 429 the global pause already delays the retry; for other errors
        // add a small wait before trying the other host.
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

  async feeRates() {
    for (const base of this._hosts) {
      const isMempool = base.includes('mempool');
      try {
        const res = await this.#run(base + (isMempool ? '/v1/fees/recommended' : '/fee-estimates'));
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
    let lastErr;
    for (const base of this._hosts) {
      try {
        const res = await this.#run(base + '/tx', { method: 'POST', body: hexTx });
        const body = await res.text();
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
