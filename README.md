# Hal Wallet

A self-contained, **single-file** Bitcoin wallet that runs entirely in the
browser — think bitaddress.org, but a modern BIP84 HD wallet from a seed phrase
that scans history, watches for payments, and spends. The whole wallet is one
static `index.html` you can save and run offline, forever.

Live at **https://halwallet.app** (the built `index.html` also runs straight
from the filesystem with no server).

The name is a nod to [Hal Finney](https://en.wikipedia.org/wiki/Hal_Finney_(computer_scientist)).

## Installation

Download the latest `Halwallet.zip` from the [releases page](https://github.com/asoltys/halwallet/releases), unzip it, and open `dist/index.html` in your browser. No server, no build tools, no internet needed.

Hal Wallet also makes an excellent air-gapped (offline) signing device. See **[INSTALL.md](INSTALL.md)** for a step-by-step guide to set it up on an old phone or single-board computer.

## Features

- **BIP84 / native SegWit (p2wpkh)** HD wallet from a 12-word BIP39 seed
  (imports any valid BIP39 phrase; optional passphrase).
- **Silent Payments (BIP-352)** — **send** to any `sp1…` / `tsp1…` address
  (ECDH-derived one-time taproot outputs) and **receive** by sharing your
  reusable silent payment address. Block scanning detects incoming silent
  payments from any sender.
- **Descriptor import** — paste a descriptor such as `wpkh(xpub…)`,
  `tr(xpub…)`, `sh(wpkh(xpub…))`, etc. with optional multi-derivation
  (`<0;1>/*`) and checksum suffix.
- **Extended key import** — `xpub`/`zpub`/`tpub`/`vpub`/`upub` (watch-only)
  and `xprv`/`zprv`/`tprv`/`vprv`/`uprv` (full spending), with auto-detection
  of the target network from the key prefix.
- **Network selector on import** — override the default network when pasting
  a seed phrase, key, or descriptor. Network is auto-detected when pasting a
  testnet-prefixed key.
- **Multi-network support** — switch between **Mainnet**, **Testnet**,
  **Testnet4**, **Signet**, and **Regtest** in Settings. Each network has a
  default block explorer and supports custom Esplora/electrs URLs.
- **One fresh address at a time** — a new receive address is only handed out
  after the current one is paid, so used addresses stay contiguous and scans
  stay tiny (no 20-address gap probing). A manual **"New address"** button
  lets you advance early when you need a fresh address.
- **Choose your own block explorer** — mempool.space by default (with
  blockstream.info as a silent failover), blockstream.info only, or a **custom
  Esplora / electrs REST URL** (e.g. your own node) in Settings.
- **Real-time** via the mempool.space WebSocket (when that explorer is
  selected): an incoming payment shows a "Payment received!" screen the moment
  it hits the mempool. Other explorers fall back to polling plus a periodic full
  reconcile. A ping/pong heartbeat keeps the socket alive (auto-reconnect on
  drop, sleep, or network change).
- **Spending** with proper coin selection + fee estimation (`@scure/btc-signer`
  `selectUTXO`), multiple recipients, a fee-rate picker, send-max, and manual
  coin control.
- **QR scanner** on the send page — scan a Bitcoin address, a BIP21 URI (fills
  the amount too), or a signed transaction to broadcast it. Uses the native
  `BarcodeDetector` where available and lazy-loads jsQR otherwise.
- **Transaction labeling** — add a label (e.g. "coffee with Alice") to any
  transaction in the History detail view. Labels persist across sessions
  on the device.
- **Label export/import (BIP-329)** — export labels as a standard JSON file
  and re-import on another device. Labels are also embedded in wallet snapshots.
- **Per-address rescan** — targeted re-check of a single reused address (no
  full wallet rescan). Paginated list with individual **Rescan** buttons and a
  **"Scan X more"** bulk option to extend the address pool.
- **Scan from date & gap limit** — configure the start date and gap limit in
  the import pane's advanced options for deep recovery from a past date.
- **Optional encrypted cross-device sync over Nostr** — wallet state is
  NIP-44-encrypted to yourself and stored as a replaceable event (kind 30078) on
  the relay(s) you choose (default relay.coinos.io). The Nostr identity is
  derived from the same seed (NIP-06). On by default, toggled off in Settings.
- **Offline / air-gapped signing** — export a keyless JSON snapshot of your
  coins on an online device, import it on an offline one, sign locally, and
  export the signed transaction (hex / file / QR) to broadcast elsewhere. You
  can also sign-and-export online (broadcast from another device).
- **Installable PWA** — installs to your home screen and works offline once
  installed (the app shell, icons, and QR decoder are precached).
- **Global sats/BTC toggle** (defaults to sats) — every amount label is
  clickable to switch, persisted across sessions.

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
bun run build    # → dist/  (index.html + PWA sidecars)
```

`dist/index.html` inlines all code, the crypto/QR/Nostr libraries, and the CSS —
save that one file and open it directly in a browser, no server or internet
needed. The build also creates `Halwallet.zip` (the entire `dist/` folder) for
download.
The PWA extras (`manifest.webmanifest`, `sw.js`,
icons, and a lazy-loaded `jsqr.js`) are for the hosted site; they're optional and
simply 404 when `index.html` is opened on its own.

## How state is kept

Three layers, fastest first:

1. **sessionStorage** — keeps the wallet open across a refresh (cleared on
   logout / tab close).
2. **localStorage** — caches scanned state (addresses, UTXOs, history) keyed by
   a hash of the seed, so a reload shows balances instantly.
3. **Nostr** — encrypted, replaceable cross-device state on your configured
   relay(s) (when sync is enabled).

On load and on a 2-minute timer the wallet does a full reconcile; between those,
a light poll re-checks the fresh frontier and the addresses currently holding
coins. A manual **Settings → Rescan** forces a full re-scan on demand.

## Offline / air-gapped spending

1. **Online device:** open the wallet, let it scan, then **Settings → Export
   snapshot** (a keyless JSON of your UTXOs + fee rates).
2. Move the file to an **offline device** running the saved `index.html`.
3. On the offline device, enter your **seed phrase** and select the correct
   **network** in Settings (mainnet/testnet/signet/etc.), then
   **Settings → Import snapshot**.
4. Build and **sign** a transaction; copy/download the signed hex (or scan the
   QR) and broadcast it from any online device.

## Layout

| File | Purpose |
| --- | --- |
| `src/wallet.js` | BIP84 derivation, scanning, coin selection, signing, realtime, cache, sync |
| `src/api.js` | Esplora wrapper + explorer selection (mempool / blockstream / custom) with throttle/cooldown/timeout |
| `src/silentpay.js` | BIP-352 silent payments — send (ECDH taproot output derivation) and receive (key derivation, address generation, block scanning) |
| `src/nostr.js` | Optional encrypted cross-device state sync over Nostr (configurable relays) |
| `src/scan.js` | Camera QR scanner (native BarcodeDetector / lazy jsQR) |
| `src/app.js` | UI controller (vanilla DOM) |
| `src/qr.js` | QR → SVG (zero-dep) |
| `src/format.js` | sat/BTC formatting helpers |
| `src/i18n.js` | UI strings + translations |
| `src/style.css` | Hand-rolled styles |
| `build.js` / `dev.js` | Bun bundler → inlined `index.html` + zip package + PWA sidecars, and dev server |
| `INSTALL.md` | Step-by-step air-gapped installation guide (non-technical) |

## Security notes

- Self-custody software handling real keys — review the code before trusting it
  with funds, and prefer an offline machine for the seed phrase. It's a hot
  wallet (keys live in the browser); for large amounts use a hardware signer or
  run this air-gapped on a dedicated offline device.
- The seed/passphrase live in memory while the page is open and in
  sessionStorage for the tab session; locking or closing the tab clears them.
- The localStorage cache and the Nostr event hold public chain data (addresses,
  UTXOs, amounts); the Nostr copy is encrypted and keyed to your seed-derived
  identity, but a relay can see that an identity is publishing app data.
- Whichever block explorer you query sees your addresses and IP — point it at
  your own node for full privacy.
