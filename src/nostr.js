// Encrypted cross-device state sync via Nostr.
//
// The wallet's Nostr identity is derived from the same seed (NIP-06,
// m/44'/1237'/0'/0/0). Wallet state is encrypted to ourselves (NIP-44) and
// published as a single parameterized-replaceable event (kind 30078, NIP-78)
// to relay.coinos.io — so any device with the seed can pull the latest state
// without re-scanning, and the relay only ever keeps the newest copy.

import * as nip06 from 'nostr-tools/nip06';
import * as nip44 from 'nostr-tools/nip44';
import { getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';

const RELAY = 'wss://relay.coinos.io';
const DTAG = 'bitcoin-wallet';

export class NostrSync {
  constructor() {
    this.sk = null;
    this.pk = null;
    this.ck = null; // self conversation key for NIP-44
    this._relay = null;
  }

  load(mnemonic, passphrase = '') {
    this.sk = nip06.privateKeyFromSeedWords(mnemonic, passphrase || undefined);
    this.pk = getPublicKey(this.sk);
    this.ck = nip44.getConversationKey(this.sk, this.pk);
  }

  unload() {
    this.sk = this.pk = this.ck = null;
    if (this._relay) {
      try {
        this._relay.close();
      } catch {}
      this._relay = null;
    }
  }

  async _conn() {
    if (this._relay && this._relay.connected) return this._relay;
    this._relay = await Relay.connect(RELAY);
    return this._relay;
  }

  // Encrypt + publish the latest state (best-effort; never throws).
  async publish(stateObj) {
    if (!this.sk) return;
    try {
      const content = nip44.encrypt(JSON.stringify(stateObj), this.ck);
      const evt = finalizeEvent(
        { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', DTAG]], content },
        this.sk
      );
      const relay = await this._conn();
      await relay.publish(evt);
    } catch {
      /* offline / relay down — localStorage still has the state */
    }
  }

  // Fetch + decrypt the latest state, or null.
  async fetch() {
    if (!this.sk) return null;
    try {
      const relay = await this._conn();
      return await new Promise((resolve) => {
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
    } catch {
      return null;
    }
  }
}
