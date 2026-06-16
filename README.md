# Bitcoin Wallet

A self-contained, **single-file** Bitcoin wallet that runs entirely in the
browser — think bitaddress.org, but a modern BIP84 HD wallet from a seed
phrase that scans history, watches for payments in real time, and spends.

Live at **https://bitcoin.coinos.io** (and the built `index.html` runs offline
straight from the filesystem).

## Features

- **BIP84 / native SegWit (p2wpkh)** HD wallet from a 12/24-word BIP39 seed
  (optional passphrase). Mainnet.
- **One fresh address at a time** — a new receive address is only handed out
  after the current one is paid, so used addresses stay contiguous and scans
  stay tiny (no 20-address gap probing).
- **Real-time** via the mempool.space WebSocket: an incoming payment shows a
  "Payment received!" screen the moment it hits the mempool, then reveals the
  next address. A ping/pong heartbeat keeps the socket alive (auto-reconnect on
  drop, sleep, or network change).
- **Spending** with proper coin selection + fee estimation (`@scure/btc-signer`
  `selectUTXO`), multiple recipients, a fee-rate picker, send-max, and manual
  coin control.
- **Encrypted cross-device sync over Nostr** — wallet state is NIP-44-encrypted
  to yourself and stored as a replaceable event (kind 30078) on
  relay.coinos.io. The Nostr identity is derived from the same seed (NIP-06),
  so opening the wallet on another device restores state with no rescan.
- **Offline signing** — export a keyless JSON snapshot of your coins on an
  online device, import it on an offline one, sign locally, and export the
  signed transaction (hex / file / QR) to broadcast elsewhere.
- **Global sats/BTC toggle** (defaults to sats) — every amount label is
  clickable to switch, persisted across sessions.
- **Resilient explorer access** — mempool.space + Blockstream with a global
  request throttle, per-host cooldown on 429s, request timeouts with failover,
  and a localStorage cache so reloads are instant.

Built with the audited [`@scure`](https://github.com/paulmillr/scure-btc-signer)
/ [`@noble`](https://github.com/paulmillr/noble-hashes) libraries plus
[`nostr-tools`](https://github.com/nbd-wtf/nostr-tools). Pure JS, no
`crypto.subtle`, so it works from `file://` with no server.

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev      # http://localhost:5173 (rebuilds on each refresh)
```

## Build

```bash
bun run build    # → dist/index.html  (one self-contained file)
```

`dist/index.html` inlines all code, the crypto/QR/Nostr libraries, and the CSS.
Save that one file and open it directly in a browser — no server, no internet
needed (network features simply stay idle until you're online).

## How state is kept

Three layers, fastest first:

1. **sessionStorage** — keeps the wallet open across a refresh (cleared on
   logout / tab close).
2. **localStorage** — caches scanned state (addresses, UTXOs, history) keyed by
   a hash of the seed, so a reload shows balances instantly.
3. **Nostr** — encrypted, replaceable cross-device state on relay.coinos.io.

Idle polling only ever re-checks the fresh receive/change address; already-
scanned coin addresses are never re-polled (spends come over the WebSocket /
post-send refresh / Nostr). A manual **Settings → Rescan** covers anything
missed (e.g. a payment to a reused old address).

## Offline / air-gapped spending

1. **Online device:** open the wallet, let it scan, then **Settings → Export
   snapshot** (a keyless JSON of your UTXOs + fee rates).
2. Move the file to an **offline device** running the saved `index.html`.
3. There, enter your **seed phrase** (it auto-detects no network), then
   **Settings → Import snapshot**.
4. Build and **sign** a transaction; copy/download the signed hex (or scan the
   QR) and broadcast it from any online device.

## Layout

| File | Purpose |
| --- | --- |
| `src/wallet.js` | BIP84 derivation, scanning, coin selection, signing, realtime, cache, sync |
| `src/api.js` | Esplora wrapper (mempool.space + Blockstream) with throttle/cooldown/timeout |
| `src/nostr.js` | Encrypted cross-device state sync over Nostr |
| `src/app.js` | UI controller (vanilla DOM) |
| `src/qr.js` | QR → SVG (zero-dep) |
| `src/format.js` | sat/BTC formatting helpers |
| `src/style.css` | Hand-rolled styles |
| `build.js` / `dev.js` | Bun bundler → single inlined `index.html`, and dev server |

## Security notes

- Self-custody software handling real keys — review the code before trusting it
  with funds, and prefer an offline machine for the seed phrase.
- The seed/passphrase live in memory while the page is open and in
  sessionStorage for the tab session; locking or closing the tab clears them.
- The localStorage cache and the Nostr event hold public chain data (addresses,
  UTXOs, amounts); the Nostr copy is encrypted and keyed to your seed-derived
  identity, but the relay can see that an identity is publishing app data.
