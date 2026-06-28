// Encrypted cross-device state sync via Nostr (opt-out, configurable relays).
//
// The wallet's Nostr identity is derived from the same seed (NIP-06,
// m/44'/1237'/0'/0/0). Wallet state is encrypted to ourselves (NIP-44) and
// published as a single parameterized-replaceable event (kind 30078, NIP-78)
// to the configured relays — so any device with the seed can pull the latest
// state without re-scanning, and a relay only ever keeps the newest copy.
//
// Sync is on by default (relay.coinos.io) but can be turned off or pointed at
// other relays in Settings; the preference lives in localStorage.

import * as nip06 from 'nostr-tools/nip06';
import * as nip44 from 'nostr-tools/nip44';
import * as nip04 from 'nostr-tools/nip04';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { decode as nip19decode, npubEncode } from 'nostr-tools/nip19';
import { Relay } from 'nostr-tools/relay';
import { randomBytes } from '@noble/hashes/utils';
import { base64urlnopad } from '@scure/base';

// --- locking a gift to a recipient's Nostr key ---------------------------
// An npub or 64-hex nostr pubkey → hex, or null if it isn't one.
export function parseNostrPubkey(input) {
  const s = (input || '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try { const d = nip19decode(s); if (d.type === 'npub') return d.data; } catch {}
  return null;
}
export function npubOf(pkHex) { try { return npubEncode(pkHex); } catch { return null; } }

// Encrypt a payload under a fresh one-time code (32 random bytes → base64url).
// The code travels to the recipient out-of-band (a nostr DM), so the public link
// holding the ciphertext can't be claimed without it. Returns { code, ct }.
export function encryptWithCode(plaintext) {
  const key = randomBytes(32);
  return { code: base64urlnopad.encode(key), ct: nip44.encrypt(plaintext, key) };
}
export function decryptWithCode(code, ct) {
  return nip44.decrypt(ct, base64urlnopad.decode((code || '').trim()));
}

// Profiles live across the network, so look them up on popular relays (broader
// than the sync relays).
export const PROFILE_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.coinos.io'];
// Fetch a recipient's profile (name + picture) for a pubkey, newest across relays.
export async function fetchNostrProfile(pubkeyHex, relays = PROFILE_RELAYS) {
  const results = await Promise.allSettled(relays.map((url) => _fetchProfileFrom(url, pubkeyHex)));
  let best = null;
  for (const r of results) {
    const v = r.status === 'fulfilled' ? r.value : null;
    if (v && (!best || (v.created_at || 0) > (best.created_at || 0))) best = v;
  }
  if (!best) return null;
  try {
    const m = JSON.parse(best.content);
    return { name: m.display_name || m.name || null, picture: m.picture || null, nip05: m.nip05 || null };
  } catch { return null; }
}
async function _fetchProfileFrom(url, pk) {
  let relay;
  try { relay = await Relay.connect(url); } catch { return null; }
  return new Promise((resolve) => {
    let ev = null;
    const done = () => { try { sub.close(); } catch {} try { relay.close(); } catch {} resolve(ev); };
    const sub = relay.subscribe([{ kinds: [0], authors: [pk], limit: 1 }], {
      onevent: (e) => { if (!ev || e.created_at > ev.created_at) ev = e; },
      oneose: done,
    });
    setTimeout(done, 5000);
  });
}

const DTAG = 'bitcoin-wallet';
const SYNC_KEY = 'btc-wallet-sync';
export const DEFAULT_SYNC_RELAYS = ['wss://relay.coinos.io'];

// --- sync preference (enabled + relays), global, persisted in localStorage ---
export function getSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      const relays = Array.isArray(c.relays) ? c.relays : [];
      return {
        enabled: c.enabled !== false,
        relays: relays.length ? relays : DEFAULT_SYNC_RELAYS,
      };
    }
  } catch {}
  return { enabled: true, relays: DEFAULT_SYNC_RELAYS }; // default: on, coinos relay
}

export function setSyncConfig({ enabled, relays }) {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ enabled: !!enabled, relays: relays || DEFAULT_SYNC_RELAYS }));
  } catch {}
}

export class NostrSync {
  constructor() {
    this.sk = null;
    this.pk = null;
    this.ck = null; // self conversation key for NIP-44
    this.relays = DEFAULT_SYNC_RELAYS;
    this._conns = new Map(); // url -> Relay
  }

  load(mnemonic, passphrase = '') {
    this.sk = nip06.privateKeyFromSeedWords(mnemonic, passphrase || undefined);
    this.pk = getPublicKey(this.sk);
    this.ck = nip44.getConversationKey(this.sk, this.pk);
  }

  unload() {
    this.sk = this.pk = this.ck = null;
    this._closeAll();
  }

  _closeAll() {
    for (const r of this._conns.values()) {
      try {
        r.close();
      } catch {}
    }
    this._conns.clear();
  }

  // Point at a new relay list, closing connections that are no longer used.
  setRelays(relays) {
    const next = Array.isArray(relays) && relays.length ? relays : DEFAULT_SYNC_RELAYS;
    for (const url of [...this._conns.keys()]) {
      if (!next.includes(url)) {
        try {
          this._conns.get(url).close();
        } catch {}
        this._conns.delete(url);
      }
    }
    this.relays = next;
  }

  async _connect(url) {
    const existing = this._conns.get(url);
    if (existing && existing.connected) return existing;
    const r = await Relay.connect(url);
    this._conns.set(url, r);
    return r;
  }

  // Encrypt + publish the latest state to every relay (best-effort).
  async publish(stateObj) {
    if (!this.sk) return;
    let evt;
    try {
      const content = nip44.encrypt(JSON.stringify(stateObj), this.ck);
      evt = finalizeEvent(
        { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', DTAG]], content },
        this.sk
      );
    } catch {
      return;
    }
    await Promise.allSettled(
      this.relays.map(async (url) => {
        const relay = await this._connect(url);
        await relay.publish(evt);
      })
    );
  }

  // Send an encrypted DM (NIP-04 kind 4) — used to deliver a locked gift's claim
  // code. Best-effort across the broad relay set so the recipient's client sees
  // it. Returns true if at least one relay accepted it.
  async sendDM(recipientPkHex, text, relays = PROFILE_RELAYS) {
    if (!this.sk) return false;
    let evt;
    try {
      const content = await nip04.encrypt(this.sk, recipientPkHex, text);
      evt = finalizeEvent({ kind: 4, created_at: Math.floor(Date.now() / 1000), tags: [['p', recipientPkHex]], content }, this.sk);
    } catch { return false; }
    const res = await Promise.allSettled((relays || PROFILE_RELAYS).map(async (url) => { const r = await this._connect(url); await r.publish(evt); }));
    return res.some((x) => x.status === 'fulfilled');
  }

  // Fetch from every relay; return the newest decrypted state, or null.
  async fetch() {
    if (!this.sk) return null;
    const results = await Promise.allSettled(this.relays.map((url) => this._fetchOne(url)));
    let best = null;
    for (const res of results) {
      const v = res.status === 'fulfilled' ? res.value : null;
      if (v && (!best || (v.savedAt || 0) > (best.savedAt || 0))) best = v;
    }
    return best;
  }

  async _fetchOne(url) {
    const relay = await this._connect(url);
    return new Promise((resolve) => {
      let result = null;
      const sub = relay.subscribe([{ kinds: [30078], authors: [this.pk], '#d': [DTAG], limit: 1 }], {
        onevent: (e) => {
          try {
            result = JSON.parse(nip44.decrypt(e.content, this.ck));
          } catch {}
        },
        oneose: () => {
          try {
            sub.close();
          } catch {}
          resolve(result);
        },
      });
      setTimeout(() => {
        try {
          sub.close();
        } catch {}
        resolve(result);
      }, 6000);
    });
  }
}
