// Bitcoin Wallet — UI controller (vanilla DOM, no framework).
//
// State lives in `ui` + the singleton `wallet`. Mutating handlers call render(),
// which rebuilds the active screen. Text inputs write back into `ui` on `input`
// (without re-rendering) so their values survive structural re-renders.

import { Wallet, newMnemonic, isValidMnemonic, utxoId } from './wallet.js';
import { qrSvg } from './qr.js';
import { scanQr } from './scan.js';
import { getSyncConfig, setSyncConfig } from './nostr.js';
import { getExplorerConfig, setExplorerConfig, EXPLORER_PRESETS } from './api.js';
import { t, LANGS, getLang, setLang, isRTL, loadLocale } from './i18n.js';
import {
  fmtBtc,
  fmtSats,
  parseAmount,
  shortAddr,
  shortTxid,
  timeAgo,
  SATS,
} from './format.js';

const wallet = new Wallet();

const ui = {
  screen: 'unlock', // 'unlock' | 'wallet' | 'howItWorks'
  returnScreen: 'unlock', // where 'howItWorks' returns to (Back / logo)
  unlockTab: 'create', // 'create' | 'import'
  createStep: 'gen', // 'gen' | 'confirm'
  draftMnemonic: '',
  confirm: [], // [{ index, value }]
  confirmPass: '', // re-entered passphrase on the verify step
  importText: '',
  passphrase: '',
  showPass: false,
  revealShown: false, // recovery phrase unmasked on the Backup tab (after the warning)
  offlineFallback: false, // auto-entered offline because the network was unreachable
  unlockError: '',

  tab: 'receive', // receive | send | history | settings
  receiveSeenIndex: null, // fresh receive index the user has acknowledged
  txDetail: null, // txid being viewed in the history detail view
  send: blankSend(),
  draft: null, // built tx summary awaiting review
  broadcastTx: null, // scanned signed tx awaiting broadcast confirmation
  bump: null, // RBF bump in progress: { prep, feeChoice, customFee }
  sendError: '',
  sendResult: null, // { txid } | { signedHex, txid }
  busy: false,
};

function blankSend() {
  return {
    recipients: [{ address: '', amount: '' }],
    unit: 'btc',
    max: false,
    feeChoice: 'halfHourFee',
    customFee: '',
    manual: false,
    coins: new Set(),
  };
}

// ---------------------------------------------------------------- DOM helper
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') e[k] = !!v;
    else if (k.startsWith('on') && typeof v === 'function')
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === true) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const root = document.getElementById('app');
function footer() {
  return h(
    'div',
    { class: 'footer small muted center' },
    h(
      'div',
      {},
      t('footerMadeBy') + ' ',
      h('a', { href: 'https://adamsoltys.com', target: '_blank', rel: 'noopener' }, 'Adam Soltys'),
      h('span', { class: 'faint' }, ' · '),
      t('footerSourceOn') + ' ',
      h('a', { href: 'https://github.com/asoltys/halwallet', target: '_blank', rel: 'noopener' }, 'GitHub')
    ),
    h(
      'div',
      { style: 'margin-top:4px' },
      h('button', { class: 'linklike', style: 'font-weight:400', onClick: openHowItWorks }, t('howItWorks')),
      // Chrome no longer prompts to install on its own — surface our own link
      // once it reports the app is installable (beforeinstallprompt fired).
      installPrompt
        ? h('span', {}, h('span', { class: 'faint' }, ' · '),
            h('button', { class: 'linklike', style: 'font-weight:400', onClick: triggerInstall }, t('installApp')))
        : null
    )
  );
}

// PWA install. Chrome fires beforeinstallprompt when the app qualifies; we stash
// the event and reveal an "Install app" link, then replay it on a user tap (the
// browser requires a gesture). beforeinstallprompt only fires when not already
// installed, so the link naturally hides once installed.
let installPrompt = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    render();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    render();
  });
}
async function triggerInstall() {
  const e = installPrompt;
  if (!e) return;
  installPrompt = null;
  render();
  e.prompt();
  try {
    await e.userChoice;
  } catch {}
}

// Open the How it works page, remembering where to return to.
function openHowItWorks() {
  if (ui.screen === 'howItWorks') return;
  ui.returnScreen = ui.screen;
  ui.screen = 'howItWorks';
  render();
}

function render() {
  const screen =
    ui.screen === 'wallet'
      ? walletScreen()
      : ui.screen === 'howItWorks'
        ? howItWorksScreen()
        : unlockScreen();
  root.replaceChildren(screen, footer());
}
wallet.subscribe(render);

// ---------------------------------------------------------------- utilities
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = h('div', { class: 'toast' });
    document.body.append(t);
  }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  toast(t('copied'));
}

function download(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyBtn(text, label = t('copy')) {
  return h('button', { class: 'btn-sm', onClick: () => copy(text) }, label);
}

// ---------------------------------------------------------------- display unit
// Global BTC/sats preference, persisted in localStorage across refreshes and
// logouts. Every unit label on the site is clickable to toggle it.
const UNIT_KEY = 'btc-wallet-unit';
let unit = (() => {
  // Default to sats for first-time users; only an explicit 'btc' choice sticks.
  try {
    return localStorage.getItem(UNIT_KEY) === 'btc' ? 'btc' : 'sats';
  } catch {
    return 'sats';
  }
})();

function toggleUnit() {
  unit = unit === 'btc' ? 'sats' : 'btc';
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {}
  render();
}

const unitLabel = () => (unit === 'sats' ? 'sats' : 'BTC');
const fmtAmount = (sats) => (unit === 'sats' ? fmtSats(sats) : fmtBtc(sats));

// A clickable unit label. cls lets callers inherit surrounding sizing.
function unitTag(cls = '') {
  return h('button', { type: 'button', class: 'unit-tag ' + cls, title: t('switchUnit'), onClick: toggleUnit }, unitLabel());
}

// ================================================================ UNLOCK
function unlockScreen() {
  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    brandHeader(false),
    h(
      'div',
      { class: 'card col' },
      h(
        'div',
        { class: 'tabs' },
        tabBtn(t('createNew'), ui.unlockTab === 'create', () => {
          ui.unlockTab = 'create';
          render();
        }),
        tabBtn(t('importExisting'), ui.unlockTab === 'import', () => {
          ui.unlockTab = 'import';
          render();
        })
      ),
      ui.unlockTab === 'create' ? createPane() : importPane(),
      ui.unlockError && h('div', { class: 'notice err' }, ui.unlockError)
    )
  );
}

// ================================================================ HOW IT WORKS
function howItWorksScreen() {
  const back = () => {
    ui.screen = ui.returnScreen === 'wallet' ? 'wallet' : 'unlock';
    render();
  };
  const para = (key) => h('p', { class: 'muted', style: 'margin:0' }, ...linkify(t(key)));
  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    brandHeader(false),
    h(
      'div',
      { class: 'card col', style: 'gap:14px' },
      h('h3', {}, t('hiwBasicsTitle')),
      para('hiwBasics1'),
      para('hiwBasics2'),
      para('hiwBasics3'),
      para('hiwBasics4'),
      para('hiwBasics5'),
      h('p', { class: 'small muted hiw-tribute', style: 'margin:0' }, ...linkify(t('hiwTribute')))
    ),
    h('button', { class: 'btn-block', onClick: back }, t('back'))
  );
}

// Turn known tokens (e.g. mempool.space) into links within a plain string,
// returning an array of text + anchor nodes. Keeps i18n strings link-free.
const HIW_LINKS = [
  ['mempool.space', 'https://mempool.space'],
  ['Hal Finney', 'https://en.wikipedia.org/wiki/Hal_Finney_(computer_scientist)'],
];
function linkify(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + HIW_LINKS.map(([tok]) => esc(tok)).join('|') + ')', 'g');
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const href = HIW_LINKS.find(([tok]) => tok === m[0])[1];
    out.push(h('a', { href, target: '_blank', rel: 'noopener' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function tabBtn(label, active, onClick) {
  return h('button', { class: active ? 'active' : '', onClick }, label);
}

function createPane() {
  if (ui.createStep === 'gen') {
    if (!ui.draftMnemonic) {
      return h(
        'div',
        { class: 'col' },
        h('p', { class: 'muted' }, t('genIntro')),
        h(
          'button',
          {
            class: 'btn-primary btn-block',
            onClick: () => {
              ui.draftMnemonic = newMnemonic();
              render();
            },
          },
          t('generateSeed')
        )
      );
    }
    const words = ui.draftMnemonic.split(' ');
    return h(
      'div',
      { class: 'col' },
      h('div', { class: 'warn-box' }, t('writeDownWarn')),
      h(
        'div',
        { class: 'words' },
        words.map((w, i) =>
          h('div', { class: 'w' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't' }, w))
        )
      ),
      h(
        'div',
        { class: 'row gap6' },
        copyBtn(ui.draftMnemonic, t('copyPhrase')),
        h(
          'button',
          {
            class: 'btn-ghost btn-sm',
            onClick: () => {
              ui.draftMnemonic = newMnemonic();
              render();
            },
          },
          t('regenerate')
        )
      ),
      optionsPanel(),
      h(
        'button',
        {
          class: 'btn-primary btn-block',
          onClick: () => {
            ui.confirm = pickConfirm(words);
            ui.confirmPass = '';
            ui.unlockError = '';
            ui.createStep = 'confirm';
            render();
          },
        },
        t('verifyBackup')
      ),
      h(
        'button',
        { class: 'btn-block', onClick: () => openWallet(ui.draftMnemonic) },
        t('skipVerification')
      )
    );
  }

  // confirm step (optional — reachable via "Verify backup")
  const hasPass = !!ui.passphrase;
  return h(
    'div',
    { class: 'col' },
    h('p', { class: 'muted' }, t('confirmBackupIntro')),
    ...ui.confirm.map((c, i) =>
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'lab' }, t('wordN', { n: c.index + 1 })),
        h('input', {
          type: 'text',
          class: 'mono-input',
          autocapitalize: 'none',
          autocomplete: 'off',
          spellcheck: 'false',
          value: c.value,
          onInput: (e) => (ui.confirm[i].value = e.target.value.trim()),
        })
      )
    ),
    // Only verify the passphrase if one was actually entered.
    hasPass &&
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'lab' }, t('reenterPassphrase')),
        h('input', {
          type: 'password',
          class: 'mono-input',
          autocomplete: 'off',
          value: ui.confirmPass,
          onInput: (e) => (ui.confirmPass = e.target.value),
        })
      ),
    h('div', { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.createStep = 'gen'; render(); } }, t('back')),
      h('button', {
        class: 'btn-primary grow',
        onClick: () => {
          const words = ui.draftMnemonic.split(' ');
          const ok = ui.confirm.every((c) => c.value.toLowerCase() === words[c.index]);
          if (!ok) { ui.unlockError = t('wordsMismatch'); render(); return; }
          if (hasPass && ui.confirmPass !== ui.passphrase) {
            ui.unlockError = t('passphraseMismatch'); render(); return;
          }
          openWallet(ui.draftMnemonic);
        },
      }, t('openWallet'))
    ),
    h('button', { class: 'btn-block', onClick: () => openWallet(ui.draftMnemonic) }, t('skipVerification'))
  );
}

function pickConfirm(words) {
  const idx = new Set();
  while (idx.size < 3) idx.add(Math.floor(Math.random() * words.length));
  return [...idx].sort((a, b) => a - b).map((index) => ({ index, value: '' }));
}

function importPane() {
  return h(
    'div',
    { class: 'col' },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'lab' }, t('seedPhrase')),
      h('textarea', {
        placeholder: t('seedPlaceholder'),
        autocapitalize: 'none',
        autocomplete: 'off',
        spellcheck: 'false',
        value: ui.importText,
        onInput: (e) => (ui.importText = e.target.value),
      })
    ),
    optionsPanel(),
    h('button', { class: 'btn-primary btn-block', onClick: () => openWallet(ui.importText) }, t('openWallet'))
  );
}

function optionsPanel() {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'lab' }, t('passphrase')),
    h(
      'div',
      { class: 'input-group' },
      h('input', {
        type: ui.showPass ? 'text' : 'password',
        class: 'mono-input',
        autocomplete: 'off',
        value: ui.passphrase,
        onInput: (e) => (ui.passphrase = e.target.value),
      }),
      h('button', { class: 'btn-sm', type: 'button', onClick: () => { ui.showPass = !ui.showPass; render(); } }, ui.showPass ? t('hide') : t('show'))
    )
  );
}

async function openWallet(mnemonic) {
  ui.unlockError = '';
  const m = (mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!isValidMnemonic(m)) {
    ui.unlockError = t('invalidSeed');
    render();
    return;
  }
  await enterWallet(m, ui.passphrase);
}

// Load a wallet and start scanning. Persists to sessionStorage so a refresh
// restores the open wallet (cleared on logout or when the tab closes).
async function enterWallet(mnemonic, passphrase) {
  wallet.load({ mnemonic, passphrase, netName: 'mainnet', offline: false });
  persistSession(mnemonic, passphrase);
  const hadCache = wallet.restoreCache(); // show last-known balance/history instantly
  ui.screen = 'wallet';
  ui.tab = 'receive';
  // Not baselined yet — stays null until the scan + ack logic below sets it,
  // so the celebration never fires for payments that were already there at
  // import (the index only looks "advanced" because the scan hadn't run yet).
  ui.receiveSeenIndex = null;
  ui.send = blankSend();
  ui.draft = null;
  ui.sendResult = null;
  ui.offlineFallback = false;
  render();

  // No manual offline switch: try to scan, and if the network is unreachable,
  // fall back to offline mode automatically.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    enterOfflineFallback();
    return;
  }
  try {
    // Cross-device state: pull the latest from Nostr (may supply state on a
    // device with no local cache, or a newer copy from another device).
    const hadNostr = await wallet.syncFromNostr();
    // Always do a full scan to fully reconcile (balance, history confirmations,
    // spends, stale cache/relay state). Cache/Nostr just gave us something to
    // show instantly; a partial frontier-only refresh leaves the state stale and
    // would let the celebration baseline before a known payment is even counted.
    await wallet.scan({ silent: hadCache || hadNostr });
    // Persisted acknowledgement: first time, baseline to the current index so we
    // don't celebrate historical payments. After that, any advance beyond the
    // acknowledged index shows the celebration (and survives refreshes).
    let ack = wallet.getReceiveAck();
    if (ack == null) {
      ack = wallet.nextReceiveIndex;
      wallet.setReceiveAck(ack);
    }
    ui.receiveSeenIndex = ack;
    wallet.startRealtime();
  } catch {
    enterOfflineFallback();
  }
}

const SESSION_KEY = 'btc-wallet-session';

function persistSession(mnemonic, passphrase) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ mnemonic, passphrase }));
  } catch {}
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

// Restore an open wallet after a page refresh (same tab session only).
function restoreSession() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {}
  if (saved && saved.mnemonic && isValidMnemonic(saved.mnemonic)) {
    enterWallet(saved.mnemonic, saved.passphrase || '');
    return true;
  }
  return false;
}

function enterOfflineFallback() {
  wallet.setOffline(true);
  wallet.deriveWindow(40);
  ui.offlineFallback = true;
  ui.tab = 'settings';
  render();
}

async function retryOnline() {
  ui.offlineFallback = false;
  wallet.setOffline(false);
  ui.tab = 'receive';
  render();
  try {
    await wallet.scan();
    wallet.startRealtime();
  } catch {
    enterOfflineFallback();
  }
}

function lock() {
  wallet.stopRealtime();
  clearSession();
  wallet.load({ mnemonic: '', passphrase: '', netName: 'mainnet', offline: false });
  wallet.mnemonic = '';
  ui.screen = 'unlock';
  ui.createStep = 'gen';
  ui.draftMnemonic = '';
  ui.importText = '';
  ui.passphrase = '';
  ui.confirm = [];
  ui.revealShown = false;
  ui.receiveSeenIndex = null;
  ui.txDetail = null;
  ui.broadcastTx = null;
  ui.bump = null;
  render();
}

// ================================================================ WALLET
function brandHeader(withLock) {
  return h(
    'div',
    { class: 'row between' },
    h(
      'div',
      { class: 'brand', style: 'cursor:pointer', title: t('home'), onClick: goHome },
      h('div', { class: 'logo' }, '₿'),
      h('h1', {}, t('appTitle'))
    ),
    withLock && h('button', { class: 'btn-sm', onClick: lock }, t('logout'))
  );
}

// Settings tab — view the recovery phrase (+ passphrase) again (important for
// users who skipped backup verification) and the offline snapshot transfer.
// The phrase is gated: the real words are never put in the DOM until "Reveal",
// so the warning is read first.
function settingsTab() {
  const shown = ui.revealShown;
  const words = wallet.mnemonic.split(' ');
  const cells = words.map((w, i) =>
    h('div', { class: 'w' + (shown ? '' : ' masked') },
      h('span', { class: 'n' }, i + 1),
      h('span', { class: 't' }, shown ? w : '••••••')
    )
  );

  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, t('recoveryPhrase')),
      h('div', { class: 'warn-box' }, t('recoveryWarn')),
      h('div', { class: 'words' }, cells),
      shown && wallet.passphrase
        ? h('div', { class: 'col gap6' },
            h('span', { class: 'lab' }, t('bip39Passphrase')),
            h('div', { class: 'addr-box' }, wallet.passphrase)
          )
        : null,
      shown
        ? h('div', { class: 'row gap6 wrap' },
            copyBtn(wallet.mnemonic, t('copyPhrase')),
            wallet.passphrase ? copyBtn(wallet.passphrase, t('copyPassphrase')) : null,
            h('button', { class: 'btn-sm grow', onClick: () => { ui.revealShown = false; render(); } }, t('hide'))
          )
        : h('button', { class: 'btn-primary btn-block', onClick: () => { ui.revealShown = true; render(); } }, t('revealRecovery'))
    ),
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, t('offlineTransfer')),
      snapshotActions()
    ),
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, t('rescan')),
      h('p', { class: 'small muted', style: 'margin:0' },
        t('rescanDesc')),
      wallet.offline
        ? null
        : h('button', { disabled: wallet.scanning, onClick: () => wallet.scan() },
            wallet.scanning ? t('scanning') : t('rescanWallet'))
    ),
    explorerCard(),
    syncCard(),
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, t('language')),
      languagePicker()
    )
  );
}

// Block explorer / server selection: a preset (mempool.space, blockstream.info)
// or a custom Esplora/electrs REST URL (e.g. your own node).
function explorerCard() {
  const cfg = getExplorerConfig();
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('explorer')),
    h('p', { class: 'small muted', style: 'margin:0' }, t('explorerDesc')),
    h(
      'select',
      {
        onChange: (e) => {
          const server = e.target.value;
          setExplorerConfig({ server, url: cfg.url });
          render();
          if (server !== 'custom' || cfg.url) wallet.reloadExplorer();
        },
      },
      EXPLORER_PRESETS.map((o) => h('option', { value: o.id, selected: o.id === cfg.server }, o.label))
    ),
    cfg.server === 'custom'
      ? h('label', { class: 'field' },
          h('span', { class: 'lab' }, t('explorerUrl')),
          h('input', {
            type: 'text', class: 'mono-input', placeholder: 'https://mempool.space/api',
            autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
            value: cfg.url,
            // Apply on blur/Enter, not every keystroke (each change rescans).
            onChange: (e) => {
              setExplorerConfig({ server: 'custom', url: e.target.value.trim() });
              wallet.reloadExplorer();
            },
          }),
          h('div', { class: 'small faint' }, t('explorerUrlHint'))
        )
      : null
  );
}

// Cross-device sync settings: toggle + editable relay list (default coinos).
function syncCard() {
  const cfg = getSyncConfig();
  const setEnabled = (enabled) => {
    if (enabled === cfg.enabled) return;
    setSyncConfig({ enabled, relays: cfg.relays });
    render();
    // On enable, pull anything newer from the relays, then push our copy up.
    if (enabled && !wallet.offline) {
      wallet.syncFromNostr().catch(() => {}).finally(() => wallet.saveCache());
    }
  };
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('deviceSync')),
    h('p', { class: 'small muted', style: 'margin:0' }, t('deviceSyncDesc')),
    h('div', { class: 'row between' },
      h('span', { class: 'lab', style: 'margin:0' }, t('syncAcross')),
      h('div', { class: 'seg' },
        h('button', { type: 'button', class: cfg.enabled ? 'active' : '', onClick: () => setEnabled(true) }, t('syncOn')),
        h('button', { type: 'button', class: !cfg.enabled ? 'active' : '', onClick: () => setEnabled(false) }, t('syncOff'))
      )
    ),
    cfg.enabled
      ? h('label', { class: 'field' },
          h('span', { class: 'lab' }, t('relaysLabel')),
          h('textarea', {
            placeholder: 'wss://relay.example.com',
            autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
            style: 'min-height:64px',
            value: cfg.relays.join('\n'),
            onInput: (e) => {
              const relays = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
              setSyncConfig({ enabled: true, relays });
            },
          }),
          h('div', { class: 'small faint' }, t('relaysHint'))
        )
      : null
  );
}

// Language selector. Changing it persists the choice, flips text direction for
// RTL languages, and re-renders the whole app in the new language.
function languagePicker() {
  return h(
    'select',
    {
      value: getLang(),
      onChange: async (e) => {
        const code = e.target.value;
        setLang(code);
        await loadLocale(code); // fetch the locale's strings before re-rendering
        applyDir();
        render();
      },
    },
    LANGS.map(([code, name]) => h('option', { value: code, selected: code === getLang() }, name))
  );
}

// Reflect the active language's writing direction on <html> (rtl for ar/ur).
function applyDir() {
  try {
    document.documentElement.dir = isRTL() ? 'rtl' : 'ltr';
    document.documentElement.lang = getLang();
  } catch {}
}

function goHome() {
  if (ui.screen === 'howItWorks') {
    ui.screen = ui.returnScreen === 'wallet' ? 'wallet' : 'unlock';
  }
  if (ui.screen === 'wallet') {
    ui.tab = wallet.offline ? 'settings' : 'receive';
    ui.draft = null;
    ui.sendResult = null;
    ui.sendError = '';
  } else {
    ui.screen = 'unlock';
    ui.unlockTab = 'create';
    ui.createStep = 'gen';
    ui.draftMnemonic = '';
    ui.confirm = [];
    ui.unlockError = '';
  }
  render();
}

function walletScreen() {
  return h(
    'div',
    { class: 'col', style: 'gap:0' },
    brandHeader(true),
    h('div', { class: 'mt16' }, balanceCard()),
    ui.offlineFallback && wallet.offline ? offlineBanner() : null,
    tabsBar(),
    tabContent()
  );
}

function offlineBanner() {
  return h(
    'div',
    { class: 'notice info row between', style: 'margin:12px 0 0' },
    h('span', {}, t('offlineBanner')),
    h('button', { class: 'btn-sm', onClick: retryOnline }, t('retry'))
  );
}

function balanceCard() {
  // Only dim on the very first load; background updates happen silently.
  const firstLoad = wallet.scanning && !wallet.loaded;
  return h(
    'div',
    { class: 'card balance' },
    h('div', { class: 'small faint', style: 'text-transform:uppercase;letter-spacing:.05em' }, t('balance')),
    // Headline is the projected balance (confirmed + mempool), so a pending
    // spend is debited immediately rather than waiting for confirmation.
    h('div', { class: 'amt', style: firstLoad ? 'opacity:.3' : '' }, fmtAmount(wallet.total), ' ', unitTag('unit')),
    wallet.pending > 0
      ? h(
          'div',
          { class: 'split' },
          h('div', {}, h('div', { class: 'k' }, t('pending')), h('div', { class: 'v pending' }, fmtAmount(wallet.pending), ' ', unitTag()))
        )
      : null
  );
}

function tabsBar() {
  const tabs = [
    ['receive', t('tabReceive')],
    ['send', t('tabSend')],
    ['history', t('tabHistory')],
    ['settings', t('tabSettings')],
  ];
  return h(
    'div',
    { class: 'tabs' },
    tabs.map(([id, label]) =>
      tabBtn(label, ui.tab === id, () => {
        ui.tab = id;
        ui.revealShown = false; // re-mask the recovery phrase whenever tabs change
        ui.txDetail = null; // back to the history list when leaving/returning
        ui.bump = null;
        render();
      })
    )
  );
}

function tabContent() {
  switch (ui.tab) {
    case 'receive': return receiveTab();
    case 'send': return sendTab();
    case 'history': return historyTab();
    case 'settings': return settingsTab();
  }
}

// ---------------------------------------------------------------- Receive
function receiveTab() {
  // A payment landed on the shown address (the fresh index advanced past what
  // the user last saw) — celebrate, and wait for a tap before showing the next.
  // Until receiveSeenIndex has been baselined (post-scan, in enterWallet) it
  // stays null and we never celebrate, so importing a wallet with existing
  // history doesn't flash "payment received" for old payments.
  if (ui.receiveSeenIndex != null && wallet.nextReceiveIndex > ui.receiveSeenIndex) {
    let amt = 0;
    for (let i = ui.receiveSeenIndex; i < wallet.nextReceiveIndex; i++) {
      const e = wallet._addrInfo(0, i);
      if (e) amt += (e.confirmed || 0) + (e.pending || 0);
    }
    return h(
      'div',
      {
        class: 'card col',
        style: 'align-items:center;text-align:center;gap:14px;cursor:pointer;padding:48px 20px',
        onClick: () => { ui.receiveSeenIndex = wallet.nextReceiveIndex; wallet.setReceiveAck(wallet.nextReceiveIndex); render(); },
      },
      h('div', { class: 'check-badge' }, '✓'),
      h('h2', { style: 'margin:0' }, t('paymentReceived')),
      amt ? h('div', { class: 'amount-pos', style: 'font-size:18px' }, '+' + fmtAmount(amt) + ' ' + unitLabel()) : null,
      h('div', { class: 'small muted' }, t('tapToProceed'))
    );
  }

  const fresh = wallet.freshReceive();
  return h(
    'div',
    { class: 'card col', style: 'align-items:center;gap:14px' },
    h('div', { html: qrSvg(fresh.address) }),
    h('div', { class: 'addr-box', style: 'width:100%' }, fresh.address),
    copyBtn(fresh.address, t('copyAddress'))
  );
}

// ---------------------------------------------------------------- Send
function sendTab() {
  if (ui.sendResult) return sendResultView();
  if (ui.broadcastTx) return broadcastConfirmView();
  if (ui.draft) return reviewView();
  return sendForm();
}

// QR scanning is only possible in a secure context with a camera.
const canScan = () =>
  typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// Open the camera, then route the decoded payload: a BIP21 URI or address fills
// the form; a raw signed-tx hex goes to a broadcast confirmation.
async function scanIntoSend() {
  let text;
  try {
    text = await scanQr(t);
  } catch (e) {
    ui.sendError = e.message;
    render();
    return;
  }
  if (text) handleScanned(text);
}

function handleScanned(raw) {
  const text = raw.trim();
  const s = ui.send;
  ui.sendError = '';

  if (/^bitcoin:/i.test(text)) {
    const { address, amount } = parseBip21(text);
    if (!address) {
      ui.sendError = t('scanUnrecognized');
      render();
      return;
    }
    s.recipients[0].address = address;
    if (amount != null) {
      s.recipients[0].amount = amount;
      s.max = false;
    }
    render();
    return;
  }

  // A raw signed transaction (hex) — confirm before broadcasting.
  const compact = text.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length >= 100 && compact.length % 2 === 0) {
    try {
      const info = wallet.parseRawTx(compact);
      ui.broadcastTx = { hex: compact, ...info };
      render();
      return;
    } catch {
      /* not a parseable tx — fall through and treat as an address */
    }
  }

  // Otherwise treat it as an address (review will validate it).
  s.recipients[0].address = text;
  render();
}

// bitcoin:<address>?amount=<btc>&label=... — amount is in BTC; convert to the
// current display unit so it lands in the form's amount field correctly.
function parseBip21(uri) {
  const m = /^bitcoin:([^?]*)(?:\?(.*))?$/i.exec(uri.trim());
  if (!m) return {};
  const address = decodeURIComponent((m[1] || '').trim());
  let amount = null;
  if (m[2]) {
    const amt = new URLSearchParams(m[2]).get('amount');
    if (amt && isFinite(Number(amt)) && Number(amt) > 0) {
      const sats = Math.round(Number(amt) * SATS);
      amount = unit === 'sats' ? String(sats) : String(Number(amt));
    }
  }
  return { address, amount };
}

function broadcastConfirmView() {
  const b = ui.broadcastTx;
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('broadcastScanned')),
    h(
      'div',
      { class: 'summary col', style: 'gap:0' },
      ...b.outputs.map((o) =>
        h('div', { class: 'line' },
          h('span', { class: 'k mono break' }, o.address ? shortAddr(o.address, 14, 8) : '—'),
          h('span', { class: 'v' }, fmtAmount(o.value), ' ', unitTag())
        )
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k' }, t('transactionId')),
        h('span', { class: 'v mono break' }, shortTxid(b.txid))
      )
    ),
    ui.sendError && h('div', { class: 'notice err' }, ui.sendError),
    h('div', { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.broadcastTx = null; ui.sendError = ''; render(); } }, t('back')),
      ui.busy
        ? h('button', { class: 'btn-primary grow', disabled: true }, h('span', { class: 'spinner' }))
        : h('button', { class: 'btn-primary grow', onClick: broadcastScanned }, t('broadcastNow'))
    )
  );
}

// --- RBF fee bump (with a fee-rate picker) ---------------------------------
function bumpRate() {
  const s = ui.bump;
  if (s.feeChoice === 'custom') return Math.max(1, Math.round(Number(s.customFee) || 1));
  const fr = wallet.feeRates;
  return (fr && fr[s.feeChoice]) || 5;
}

// Open the bump screen: fetch + reconstruct the original, default to Priority.
async function bumpFee(txid) {
  if (wallet.offline) { toast(t('scanOffline')); return; }
  ui.busy = true;
  render();
  try {
    const prep = await wallet.prepareBump(txid);
    ui.bump = { prep, feeChoice: 'fastestFee', customFee: '' };
    ui.sendError = '';
  } catch (e) {
    toast(e.message);
  }
  ui.busy = false;
  render();
}

function bumpView() {
  const s = ui.bump;
  const feeOpts = [
    ['economyFee', t('feeEconomy')],
    ['halfHourFee', t('feeNormal')],
    ['fastestFee', t('feePriority')],
    ['custom', t('feeCustom')],
  ];
  const rate = bumpRate();
  let pl = null;
  try { pl = wallet.planBump(s.prep, rate); } catch {}
  const newFee = pl && pl.ok ? pl.fee : null;
  const planErr = pl && !pl.ok ? t('bumpInsufficient') : '';
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('bumpConfirm')),
    h('div', { class: 'summary col', style: 'gap:0' },
      ...s.prep.recipients.map((r) =>
        h('div', { class: 'line' },
          h('span', { class: 'k mono break' }, r.address ? shortAddr(r.address, 14, 8) : '—'),
          h('span', { class: 'v' }, fmtAmount(r.value), ' ', unitTag())
        )
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k' }, t('networkFee')),
        h('span', { class: 'v' }, fmtAmount(s.prep.oldFee) + ' → ' + (newFee != null ? fmtAmount(newFee) : '—') + ' ' + unitLabel())
      )
    ),
    h('div', { class: 'field' },
      h('span', { class: 'lab' }, t('feeRate')),
      h('div', { class: 'seg', style: 'display:flex;width:100%' },
        feeOpts.map(([k, label]) =>
          h('button', {
            type: 'button', class: (s.feeChoice === k ? 'active ' : '') + 'grow',
            onClick: () => { s.feeChoice = k; if (k === 'custom' && !s.customFee) s.customFee = String(rate); render(); },
          }, label)
        )
      ),
      s.feeChoice === 'custom'
        ? h('div', { class: 'input-group mt8' },
            h('input', { type: 'number', min: '1', placeholder: 'sat/vB', value: s.customFee,
              onInput: (e) => (s.customFee = e.target.value), onChange: () => render() }),
            h('span', { class: 'small muted', style: 'align-self:center' }, 'sat/vB'))
        : h('div', { class: 'small faint mt8' }, t('selectedRate', { n: rate }))
    ),
    (ui.sendError || planErr) && h('div', { class: 'notice err' }, ui.sendError || planErr),
    h('div', { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.bump = null; ui.sendError = ''; render(); } }, t('back')),
      ui.busy
        ? h('button', { class: 'btn-primary grow', disabled: true }, h('span', { class: 'spinner' }))
        : h('button', { class: 'btn-primary grow', disabled: !newFee, onClick: doBump }, t('replaceTx'))
    )
  );
}

async function doBump() {
  ui.busy = true;
  ui.sendError = '';
  render();
  try {
    const d = wallet.buildBump(ui.bump.prep, bumpRate());
    const txid = await wallet.broadcast(d.hex);
    ui.sendResult = { txid };
    ui.bump = null;
    ui.txDetail = null;
    ui.tab = 'send';
    await wallet.scan().catch(() => {});
  } catch (e) {
    ui.sendError = t('broadcastFailed', { msg: e.message });
  }
  ui.busy = false;
  render();
}

async function broadcastScanned() {
  if (wallet.offline) { ui.sendError = t('scanOffline'); render(); return; }
  ui.busy = true;
  ui.sendError = '';
  render();
  try {
    const txid = await wallet.broadcast(ui.broadcastTx.hex);
    ui.sendResult = { txid };
    ui.broadcastTx = null;
    await wallet.scan().catch(() => {});
  } catch (e) {
    ui.sendError = t('broadcastFailed', { msg: e.message });
  }
  ui.busy = false;
  render();
}

// Full address as wrapping nodes, first/last 6 chars emphasized — readable
// without horizontally scrolling the input. Returns DOM nodes for in-place
// updates (the address input doesn't re-render on every keystroke).
function addrVerifyNodes(a) {
  const n = 6;
  if (!a) return [];
  if (a.length <= n * 2) return [document.createTextNode(a)];
  return [
    h('span', { class: 'hl' }, a.slice(0, n)),
    document.createTextNode(a.slice(n, -n)),
    h('span', { class: 'hl' }, a.slice(-n)),
  ];
}

// One recipient: address + amount. Max is only offered for a single recipient.
function recipientRow(s, r, i) {
  const single = s.recipients.length === 1;
  const maxOn = single && s.max;

  // Updated imperatively on input (and on render) so paste, typing, and scan
  // all reflect immediately without disrupting the input's focus/cursor.
  const check = h('div', { class: 'addr-check' });
  const syncCheck = () => {
    const a = r.address.trim();
    check.replaceChildren(...addrVerifyNodes(a));
    check.style.display = a ? '' : 'none';
  };

  const row = h(
    'div',
    { class: 'col gap6' },
    h('div', { class: 'input-group' },
      h('input', {
        type: 'text', class: 'mono-input grow', placeholder: 'bc1q…',
        autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', value: r.address,
        onInput: (e) => { r.address = e.target.value; syncCheck(); },
      }),
      i === 0 && canScan() && h('button', {
        type: 'button', class: 'btn-sm', title: t('scanQr'), onClick: scanIntoSend,
        html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>',
      }),
      !single && h('button', { type: 'button', class: 'btn-sm', title: t('remove'), onClick: () => { s.recipients.splice(i, 1); render(); } }, '✕')
    ),
    check,
    h('div', { class: 'input-group' },
      h('input', {
        type: 'number', step: unit === 'sats' ? '1' : '0.00000001', min: '0',
        placeholder: unit === 'sats' ? '0' : '0.00000000',
        disabled: maxOn,
        value: maxOn
          ? (unit === 'sats' ? String(estimatedMaxSats()) : fmtBtc(estimatedMaxSats()))
          : r.amount,
        onInput: (e) => {
          let v = e.target.value;
          // Chrome emits scientific notation when stepping tiny BTC amounts.
          if (v && /e/i.test(v)) {
            const n = Number(v);
            if (isFinite(n)) {
              v = unit === 'sats' ? String(Math.round(n)) : n.toFixed(8).replace(/\.?0+$/, '');
              e.target.value = v;
            }
          }
          r.amount = v;
        },
      }),
      h('button', { type: 'button', title: t('switchUnit'), onClick: toggleUnit }, unitLabel()),
      single && h('button', { type: 'button', class: s.max ? 'btn-primary' : '', onClick: () => { s.max = !s.max; render(); } }, t('max'))
    )
  );
  syncCheck();
  return row;
}

function sendForm() {
  const s = ui.send;
  const feeOpts = [
    ['economyFee', t('feeEconomy')],
    ['halfHourFee', t('feeNormal')],
    ['fastestFee', t('feePriority')],
    ['custom', t('feeCustom')],
  ];
  return h(
    'div',
    { class: 'card col' },
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lab' }, s.recipients.length > 1 ? t('recipients') : t('recipient')),
      h('div', { class: 'col', style: 'gap:14px' },
        s.recipients.map((r, i) => recipientRow(s, r, i))
      ),
      s.recipients.length < 10 &&
        h('button', {
          type: 'button', class: 'linklike small mt8',
          onClick: () => { s.recipients.push({ address: '', amount: '' }); s.max = false; render(); },
        }, t('addRecipient'))
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lab' }, t('feeRate')),
      h(
        'div',
        { class: 'seg', style: 'display:flex;width:100%' },
        feeOpts.map(([k, label]) =>
          h('button', {
            type: 'button', class: (s.feeChoice === k ? 'active ' : '') + 'grow',
            onClick: () => {
              s.feeChoice = k;
              if (k === 'custom' && !s.customFee) {
                s.customFee = String((wallet.feeRates && wallet.feeRates.economyFee) || 1);
              }
              render();
            },
          }, label)
        )
      ),
      s.feeChoice === 'custom' &&
        h('div', { class: 'input-group mt8' },
          h('input', { type: 'number', min: '1', placeholder: 'sat/vB', value: s.customFee, onInput: (e) => (s.customFee = e.target.value) }),
          h('span', { class: 'small muted', style: 'align-self:center' }, 'sat/vB')
        ),
      s.feeChoice !== 'custom' &&
        h('div', { class: 'small faint mt8' }, t('selectedRate', { n: currentFeeRate() }))
    ),
    coinControl(),
    ui.sendError && h('div', { class: 'notice err' }, ui.sendError),
    h('button', { class: 'btn-primary btn-block', onClick: reviewSend }, t('reviewTx'))
  );
}

function coinControl() {
  const s = ui.send;
  const head = h(
    'div',
    { class: 'row between' },
    h('span', { class: 'lab', style: 'margin:0' }, t('coinSelection')),
    h(
      'div',
      { class: 'seg' },
      h('button', { type: 'button', class: !s.manual ? 'active' : '', onClick: () => { s.manual = false; render(); } }, t('automatic')),
      h('button', { type: 'button', class: s.manual ? 'active' : '', onClick: () => { s.manual = true; render(); } }, t('manual'))
    )
  );
  if (!s.manual) return h('div', { class: 'col gap6' }, head);

  if (!wallet.utxos.length)
    return h('div', { class: 'col gap6' }, head, h('div', { class: 'small muted' }, t('noCoins')));

  let selTotal = 0;
  const rows = wallet.utxos.map((u) => {
    const id = utxoId(u);
    const checked = s.coins.has(id);
    if (checked) selTotal += u.value;
    return h(
      'label',
      { class: 'coin' },
      h('input', {
        type: 'checkbox', checked,
        onChange: (e) => { e.target.checked ? s.coins.add(id) : s.coins.delete(id); render(); },
      }),
      h('div', { class: 'grow' },
        h('div', { class: 'mono small break' }, shortAddr(u.address, 14, 10)),
        h('div', { class: 'path' }, `${u.chain}/${u.index} · ${shortTxid(u.txid)}:${u.vout}`)
      ),
      h('div', { class: 'amount small' }, fmtAmount(u.value))
    );
  });
  return h(
    'div',
    { class: 'col gap6' },
    head,
    h('div', { class: 'list' }, rows),
    h('div', { class: 'row between small' },
      h('span', { class: 'muted' }, t('nSelected', { n: s.coins.size })),
      h('span', { class: 'amount' }, fmtAmount(selTotal), ' ', unitTag())
    )
  );
}

// Coins that a send would draw from (all, or the manually-selected subset).
function spendableCoins() {
  const s = ui.send;
  return s.manual ? wallet.utxos.filter((u) => s.coins.has(utxoId(u))) : wallet.utxos;
}

// Estimated max sendable = selected total − fee for (n inputs, 1 output).
function estimatedMaxSats() {
  const coins = spendableCoins();
  const total = coins.reduce((a, u) => a + u.value, 0);
  const vbytes = 11 + 68 * coins.length + 31;
  const fee = Math.ceil(vbytes * currentFeeRate());
  return Math.max(0, total - fee);
}

function currentFeeRate() {
  const s = ui.send;
  if (s.feeChoice === 'custom') return Math.max(1, Math.round(Number(s.customFee) || 1));
  const fr = wallet.feeRates;
  if (fr && fr[s.feeChoice]) return fr[s.feeChoice];
  return 5;
}

function reviewSend() {
  ui.sendError = '';
  try {
    const s = ui.send;
    const feeRate = currentFeeRate();
    let coinIds = null;
    if (s.manual) {
      coinIds = [...s.coins];
      if (!coinIds.length) throw new Error(t('selectCoin'));
    }
    let recipients, sendMax = false;
    if (s.max && s.recipients.length === 1) {
      const addr = s.recipients[0].address.trim();
      if (!addr) throw new Error(t('enterRecipientAddr'));
      recipients = [{ address: addr, amount: 0 }];
      sendMax = true;
    } else {
      recipients = s.recipients.map((r, i) => {
        const addr = r.address.trim();
        if (!addr) throw new Error(t('enterAddrForN', { n: i + 1 }));
        const sats = parseAmount(r.amount, unit);
        if (!sats || sats <= 0) throw new Error(t('enterValidAmtForN', { n: i + 1 }));
        return { address: addr, amount: sats };
      });
    }
    ui.draft = wallet.buildTx({ recipients, feeRate, coinIds, sendMax });
  } catch (e) {
    ui.draft = null;
    ui.sendError = e.message;
  }
  render();
}

function reviewView() {
  const d = ui.draft;
  const changeAddr = wallet.freshChange().address;
  const outs = d.outputs.filter((o) => o.address !== changeAddr);
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('reviewTx')),
    h(
      'div',
      { class: 'summary col', style: 'gap:0' },
      ...outs.map((o) =>
        h('div', { class: 'line' },
          h('span', { class: 'k mono break' }, shortAddr(o.address, 14, 8)),
          h('span', { class: 'v' }, fmtAmount(o.amount), ' ', unitTag())
        )
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k' }, t('networkFee')),
        h('span', { class: 'v' }, fmtAmount(d.fee), ' ', unitTag())
      )
    ),
    ui.sendError && h('div', { class: 'notice err' }, ui.sendError),
    wallet.offline
      ? h('div', { class: 'notice info' }, t('offlineSignNote'))
      : null,
    h(
      'div',
      { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.draft = null; ui.sendError = ''; render(); } }, t('back')),
      ui.busy
        ? h('button', { class: 'btn-primary grow', disabled: true }, h('span', { class: 'spinner' }))
        : wallet.offline
          ? h('button', { class: 'btn-primary grow', onClick: signForExport }, t('signTx'))
          : h('button', { class: 'btn-primary grow', onClick: broadcast }, t('signBroadcast'))
    ),
    // Online: also allow signing without broadcasting, to relay the signed tx
    // from another device (air-gapped, or a different network).
    !wallet.offline && !ui.busy
      ? h('button', { class: 'btn-block', style: 'margin-top:8px', onClick: signForExport }, t('signExport'))
      : null
  );
}

async function broadcast() {
  ui.busy = true;
  ui.sendError = '';
  render();
  try {
    const hexTx = wallet.sign(ui.draft.tx);
    const txid = await wallet.broadcast(hexTx);
    ui.sendResult = { txid };
    ui.draft = null;
    ui.send = blankSend();
    await wallet.scan();
  } catch (e) {
    ui.sendError = t('broadcastFailed', { msg: e.message });
  }
  ui.busy = false;
  render();
}

function signForExport() {
  ui.sendError = '';
  try {
    const tx = ui.draft.tx;
    const hexTx = wallet.sign(tx);
    ui.sendResult = { signedHex: hexTx, txid: tx.id };
    ui.draft = null;
    ui.send = blankSend();
  } catch (e) {
    ui.sendError = t('signingFailed', { msg: e.message });
  }
  render();
}

function sendResultView() {
  const r = ui.sendResult;
  const again = h('button', { class: 'btn-block mt8', onClick: () => { ui.sendResult = null; render(); } }, t('done'));
  if (r.signedHex) {
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'warn-box' }, t('txSignedNote')),
      h('div', { class: 'small muted' }, t('transactionId')),
      h('div', { class: 'addr-box' }, r.txid),
      h('div', { class: 'small muted mt8' }, t('signedTxRaw')),
      h('textarea', { readonly: true, style: 'min-height:120px', value: r.signedHex }),
      h('div', { class: 'row gap6' },
        copyBtn(r.signedHex, t('copyHex')),
        h('button', { class: 'btn-sm', onClick: () => download(`tx-${r.txid.slice(0, 8)}.txt`, r.signedHex, 'text/plain') }, t('downloadLabel')),
        h('div', { class: 'grow', html: '' })
      ),
      h('details', { class: 'mt8' }, h('summary', { class: 'small muted' }, t('showQrAirgap')), h('div', { style: 'margin-top:10px', html: qrSvg(r.signedHex) })),
      again
    );
  }
  return h(
    'div',
    { class: 'card col', style: 'align-items:center' },
    h('div', { class: 'notice ok', style: 'width:100%' }, t('txBroadcast')),
    h('div', { class: 'small muted' }, t('transactionId')),
    h('div', { class: 'addr-box' }, r.txid),
    h('div', { class: 'row gap6' },
      copyBtn(r.txid, t('copyTxid')),
      h('a', { class: 'btn btn-sm', href: wallet.api.explorerTx(r.txid), target: '_blank', rel: 'noopener' }, t('viewOnMempool'))
    ),
    again
  );
}

// ---------------------------------------------------------------- History
function historyTab() {
  if (ui.bump) return bumpView();
  if (ui.txDetail) {
    const tx = wallet.txs.find((x) => x.txid === ui.txDetail);
    if (tx) return txDetailView(tx);
    ui.txDetail = null;
  }
  if (wallet.offline)
    return h('div', { class: 'card' }, h('p', { class: 'muted center', style: 'margin:0' }, t('historyOffline')));
  if ((wallet.scanning && !wallet.loaded) || (wallet.historyLoading && !wallet.txs.length))
    return h(
      'div',
      { class: 'card center col', style: 'align-items:center;gap:10px' },
      h('span', { class: 'spinner' }),
      wallet.historyLoading ? h('p', { class: 'small muted', style: 'margin:0' }, t('loadingHistory')) : null
    );
  if (!wallet.txs.length)
    return h('div', { class: 'card' }, h('p', { class: 'muted center', style: 'margin:0' }, t('noTxYet')));
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'list' },
      wallet.txs.map((tx) => {
        const incoming = tx.net >= 0;
        return h(
          'div',
          { class: 'item', style: 'cursor:pointer', onClick: () => { ui.txDetail = tx.txid; render(); } },
          h('div', { class: `ico ${incoming ? 'in' : 'out'}` }, incoming ? '↓' : '↑'),
          h('div', { class: 'grow' },
            h('div', { class: 'row gap6' },
              incoming ? t('received') : t('sent'),
              tx.confirmed ? null : h('span', { class: 'tag pending' }, t('pendingTag'))
            ),
            h('div', { class: 'small faint' }, tx.confirmed ? timeAgo(tx.blockTime) : t('awaitingConfirmation'))
          ),
          h('div', { style: 'text-align:right' },
            h('div', { class: incoming ? 'amount-pos' : 'amount-neg' }, (incoming ? '+' : '') + fmtAmount(tx.net)),
            !incoming && tx.fee ? h('div', { class: 'small faint' }, t('feeShort', { x: fmtAmount(tx.fee) })) : null
          )
        );
      })
    ),
    wallet.historyLoading
      ? h(
          'div',
          { class: 'row gap6', style: 'padding:10px 0 2px;justify-content:center' },
          h('span', { class: 'spinner sm' }),
          h('span', { class: 'small muted' }, t('loadingHistory'))
        )
      : null
  );
}

function txDetailView(tx) {
  const incoming = tx.net >= 0;
  const line = (k, v) => h('div', { class: 'line' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  return h(
    'div',
    { class: 'card col' },
    h('div', { class: 'row between' },
      h('h3', {}, incoming ? t('received') : t('sent')),
      h('span', { class: `tag ${tx.confirmed ? 'conf' : 'pending'}` }, tx.confirmed ? t('confirmedTag') : t('pendingTag'))
    ),
    h('div', { class: 'amt', style: 'font-size:30px' },
      h('span', { class: incoming ? 'amount-pos' : 'amount-neg' }, (incoming ? '+' : '') + fmtAmount(tx.net)),
      ' ', unitTag('unit')
    ),
    h('div', { class: 'summary col', style: 'gap:0' },
      line(t('status'), tx.confirmed ? t('confirmed') : t('pendingInMempool')),
      tx.confirmed ? line(t('block'), String(tx.blockHeight || '—')) : null,
      tx.confirmed && tx.blockTime ? line(t('date'), new Date(tx.blockTime * 1000).toLocaleString()) : null,
      !incoming && tx.fee ? line(t('networkFee'), fmtAmount(tx.fee) + ' ' + unitLabel()) : null
    ),
    h('div', { class: 'col gap6' },
      h('span', { class: 'lab' }, t('transactionId')),
      h('div', { class: 'addr-box', style: 'font-size:13px' }, tx.txid)
    ),
    h('div', { class: 'row gap6 wrap' },
      copyBtn(tx.txid, t('copyId')),
      h('a', { class: 'btn btn-sm', href: wallet.api.explorerTx(tx.txid), target: '_blank', rel: 'noopener' }, t('viewOnMempool'))
    ),
    // RBF: an unconfirmed send can be rebroadcast at a higher fee.
    !tx.confirmed && !incoming && !wallet.offline
      ? (ui.busy
          ? h('button', { class: 'btn-primary btn-block', disabled: true }, h('span', { class: 'spinner' }))
          : h('button', { class: 'btn-primary btn-block', onClick: () => bumpFee(tx.txid) }, t('bumpFee')))
      : null,
    h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.txDetail = null; render(); } }, t('backToHistory'))
  );
}

// Offline snapshot exchange: export coins on an online device, import on an
// offline (air-gapped) one to sign without internet.
function snapshotActions() {
  return h(
    'div',
    { class: 'col gap6' },
    h('p', { class: 'small muted', style: 'margin:0' },
      t('offlineTransferDesc')),
    h('div', { class: 'row gap6 wrap' },
      h('button', { class: 'btn-sm', disabled: !wallet.utxos.length, onClick: exportSnapshot }, t('exportSnapshot')),
      h('label', { class: 'btn btn-sm', style: 'cursor:pointer' }, t('importSnapshot'),
        h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onChange: importSnapshotFile })
      )
    )
  );
}

function exportSnapshot() {
  const snap = wallet.exportSnapshot();
  const stamp = new Date().toISOString().slice(0, 10);
  download(`wallet-snapshot-${wallet.netName}-${stamp}.json`, JSON.stringify(snap, null, 2));
  toast(t('snapshotExported'));
}

async function importSnapshotFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const snap = JSON.parse(await file.text());
    const res = wallet.importSnapshot(snap);
    let msg = t('importedNCoins', { n: res.imported });
    if (res.unmatched.length) msg += t('unmatchedSuffix', { n: res.unmatched.length });
    toast(msg);
    ui.tab = 'settings';
    render();
  } catch (err) {
    toast(t('importFailed', { msg: err.message }));
  }
  e.target.value = '';
}

// ================================================================ start
// Load the active language's strings (English is inline; others are fetched),
// apply text direction, then restore a wallet left open in this tab — otherwise
// show the unlock screen.
applyDir();
loadLocale(getLang()).finally(() => {
  if (!restoreSession()) render();
});





