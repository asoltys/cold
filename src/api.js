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
  }

  base() {
    return BASES[this.net] || BASES.mainnet;
  }

  explorerTx(txid) {
    const path = this.net === 'testnet' ? 'testnet/tx' : 'tx';
    return `https://mempool.space/${path}/${txid}`;
  }

  async #get(path, asText = false) {
    if (this.offline) throw new Error('offline');
    // Retry transient failures (mempool.space rate-limits bursts of requests
    // during a scan, which can surface as network/CORS errors from file://).
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(400 * attempt + 200);
      try {
        const res = await fetch(this.base() + path);
        if (res.status === 429) throw new Error('rate limited');
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
        return asText ? res.text() : res.json();
      } catch (e) {
        lastErr = e;
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
