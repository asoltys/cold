# Bitcoin Wallet

A self-contained, **single-file** Bitcoin wallet that runs entirely in the
browser. Think bitaddress.org, but a modern BIP84 HD wallet built from a seed
phrase, able to scan history, fetch UTXOs, and spend — online or fully offline.

- **BIP84 / native SegWit (p2wpkh)** HD wallet from a 12/24-word BIP39 seed
  (optional passphrase).
- **HD scanning** with the standard gap limit across the receive (`…/0/i`) and
  change (`…/1/i`) chains — real aggregate balance, fresh addresses, and
  transaction history via [mempool.space](https://mempool.space).
- **Spending** with proper coin selection + fee estimation
  (`@scure/btc-signer`'s `selectUTXO`), a fee-rate picker, send-max, and
  **manual coin control**.
- **Fresh addresses** for receiving and for change — no address reuse.
- **Offline mode**: import UTXOs from a JSON snapshot (fetched on an online
  device), sign locally, and export the signed transaction (hex / file / QR) to
  broadcast elsewhere. No network calls are made.
- **Runs offline from `file://`** — keys never leave the page; nothing is sent
  anywhere except, when online, read-only requests + a broadcast to
  mempool.space.

Built with the modern audited [`@scure`](https://github.com/paulmillr/scure-btc-signer)
/ [`@noble`](https://github.com/paulmillr/noble-hashes) libraries. Pure JS: no
`crypto.subtle`, so it works from the filesystem with no server.

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

`dist/index.html` inlines all code, the crypto libraries, the QR generator, and
the CSS. **To use it offline: save that one file and open it directly in a
browser** — no server, no internet.

## Using it offline (air-gapped spending)

1. **Online device** (with internet): open the wallet, let it scan, then go to
   **Tools → Export snapshot**. This downloads a JSON file of your UTXOs and fee
   rates. It contains **no keys**.
2. Move the file to your **offline device** (e.g. an air-gapped laptop running
   the saved `index.html`).
3. On the offline device, open the wallet, enter your **seed phrase** with
   *Offline mode* checked, then **Tools → Import snapshot**.
4. Build and **sign** a transaction. Copy/download the signed hex (or scan the
   QR) and broadcast it from any online device (e.g. mempool.space → Broadcast).

## Layout

| File | Purpose |
| --- | --- |
| `src/wallet.js` | BIP84 derivation, scanning, coin selection, signing, snapshots |
| `src/api.js` | mempool.space REST wrapper (the single network choke-point) |
| `src/app.js` | UI controller (vanilla DOM) |
| `src/qr.js` | QR → SVG (zero-dep) |
| `src/format.js` | sat/BTC formatting helpers |
| `src/style.css` | Hand-rolled styles |
| `build.js` / `dev.js` | Bun bundler → single inlined `index.html`, and dev server |

## Security notes

- This is self-custody software handling real keys — review the code before
  trusting it with funds, and prefer an offline machine for the seed phrase.
- Mainnet and testnet are both supported (select on the unlock screen).
- The seed phrase and passphrase live only in memory while the page is open;
  locking or closing the tab clears them.
