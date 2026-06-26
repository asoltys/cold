# Installing Hal Wallet as an air-gapped signing device

- [Quick start (3 steps)](#quick-start-3-steps)
- [What you need](#what-you-need)
- [Step 1 — Download the wallet](#step-1--download-the-wallet)
- [Step 2 — Transfer to your offline device](#step-2--transfer-to-your-offline-device)
- [Step 3 — Install the app](#step-3--install-the-app)
- [Step 4 — Create your wallet](#step-4--create-your-wallet)
- [Step 5 — Fund the wallet](#step-5--fund-the-wallet)
- [Step 6 — Export the snapshot (online)](#step-6--export-the-snapshot-online)
- [Step 7 — Import the snapshot (offline)](#step-7--import-the-snapshot-offline)
- [Step 8 — Sign and broadcast](#step-8--sign-and-broadcast)
- [Useful features](#useful-features)
- [Tips](#tips)
- [Security model](#security-model)
- [Appendix: Hardware air-gapping](#appendix-hardware-air-gapping)

---

## Quick start (3 steps)

1. **Download** the latest `Halwallet.zip` from the [releases page](https://github.com/asoltys/halwallet/releases) and unzip it.
2. **Transfer** the `dist/` folder (or just `index.html`) to your offline device via USB cable or SD card.
3. **Open** `index.html` in your browser — done. No installation needed.

That's it. The wallet runs entirely in the browser from a single file. No server, no internet, no setup required after transfer.

---

## What you need

- **An old phone, laptop, or tablet** that will stay offline forever. Any device with a browser works (Android, iPhone, Windows, Mac, Linux).
- **A separate online device** (your regular phone or computer) to check balances and broadcast signed transactions.
- **A USB cable or SD card** to transfer files between the two devices once.

That's all. No technical skills required.

---

## Step 1 — Download the wallet

You have three options. Pick the easiest one:

### Option A: Download the release zip (easiest)

Go to the [releases page](https://github.com/asoltys/halwallet/releases) and download `Halwallet.zip`. Unzip it — you'll get a folder called `dist/` with `index.html` inside.

### Option B: Clone the repository

```bash
git clone https://github.com/asoltys/halwallet.git
```

The pre-built wallet is at `halwallet/dist/index.html` — ready to use, no build step needed.

### Option C: Build it yourself (advanced)

```bash
git clone https://github.com/asoltys/halwallet.git
cd halwallet
curl -fsSL https://bun.sh/install | bash
bun install
bun run build
```

The output is `dist/index.html` — the same file as Option A.

### Verify the file (optional)

You can check the wallet hasn't been tampered with:

```bash
shasum -a 256 dist/index.html
```

Compare the hash against the signed release on GitHub.

---

## Step 2 — Transfer to your offline device

Copy the `dist/` folder (or just `index.html`) to your offline device **before** disconnecting it from the internet.

| Method | Android | iPhone | Computer |
|--------|---------|--------|----------|
| **USB cable** | Plug in → copy file like a USB drive | Use Finder (Mac) or iTunes (Windows) | Drag to a folder |
| **SD card** | Insert card → copy file | Not available | Insert card → copy file |
| **USB stick** | Via USB-C adapter | Via Lightning adapter | Plug in → copy file |

> The `index.html` file contains **no keys or secrets** — it's safe to transfer over any medium.

---

## Step 3 — Install the app

### On Android

1. Copy `index.html` to your phone (see Step 2).
2. Open it in **Chrome** (tap the file in Files → "Open in Chrome").
3. Chrome will ask **"Install app"** — tap yes. Or tap the three-dot menu → **Add to Home screen**.
4. The wallet now opens as a standalone app with no browser buttons.
5. **Turn on airplane mode immediately.** Switch off Wi-Fi, Bluetooth, and mobile data.
6. (Optional) Remove the SIM card for extra safety.

### On iPhone

1. Copy `index.html` to your iPhone via Finder (Mac) or iTunes (Windows).
2. Open the **Files** app → find `index.html` → tap it → opens in Safari.
3. Tap the **Share** button (square with arrow) → **Add to Home Screen**.
4. The wallet now opens as a standalone app.
5. **Turn on airplane mode immediately.** Switch off Wi-Fi and Bluetooth in Settings.
6. (Optional) Remove the SIM card.

### On a computer

Just open `index.html` in your browser. No installation needed. Disconnect from Wi-Fi after transferring the file.

---

## Step 4 — Create your wallet

1. Open Hal Wallet on your offline device.
2. Tap **Create new** → **Generate seed phrase**.
3. **Write down the 12 words on paper.** Never store them digitally (no photos, no screenshots, no cloud).
4. Store the paper somewhere safe.
5. (Optional) Add a **passphrase** for extra security — like a password for your seed.
6. Tap **Open wallet**.

Your balance shows 0 because the device is offline. That's normal.

---

## Step 5 — Fund the wallet

1. On your offline device, tap the **Receive** tab.
2. Copy the address shown, or scan the QR code with your online device.
3. Send Bitcoin to this address from an exchange, another wallet, or a friend.

> Tap **"New address"** for a fresh one. You can also switch to **Silent Payment** mode — this gives you a reusable `sp1…` address that never changes, and senders automatically generate unique on-chain addresses for each payment.

---

## Step 6 — Export the snapshot (online)

To spend, your offline device needs to know about your coins and current fees:

1. On your **online device**, open the wallet (`index.html`).
2. Enter your seed phrase to load your wallet.
3. Wait for the balance to appear (it will scan the blockchain).
4. Go to **Settings** → **Offline transfer** → **Export snapshot**.
5. Save the JSON file. **It contains no private keys** — only your addresses, coins, and fee rates.

The snapshot also includes any transaction labels you've added.

---

## Step 7 — Import the snapshot (offline)

1. Transfer the snapshot file to your offline device (USB, SD card, or QR).
2. On the offline device, go to **Settings** → **Offline transfer** → **Import snapshot**.
3. If the network doesn't match, switch it in **Settings** → **Network** first.

Your offline device now shows your balance and can sign transactions.

---

## Step 8 — Sign and broadcast

1. On your offline device, go to **Send**.
2. Enter the recipient address and amount.
3. Tap **Review** → **Sign transaction**.
4. The wallet shows the signed transaction as text and a QR code.
5. Transfer it to your online device (USB, SD card, scan the QR).
6. Broadcast it at [mempool.space](https://mempool.space/tx/broadcast) or any block explorer.

---

## Useful features

### Silent Payments (BIP-352)

- **Send** to any `sp1…` / `tsp1…` address — the wallet automatically derives a unique one-time taproot output.
- **Receive** — switch to Silent Payment mode in the Receive tab. Share your `sp1…` address publicly. Scan blocks periodically in **Settings** → **Silent Payments** to detect incoming payments.
- Silent payments never reuse on-chain addresses, even though you share the same address publicly.

### Transaction labels

Add a label (e.g. "coffee with Alice") to any transaction in History → tap a tx → enter a label. Labels survive across sessions and are included in snapshot exports.

### Label export/import (BIP-329)

Export labels as a standard JSON file in **Settings** → **Transaction labels** → **Export labels**. Import on another device. Also included in snapshots automatically.

### Per-address rescan

If a payment was sent to an old (reused) address and isn't showing up, go to **Settings** → **Rescan** → **Rescan an address**. Each address has its own Rescan button. Use **"Scan X more"** to extend the address pool during recovery.

### Scan from a past date

When importing a wallet, open **Advanced options** to set a **gap limit** (how many unused addresses to check) and a **scan from date** — useful for recovering wallets with old activity.

---

## Tips

- **Test on Testnet first** — switch to Testnet in Settings and practice the full workflow before using real bitcoin.
- **Use dark mode** — tap the moon icon in the footer (saves battery on OLED screens).
- **Switch to sats** — tap any amount to toggle between bitcoin and satoshis.
- **Generate fresh addresses** with the "New address" button for better privacy.
- **Check for silent payments** — if you share your silent payment address publicly, scan blocks occasionally in Settings to detect incoming payments.
- **Disconnect Wi-Fi after setup** — once the wallet is installed, keep the device offline permanently.

---

## Security model

- Your seed phrase exists only in browser memory. Locking or closing the tab clears it.
- The offline device never connects to the internet.
- The snapshot contains only public data — no private keys.
- The single `index.html` file can be verified with `shasum` before each use.
- No Bluetooth, no USB HID, no firmware updates, no vendor dependency.

---

## Appendix: Hardware air-gapping

*This section is for advanced users who want to physically disable radios for maximum security. Most people can skip this — airplane mode is sufficient.*

For maximum security, radios should be **physically** disabled so no malware can re-enable them. Below are methods per device type, from least to most destructive.

### Android phone

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Delete WiFi/BT driver files** (root) | Medium | High — survives factory reset | [XDA: Disable WiFi, Bluetooth, NFC on Android 13](https://xdaforums.com/t/disable-wifi-bluetooth-and-nfc-on-android-13.4501777/) |
| **Permanently disable WiFi** via driver removal (root) | Medium | High | [XDA: Permanently Disable WiFi Guide](https://xdaforums.com/t/root-guide-permanently-disable-wifi.3057599/) |
| **Disassemble & remove antenna flex cables** | Medium | Reversible | [iFixit: Android Phone Repair Guides](https://www.ifixit.com/Device/Android_Phone) — search your model |
| **Desolder WiFi/BT chip** | Advanced | Permanent | [Android SE: How to physically remove radio chips](https://android.stackexchange.com/questions/252608/how-do-i-physically-remove-the-radio-chips-on-a-phone) |

> **Recommendation for most users:** Root the phone, delete the WiFi/BT kernel modules, and never insert a SIM. This is difficult for an attacker to undo without physical access.

### iPhone

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Supervised restriction profile** (Apple Configurator) | Medium | High — requires wipe to remove | [Apple Configurator: Create a restrictions profile](https://support.apple.com/guide/apple-configurator-mac/restrictions-cad8c1a1b4c/mac) |
| **Remove Wi-Fi/BT antenna flex cable** (disassembly) | Advanced | Reversible | [iFixit: iPhone repair guides](https://www.ifixit.com/Device/iPhone) — search your model |
| **Desolder Wi-Fi/BT chip** | Very advanced | Permanent | [Apple Discussions: Greyed-out WiFi/BT](https://discussions.apple.com/thread/254883421) |

> **Note:** iPhones are harder to fully airgap than Android. The **PinePhone** or **Raspberry Pi** options below are recommended instead.

### Raspberry Pi / SBC (recommended for DIY)

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Device-tree overlay** (disable at boot) | Easy | Reversible via SD card edit | Add `dtoverlay=disable-wifi,dtoverlay=disable-bt` to `/boot/firmware/config.txt` |
| **Kernel module blacklist** | Easy | Reversible | Blacklist `brcmfmac`, `brcmutil`, `btbcm`, `hci_uart` |
| **Desolder WiFi/BT module** | Advanced | Permanent | The module sits under a metal shield on Pi 4 |
| **Use a Pi without WiFi hardware** | Trivial | Hardware-forced | [RPi Zero 1.3](https://thepihut.com/products/raspberry-pi-zero-1-3-with-pre-soldered-header-no-wifi-or-bluetooth) (no WiFi/BT) or [Pi 2 Model B](https://www.raspberrypi.com/products/raspberry-pi-2-model-b/) |

> **Recommendation:** Use `dtoverlay=disable-wifi` + `disable-bt` in config.txt plus kernel module blacklist. For stronger assurance, buy a Pi 2 (no WiFi hardware) or Pi Zero 1.3.

### PinePhone / Librem 5

These Linux phones have **hardware kill switches** — flick a physical switch to cut power to the WiFi/BT/cellular modems. No software, no soldering needed.

- [PinePhone hardware kill switches](https://wiki.pine64.org/wiki/PinePhone#Hardware_features)
- [Purism Librem 5](https://shop.puri.sm/shop/librem-5/)
