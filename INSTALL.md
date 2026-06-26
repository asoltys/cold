# Installing Hal Wallet as an air-gapped signing device

This guide covers multiple ways to use Hal Wallet as an offline, air-gapped
Bitcoin signing device — on an old phone, a Raspberry Pi, an open-hardware
Linux phone, or just a laptop.

> **Core principle:** The device **never** connects to Wi-Fi, Bluetooth, or
> mobile data after setup. Transactions are signed in isolation and transferred
> via USB cable, SD card, or QR codes.

---

## Hardware air-gapping: removing radios

For maximum security, radios should be **physically** disabled so no malware
can re-enable them. Below are methods per device type, from least to most
destructive.

### Android phone

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Delete WiFi/BT driver files** (root) | Medium | High — survives factory reset | [XDA: Disable WiFi, Bluetooth, NFC on Android 13](https://xdaforums.com/t/disable-wifi-bluetooth-and-nfc-on-android-13.4501777/) |
| **Permanently disable WiFi** via driver removal (root) | Medium | High | [XDA: Permanently Disable WiFi Guide](https://xdaforums.com/t/root-guide-permanently-disable-wifi.3057599/) |
| **Disassemble & remove antenna flex cables** | Medium | Reversible | [iFixit: Android Phone Repair Guides](https://www.ifixit.com/Device/Android_Phone) — search your model |
| **Desolder WiFi/BT chip** | Advanced | Permanent | [Android SE: How to physically remove radio chips](https://android.stackexchange.com/questions/252608/how-do-i-physically-remove-the-radio-chips-on-a-phone) — note: SoC integration may make this impractical |

> **Recommendation for most users:** Root the phone, delete the WiFi/BT kernel
> modules, and never insert a SIM. This is difficult for an attacker to undo
> without physical access and a reflash.

### iPhone

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Supervised restriction profile** (Apple Configurator) | Medium | High — requires wipe to remove | [Apple Configurator: Create a restrictions profile](https://support.apple.com/guide/apple-configurator-mac/restrictions-cad8c1a1b4c/mac) — disable Wi-Fi, Bluetooth, cellular under "Restrictions" |
| **Remove Wi-Fi/BT antenna flex cable** (disassembly) | Advanced | Reversible | [iFixit: iPhone repair guides](https://www.ifixit.com/Device/iPhone) — search your model; simply leave the antenna disconnected |
| **Desolder Wi-Fi/BT chip** | Very advanced | Permanent | [Apple Discussions: Greyed-out WiFi/BT](https://discussions.apple.com/thread/254883421) — burning out the chip is effectively permanent |

> **Note:** iPhones are harder to fully airgap than Android. The **PinePhone**
> or **Raspberry Pi** options below are recommended instead if you need
> hardware-guaranteed isolation.

### Raspberry Pi / SBC (recommended for DIY)

Raspberry Pi is the easiest device to hardware-airgap — you have full control.

| Method | Difficulty | Permanence | Guide |
|--------|-----------|------------|-------|
| **Device-tree overlay** (disable at boot) | Easy | Reversible via SD card edit | [Disabling Wi-Fi and BT on Raspberry Pi](https://nemental.de/disabling-wi-fi-and-bluetooth-on-the-raspberry-pi/) — add `dtoverlay=disable-wifi,dtoverlay=disable-bt` to `/boot/firmware/config.txt` |
| **Kernel module blacklist** | Easy | Reversible | [PiSignage: Disabling Wi-Fi and BT](https://help.pisignage.com/hc/en-us/articles/52406458481817-Disabling-Wi-Fi-and-Bluetooth-on-Raspberry-Pi) — blacklist `brcmfmac`, `brcmutil`, `btbcm`, `hci_uart` |
| **Desolder WiFi/BT module** | Advanced | Permanent | [RPi SE: Desolder WiFi/BT module on Pi 4](https://raspberrypi.stackexchange.com/questions/114596/desolder-wifi-bluetooth-module-on-a-raspberry-pi-4) — the module sits under a metal shield |
| **Use a Pi without WiFi hardware** | Trivial | Hardware-forced | [RPi Zero 1.3 (no WiFi/BT)](https://thepihut.com/products/raspberry-pi-zero-1-3-with-pre-soldered-header-no-wifi-or-bluetooth) or [Pi 2 Model B](https://www.raspberrypi.com/products/raspberry-pi-2-model-b/) — no wireless built in |
| **Compute Module + custom carrier** | Advanced | Hardware-forced | [RPi CM4 without wireless](https://www.raspberrypi.com/products/compute-module-4/) — order the variant without WiFi |

> **Recommendation for most users:** Use `dtoverlay=disable-wifi` + `disable-bt`
> in config.txt plus kernel module blacklist. This prevents the OS from ever
> touching the radios. If you need stronger assurance, buy a Pi 2 (no WiFi
> hardware) or a Pi Zero 1.3 (no WiFi variant).

### PinePhone / Librem 5

These Linux phones have **hardware kill switches** — flick a physical switch to
cut power to the WiFi/BT/cellular modems. No software, no soldering needed.

- [PinePhone hardware kill switches diagram](https://wiki.pine64.org/wiki/PinePhone#Hardware_features)
- [Purism Librem 5 hardware kill switches](https://shop.puri.sm/shop/librem-5/)

---

## Requirements

- **Any device** with a modern browser that can open a local HTML file
  (`file://`). No server, no internet connection needed to run.
- A separate **online device** (phone, laptop, desktop) to broadcast signed
  transactions.
- A way to transfer small files between devices: USB cable, SD card, or QR
  codes.

If using a phone, **airplane mode must stay on permanently** after the wallet
is installed. Never reconnect to any network.

---

## Step 1 — Get the wallet app

### Option A: Pre-built (easiest)

The repository ships a ready-to-use `dist/index.html` — a single self-contained
file (~600 KB). No build tools needed.

```bash
# Clone the repo (or download just dist/ from GitHub)
git clone https://github.com/asoltys/halwallet.git
```

Open `dist/index.html` directly in your browser via `file://` — that's it.

### Option B: Build yourself

```bash
git clone https://github.com/asoltys/halwallet.git
cd halwallet

# Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

bun install
bun run build
```

The output is `dist/index.html` — exactly the same as Option A.

### Verify integrity

The single-file build lets you verify the app hasn't been tampered with:

```bash
shasum -a 256 dist/index.html
```

Compare the hash against a trusted source (e.g. a signed release tag).

---

## Step 2 — Transfer to the air-gapped device

Since the device will stay offline permanently, you must transfer files **before**
cutting it off from all networks.

| Method | Android | iPhone |
|--------|---------|--------|
| **USB cable** | MTP / Android File Transfer | Finder / iTunes file sharing |
| **SD card** | Insert SD → copy file | _Not available_ |
| **USB flash drive** | Via USB-C OTG adapter | Via Lightning/USB-C adapter |

> The `index.html` file contains **zero keys or secrets**. It is safe to
> transfer over any medium.

---

## Step 3 — Install as PWA (phone) or app (always offline)

### On Android

1. Copy `dist/index.html` to the phone (see Step 2).
2. Open it in Chrome (tap the file in Files → "Open in Chrome").
3. Chrome will prompt **"Install app"** or you can tap the three-dot menu →
   **Add to Home screen** / **Install app**.
4. After installation, the wallet launches as a standalone app with no browser
   chrome.
5. **Immediately enable airplane mode** and turn off Wi-Fi, Bluetooth, and
   mobile data. Verify no network icon shows in the status bar.
6. (Optional) Physically remove the SIM card for paranoia-level isolation.

### On iPhone

1. Copy `dist/index.html` to the iPhone via Finder/iTunes file sharing.
2. Open the Files app → locate `index.html` → tap it → it opens in Safari.
3. Tap the **Share** button (square with arrow) → **Add to Home Screen**.
4. After installation, the wallet launches as a standalone PWA.
5. **Enable airplane mode** immediately. Turn off Wi-Fi and Bluetooth from
   Settings. Verify no radios are active.
6. (Optional) Remove the SIM card.

### On a laptop / desktop

Just open `dist/index.html` with your browser via `file://`. No installation
needed. Disconnect from Wi-Fi after transfer. Close other tabs.

---

## Step 4 — Create your wallet (offline)

1. Open Hal Wallet on the air-gapped device.
2. Tap **Create new** → **Generate seed phrase**.
3. Write the 12 words down on paper (not a digital photo!). Store them safely.
4. Optionally set a **BIP39 passphrase** for an additional security layer.
5. Tap **Open wallet**.
6. Your wallet is ready. The balance shows 0 — the device is offline and hasn't
   scanned any network yet.

---

## Step 5 — Fund the wallet (using an online device)

1. On the air-gapped device, tap the **Receive** tab.
2. Copy the address shown (or scan its QR code with your online device).
3. Use an exchange, another wallet, or a friend to send Bitcoin to this address.

> Tap **"New address"** on the Receive tab to advance to the next unused address
> without requiring a payment on the current one.

---

## Step 6 — Export the snapshot (online device)

To spend, the offline device needs your coins and current fee rates:

1. On an **online device** (phone, laptop), open the same `dist/index.html`.
2. Enter your seed phrase (or import your xpub for watch-only).
3. Wait for the wallet to scan and show your balance.
4. Go to **Settings** → **Offline transfer** → **Export snapshot**.
5. Save the JSON file. It contains **no private keys** — only your UTXOs,
   addresses, and fee rate estimates.

The snapshot also includes any **transaction labels** (BIP-329 format) you have
set. Labels are preserved through export → import.

---

## Step 7 — Import the snapshot (offline device)

1. Transfer the snapshot JSON to the air-gapped device (USB, SD card, QR).
2. On the air-gapped device, go to **Settings** → **Offline transfer** →
   **Import snapshot**.
3. If the network doesn't match, switch networks in **Settings** → **Network**
   first, then import.

The offline device now shows your coins and labels, and can sign.

---

## Step 8 — Sign and broadcast

1. On the air-gapped device, go to **Send**.
2. Fill in the recipient and amount.
3. Review → **Sign transaction**.
4. The wallet presents the signed transaction as hex text and a QR code.
5. Transfer the signed transaction to the online device (USB, SD card, or scan
   the QR code).
6. Broadcast it at `https://mempool.space/tx/broadcast` or any block explorer.

---

## Network switching

Supports **Mainnet**, **Testnet**, **Testnet4**, **Signet**, **Regtest**.
Switch in **Settings** → **Network**. Imported snapshots must match the
current network.

---

## Label export/import (BIP-329)

Transaction labels can be exported as a BIP-329 JSON file and imported on
another device:

- **Export:** Settings → **Transaction labels** → **Export labels**
- **Import:** Settings → **Transaction labels** → **Import labels**

Labels are also embedded in wallet snapshots automatically (v2 format), so
they carry over through the snapshot workflow too.

---

## DIY & open-source hardware alternatives

Hal Wallet runs anywhere a browser runs. This opens up many hardware options
beyond repurposed phones.

### Recommended: Single-board computer + touchscreen

A Raspberry Pi (or similar) with a small display makes an excellent dedicated
signing device — no SIM, no microphone, no cellular baseband.

| Board | Approx. cost | Notes |
|-------|-------------|-------|
| **Raspberry Pi Zero 2 W** | $15 | Very low power; small display via GPIO |
| **Raspberry Pi 4 / 5** | $35–60 | Fast; official 7" touchscreen works well |
| **Orange Pi Zero 2** | $25 | Allwinner H616; runs Chromium |
| **Banana Pi M5** | $50 | Amlogic S905X3; 4 GB RAM |

**Setup:**

```
# Install Raspberry Pi OS Lite, then:
sudo apt install chromium-browser matchbox-window-manager xinit

# Auto-start Chromium in kiosk mode on boot (no network required):
echo 'matchbox-window-manager & chromium-browser --kiosk /home/pi/halwallet/dist/index.html' > ~/.xinitrc
startx
```

- Copy the `dist/` folder via SD card — **never connect Ethernet or Wi-Fi**.
- Use the browser's **Add to Home Screen** / PWA install for a chrome-less
  experience if available, or stick with `--kiosk`.

### Open-hardware Linux phones

These phones respect your privacy with hardware kill switches and fully
open-source firmware. Hal Wallet runs in their browser with no modifications.

| Device | Cost | Key feature |
|--------|------|-------------|
| **PinePhone** / **PinePhone Pro** | $150–200 | Hardware kill switches for Wi-Fi/Bluetooth/modem. Run Mobian, postmarketOS, or Manjaro. |
| **Purism Librem 5** | $1,200+ | PureOS; hardware kill switches for cameras, mic, baseband, Wi-Fi/Bluetooth. Made for privacy. |

**Setup:** Same as any Linux device — copy `dist/index.html`, open in Firefox
or Chromium via `file://`. Flick the hardware kill switches to disable all
radios permanently.

### Why not a dedicated hardware wallet instead?

Commercial hardware wallets (Trezor, ColdCard, Jade, BitBox, Ledger) are great
and more convenient. But Hal Wallet on DIY hardware gives you:

- **Full transparency** — the entire wallet is a single HTML file you can audit
  and verify.
- **No vendor lock-in** — no proprietary firmware, no USB drivers, no company
  servers.
- **No attack surface** — no Bluetooth, no USB HID, no firmware updates, no
  vendor SDK.
- **Cost** — a $15 Raspberry Pi Zero + salvaged display is cheaper than any
  hardware wallet.
- **All networks** — testnet, signet, regtest work identically to mainnet.

---

## Tips for air-gapped use

- **Label transactions** in History → tap a tx → enter a label. Export/import
  labels via Settings or wallet snapshots.
- **Generate fresh addresses** with the "New address" button for privacy.
- **Enable dark mode** in the footer for OLED screens.
- **Switch to sats** by tapping the unit label.
- Test the workflow on **Testnet** or **Signet** before mainnet.

---

## Security model

- Keys exist only in browser memory and sessionStorage. Locking or closing the
  tab clears them.
- The offline device never connects to any network after setup.
- The snapshot contains only public data (addresses, UTXOs, labels).
- The single `dist/index.html` file can be verified with `shasum` before each
  use.
- No USB HID, no Bluetooth, no firmware updates, no vendor dependency.
