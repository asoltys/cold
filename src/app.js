// Bitcoin Wallet — UI controller (vanilla DOM, no framework).
//
// State lives in `ui` + the singleton `wallet`. Mutating handlers call render(),
// which rebuilds the active screen. Text inputs write back into `ui` on `input`
// (without re-rendering) so their values survive structural re-renders.

import { Wallet, newMnemonic, isValidMnemonic, utxoId, previewGift, buildClaimTx, giftMinimum, parseExtendedKey, xpubToZpub, encryptVault, decryptVault } from './wallet.js';
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
  screen: 'unlock', // 'unlock' | 'wallet' | 'claim' | 'howItWorks'
  claimStep: null, // 'welcome' | 'backup' when opening a gift link
  returnScreen: 'unlock', // where 'howItWorks' returns to (Back / logo)
  unlockTab: 'create', // 'create' | 'import' | 'watch'
  watchXpub: '', // watch-only xpub/zpub input
  watchLabel: '', // watch-only account label input
  fromWallet: false, // unlock screen reached as "add wallet" (show a back button)
  pw: null, // { purpose, accId, mode, v1, v2, error } — vault password prompt
  vaultPw: '', // on-open vault unlock input
  vaultError: '',
  confirmClear: false, // "Clear all" confirmation shown
  editId: null, // account being renamed
  editLabel: '',
  createStep: 'gen', // 'gen' | 'confirm'
  draftMnemonic: '',
  confirm: [], // [{ index, value }]
  confirmPass: '', // re-entered passphrase on the verify step
  importText: '',
  passphrase: '',
  showPass: false,
  revealShown: false, // recovery phrase unmasked on the Backup tab (after the warning)
  pubkeyShown: false, // account public key revealed in Settings
  giftMode: false, // gift sub-view active on the Send page
  giftAmount: '', // gift-create amount input
  giftCode: null, // last-created gift PSBT code
  giftError: '',
  giftMax: false, // gift the whole spendable balance (no-change sweep)
  giftSplitOffer: null, // { amt, lock, freed, fee } when offering to split a coin first
  revokeId: null, // outpoint of a gift being revoked (confirm state)
  claimCode: null, // gift code being claimed (opened from a #gift= link)
  claimedAmount: 0,
  claimError: '',
  offlineFallback: false, // auto-entered offline because the network was unreachable
  unlockError: '',

  tab: 'receive', // receive | send | history | settings
  receiveSeenIndex: null, // fresh receive index the user has acknowledged
  txDetail: null, // txid being viewed in the history detail view
  txPage: 0, // History: current page of transactions (10 per page)
  giftsAll: false, // History: showing the full paginated list of sent gifts
  giftsPage: 0, // History: current page within the all-gifts list
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
      // once it reports the app is installable. We render from a persisted flag
      // (not the live event) so the link is present on the first paint after a
      // refresh, avoiding a layout shift when beforeinstallprompt fires late.
      installable()
        ? h('span', {}, h('span', { class: 'faint' }, ' · '),
            h('button', { class: 'linklike', style: 'font-weight:400', onClick: triggerInstall }, t('installApp')))
        : null,
      h('span', { class: 'faint' }, ' · '),
      h('button', { class: 'linklike', style: 'font-weight:400', onClick: toggleTheme }, resolvedTheme() === 'dark' ? t('lightMode') : t('darkMode'))
    ),
    h('div', { style: 'margin-top:8px' }, languagePicker())
  );
}

const THEME_KEY = 'btc-wallet-theme';
function resolvedTheme() {
  try {
    const s = localStorage.getItem(THEME_KEY);
    if (s === 'dark' || s === 'light') return s;
  } catch {}
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch {}
  return 'light';
}
function applyTheme() {
  try { document.documentElement.dataset.theme = resolvedTheme(); } catch {}
}
function toggleTheme() {
  try { localStorage.setItem(THEME_KEY, resolvedTheme() === 'dark' ? 'light' : 'dark'); } catch {}
  applyTheme();
  render();
}

// PWA install. Chrome fires beforeinstallprompt when the app qualifies; we stash
// the event and reveal an "Install app" link, then replay it on a user tap (the
// browser requires a gesture). The link's visibility is driven by a persisted
// flag rather than the live event so it's present on the first paint after a
// refresh (no layout shift); the event only supplies the prompt to replay.
// We deliberately do NOT call e.preventDefault(): modern Chrome shows no banner
// of its own to suppress, and preventDefault-without-prompt() logs a console
// warning. The event stays usable for our own e.prompt() on tap.
const INSTALLABLE_KEY = 'btc-wallet-installable';
let installPrompt = null;
function isStandalone() {
  try {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch { return false; }
}
function installable() {
  if (isStandalone()) return false;
  try { return localStorage.getItem(INSTALLABLE_KEY) === '1'; } catch { return false; }
}
function setInstallable(v) {
  try {
    if (v) localStorage.setItem(INSTALLABLE_KEY, '1');
    else localStorage.removeItem(INSTALLABLE_KEY);
  } catch {}
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    installPrompt = e;
    // Only re-render if this changes what's on screen; on a refresh the link is
    // already shown from the persisted flag, so nothing moves.
    const wasShown = installable();
    setInstallable(true);
    if (!wasShown) render();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    setInstallable(false);
    render();
  });
}
async function triggerInstall() {
  const e = installPrompt;
  // The prompt event may not have fired yet this load even though the link is
  // shown from the persisted flag; bail quietly if so.
  if (!e) return;
  installPrompt = null;
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
      : ui.screen === 'accounts'
        ? accountsScreen()
        : ui.screen === 'vault'
          ? vaultScreen()
          : ui.screen === 'claim'
          ? claimScreen()
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
        tabBtn(t('createNew'), ui.unlockTab === 'create', () => { ui.unlockTab = 'create'; ui.unlockError = ''; render(); }),
        tabBtn(t('importExisting'), ui.unlockTab === 'import', () => { ui.unlockTab = 'import'; ui.unlockError = ''; render(); })
      ),
      ui.unlockTab === 'create' ? createPane() : importPane(),
      ui.unlockError && h('div', { class: 'notice err' }, ui.unlockError)
    ),
    ui.fromWallet && accounts.length
      ? h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.fromWallet = false; ui.screen = 'wallet'; ui.unlockError = ''; render(); } }, t('back'))
      : null
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
      h('span', { class: 'lab' }, t('importLabel')),
      h('textarea', {
        placeholder: t('importPlaceholder'),
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

// Import accepts a recovery phrase, an xpub/zpub (watch-only), or an xprv/zprv
// (full spending). Classify the pasted text and open the right kind of wallet.
async function openWallet(input) {
  ui.unlockError = '';
  const raw = (input || '').trim();
  const m = raw.replace(/\s+/g, ' ');
  if (isValidMnemonic(m)) { await enterWallet(m, ui.passphrase); return; }
  let pk;
  try { pk = parseExtendedKey(raw); } catch { ui.unlockError = t('invalidImport'); render(); return; }
  const acc = pk.kind === 'xpub'
    ? addOrGetAccount({ type: 'watch', label: defaultLabel('watch'), xpub: pk.key })
    : addOrGetAccount({ type: 'full', label: defaultLabel('full'), xprv: pk.key });
  ui.fromWallet = false;
  await activateAccount(acc, { fresh: true });
}

// Register a full (seed) wallet as an account and open it.
async function enterWallet(mnemonic, passphrase, opts = {}) {
  const acc = addOrGetAccount({
    type: 'full',
    label: defaultLabel('full'),
    mnemonic: (mnemonic || '').trim().replace(/\s+/g, ' '),
    passphrase: passphrase || '',
  });
  await activateAccount(acc, { ...opts, fresh: true });
}

// Load an account into the wallet and start scanning. Full-account seeds are
// kept in sessionStorage (ephemeral); a refresh restores the open account.
async function activateAccount(acc, opts = {}) {
  activeId = acc.id;
  if (acc.type === 'watch') wallet.load({ xpub: acc.xpub, netName: 'mainnet', offline: false });
  else if (acc.xprv) wallet.load({ xprv: acc.xprv, netName: 'mainnet', offline: false });
  else wallet.load({ mnemonic: acc.mnemonic, passphrase: acc.passphrase || '', netName: 'mainnet', offline: false });
  persistAccounts();
  const hadCache = wallet.restoreCache(); // show last-known balance/history instantly
  // An opened gift link starts on a claim/back-up screen instead of the wallet.
  ui.screen = opts.gift ? 'claim' : 'wallet';
  ui.claimStep = 'welcome';
  ui.claimCode = opts.gift || null;
  ui.claimError = '';
  ui.tab = 'receive';
  // Not baselined yet — stays null until the scan + ack logic below sets it,
  // so the celebration never fires for payments that were already there at
  // import (the index only looks "advanced" because the scan hadn't run yet).
  ui.receiveSeenIndex = null;
  ui.send = blankSend();
  ui.draft = null;
  ui.sendResult = null;
  ui.giftMode = false;
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
    // device with no local cache, or a newer copy from another device). Skipped
    // for watch-only accounts, which have no seed-derived sync key.
    const hadNostr = wallet.watchOnly ? false : await wallet.syncFromNostr();
    // Always do a full scan to fully reconcile (balance, history confirmations,
    // spends, stale cache/relay state). Cache/Nostr just gave us something to
    // show instantly; a partial frontier-only refresh leaves the state stale and
    // would let the celebration baseline before a known payment is even counted.
    await wallet.scan({ silent: hadCache || hadNostr });
    // Celebration baseline. Opening/importing/switching a wallet (opts.fresh)
    // baselines to the current frontier, so payments already received before
    // opening never trigger the "payment received" screen. A same-session
    // refresh keeps the persisted ack, so an unacknowledged celebration
    // survives the refresh.
    let ack;
    if (opts.fresh) {
      ack = wallet.nextReceiveIndex;
      wallet.setReceiveAck(ack);
    } else {
      ack = wallet.getReceiveAck();
      if (ack == null) {
        ack = wallet.nextReceiveIndex;
        wallet.setReceiveAck(ack);
      }
    }
    ui.receiveSeenIndex = ack;
    wallet.startRealtime();
  } catch {
    enterOfflineFallback();
  }
}

// --- accounts -------------------------------------------------------------
// The working set of wallets you can switch between. Full (seed-bearing)
// accounts live only in sessionStorage — ephemeral, wiped when the browser
// closes (no seed on disk by default). Watch-only accounts hold just an xpub,
// so they're additionally persisted in localStorage and reload across restarts.
const ACCOUNTS_KEY = 'btc-wallet-accounts'; // sessionStorage: session list + active
const WATCH_KEY = 'btc-wallet-watch'; // localStorage: persisted watch-only accounts

let accounts = [];
let activeId = null;

const genId = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const credId = (a) => (a.type === 'watch' ? 'w:' + a.xpub : a.xprv ? 'x:' + a.xprv : 'f:' + a.mnemonic + '|' + (a.passphrase || ''));
const activeAccount = () => accounts.find((a) => a.id === activeId) || null;

function defaultLabel(type) {
  const n = accounts.filter((a) => a.type === type).length + 1;
  return t(type === 'watch' ? 'watchLabelN' : 'walletLabelN', { n });
}

function loadWatchAccounts() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]'); } catch { return []; }
}
function saveWatchAccounts() {
  try {
    const watch = accounts.filter((a) => a.type === 'watch').map((a) => ({ id: a.id, label: a.label, type: 'watch', xpub: a.xpub }));
    localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
  } catch {}
}
function persistAccounts() {
  try { sessionStorage.setItem(ACCOUNTS_KEY, JSON.stringify({ accounts, activeId })); } catch {}
}
function clearAccounts() {
  accounts = [];
  activeId = null;
  try { sessionStorage.removeItem(ACCOUNTS_KEY); } catch {}
}

// Add an account (deduped by credential), returning the stored object.
function addOrGetAccount(partial) {
  const cid = credId(partial);
  let acc = accounts.find((a) => credId(a) === cid);
  if (!acc) {
    acc = { id: genId(), ...partial };
    accounts.push(acc);
    if (acc.type === 'watch') saveWatchAccounts();
    persistAccounts();
  }
  return acc;
}

function removeAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  accounts = accounts.filter((a) => a.id !== id);
  if (acc.type === 'watch') saveWatchAccounts();
  persistAccounts();
  if (activeId === id) {
    if (accounts.length) activateAccount(accounts[0], { fresh: true });
    else lock();
  } else {
    render();
  }
}

function switchAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (acc) activateAccount(acc, { fresh: true });
}

// Restore accounts after a refresh (sessionStorage); on a fresh session, prompt
// to unlock the encrypted vault if there is one, else seed from watch-only
// accounts. Returns true if it handled the entry (opened or showed a prompt).
function restoreAccountsState() {
  let sess = null;
  try { sess = JSON.parse(sessionStorage.getItem(ACCOUNTS_KEY) || 'null'); } catch {}
  if (sess && Array.isArray(sess.accounts) && sess.accounts.length) {
    accounts = sess.accounts;
    const active = accounts.find((a) => a.id === sess.activeId) || accounts[0];
    activateAccount(active);
    return true;
  }
  if (hasVault()) { ui.screen = 'vault'; render(); return true; }
  const watch = loadWatchAccounts();
  if (watch.length) {
    accounts = watch.slice();
    activateAccount(accounts[0], { fresh: true });
    return true;
  }
  return false;
}

// --- encrypted vault (optional password-persisted full accounts) ----------
const VAULT_KEY = 'btc-wallet-vault';
let vaultPassword = null; // in memory once unlocked/set this session; cleared on lock

function loadVaultBlob() {
  try { return JSON.parse(localStorage.getItem(VAULT_KEY) || 'null'); } catch { return null; }
}
function hasVault() { return !!loadVaultBlob(); }

// Re-encrypt the vault from the currently-persisted full accounts (needs the
// in-memory password). Removes the blob when nothing is persisted.
function writeVault() {
  if (vaultPassword == null) return;
  const list = accounts.filter((a) => a.type === 'full' && a.persisted)
    .map((a) => (a.xprv ? { label: a.label, xprv: a.xprv } : { label: a.label, mnemonic: a.mnemonic, passphrase: a.passphrase || '' }));
  try {
    if (!list.length) localStorage.removeItem(VAULT_KEY);
    else localStorage.setItem(VAULT_KEY, JSON.stringify(encryptVault(list, vaultPassword)));
  } catch {}
}

function mergeVaultList(list) {
  for (const v of list) {
    const acc = addOrGetAccount(
      v.xprv
        ? { type: 'full', label: v.label || defaultLabel('full'), xprv: v.xprv }
        : { type: 'full', label: v.label || defaultLabel('full'), mnemonic: v.mnemonic, passphrase: v.passphrase || '' }
    );
    acc.persisted = true;
  }
}

// Toggle persistence on a full account. Prompts for the vault password when it
// isn't unlocked this session ('set' the first time, 'enter' if a vault exists).
function startSave(id) {
  const acc = accounts.find((a) => a.id === id);
  if (!acc || acc.type !== 'full') return;
  if (vaultPassword != null) { acc.persisted = true; writeVault(); persistAccounts(); render(); return; }
  ui.pw = { purpose: 'save', accId: id, mode: hasVault() ? 'enter' : 'set', v1: '', v2: '', error: '' };
  render();
}
function startForget(id) {
  if (vaultPassword != null) {
    const acc = accounts.find((a) => a.id === id);
    if (acc) acc.persisted = false;
    writeVault(); persistAccounts(); render();
    return;
  }
  ui.pw = { purpose: 'forget', accId: id, mode: 'enter', v1: '', v2: '', error: '' };
  render();
}
function cancelPw() { ui.pw = null; render(); }
function submitPw() {
  const p = ui.pw;
  if (p.mode === 'set') {
    if ((p.v1 || '').length < 8) { p.error = t('pwTooShort'); render(); return; }
    if (p.v1 !== p.v2) { p.error = t('pwMismatch'); render(); return; }
    vaultPassword = p.v1;
  } else {
    let list;
    try { list = decryptVault(loadVaultBlob(), p.v1); } catch { p.error = t('pwWrong'); render(); return; }
    vaultPassword = p.v1;
    mergeVaultList(list); // bring existing persisted accounts into the session
  }
  const acc = accounts.find((a) => a.id === p.accId);
  if (acc) acc.persisted = p.purpose === 'save';
  writeVault();
  persistAccounts();
  ui.pw = null;
  render();
}

// On-open vault unlock.
function unlockVault() {
  let list;
  try { list = decryptVault(loadVaultBlob(), ui.vaultPw); } catch { ui.vaultError = t('pwWrong'); render(); return; }
  vaultPassword = ui.vaultPw;
  accounts = list
    .map((v) => ({ id: genId(), type: 'full', label: v.label || defaultLabel('full'), mnemonic: v.mnemonic || '', passphrase: v.passphrase || '', xprv: v.xprv || '', persisted: true }))
    .concat(loadWatchAccounts());
  ui.vaultPw = '';
  ui.vaultError = '';
  activateAccount(accounts[0], { fresh: true });
}
function skipVault() {
  ui.vaultPw = '';
  ui.vaultError = '';
  const watch = loadWatchAccounts();
  if (watch.length) { accounts = watch.slice(); activateAccount(accounts[0], { fresh: true }); }
  else { ui.screen = 'unlock'; render(); }
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
  clearAccounts();
  vaultPassword = null;
  wallet.load({ mnemonic: '', passphrase: '', netName: 'mainnet', offline: false });
  wallet.mnemonic = '';
  ui.screen = hasVault() ? 'vault' : 'unlock';
  ui.unlockTab = 'create';
  ui.fromWallet = false;
  ui.watchXpub = '';
  ui.watchLabel = '';
  ui.pw = null;
  ui.vaultPw = '';
  ui.vaultError = '';
  ui.confirmClear = false;
  ui.editId = null;
  ui.editLabel = '';
  ui.createStep = 'gen';
  ui.draftMnemonic = '';
  ui.importText = '';
  ui.passphrase = '';
  ui.confirm = [];
  ui.revealShown = false;
  ui.pubkeyShown = false;
  ui.giftMode = false;
  ui.giftAmount = '';
  ui.giftCode = null;
  ui.giftError = '';
  ui.giftMax = false;
  ui.giftSplitOffer = null;
  ui.revokeId = null;
  ui.receiveSeenIndex = null;
  ui.txDetail = null;
  ui.broadcastTx = null;
  ui.bump = null;
  render();
}

// ================================================================ WALLET
function brandHeader(withLock) {
  const acc = activeAccount();
  return h(
    'div',
    { class: 'row between' },
    h(
      'div',
      { class: 'brand', style: 'cursor:pointer', title: t('home'), onClick: goHome },
      h('div', { class: 'logo' }, '₿'),
      h('h1', {}, t('appTitle'))
    ),
    withLock &&
      h('button', { class: 'btn-sm', onClick: () => { ui.screen = 'accounts'; render(); } },
        acc ? acc.label : t('accounts'))
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
    wallet.watchOnly
      ? h('div', { class: 'card col' },
          h('h3', {}, t('watchOnly')),
          h('p', { class: 'small muted', style: 'margin:0' }, t('watchOnlyNote'))
        )
      : !wallet.mnemonic
      ? h('div', { class: 'card col' },
          h('h3', {}, t('importedKey')),
          h('p', { class: 'small muted', style: 'margin:0' }, t('importedKeyNote'))
        )
      : h(
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
    pubkeyCard(),
    wallet.watchOnly
      ? null
      : h(
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
    wallet.watchOnly || !wallet.mnemonic ? null : syncCard()
  );
}

// Public key export: the account zpub, for watching this wallet elsewhere
// (read-only). Gated behind a reveal since it exposes all your addresses.
function pubkeyCard() {
  let zpub = '';
  try { zpub = xpubToZpub(wallet.accountXpub()); } catch {}
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('publicKey')),
    h('p', { class: 'small muted', style: 'margin:0' }, t('publicKeyDesc')),
    ui.pubkeyShown
      ? h('div', { class: 'col gap6' },
          h('div', { class: 'addr-box break', style: 'font-size:12px' }, zpub),
          h('div', { class: 'row gap6 wrap' },
            copyBtn(zpub, t('copyKey')),
            h('button', { class: 'btn-sm grow', onClick: () => { ui.pubkeyShown = false; render(); } }, t('hide'))
          )
        )
      : h('button', { class: 'btn-block', onClick: () => { ui.pubkeyShown = true; render(); } }, t('showPublicKey'))
  );
}

// Gift link: presign a chosen amount as a #gift= PSBT that whoever opens claims
// into a fresh wallet only they control. The coin is reserved until claimed.
function giftUrl() {
  return `${location.origin}/#gift=${ui.giftCode}`;
}
function giftRate() {
  return (wallet.feeRates && wallet.feeRates.halfHourFee) || 5;
}
function createGiftLink() {
  const rate = giftRate();
  if (ui.giftMax) { doCreateGiftAll(rate); return; }
  const min = giftMinimum(rate);
  const amt = parseAmount(ui.giftAmount, unit); // entered in the current display unit
  if (!amt || amt < min) { ui.giftError = t('giftAmountInvalid', { n: fmtAmount(min) + ' ' + unitLabel() }); render(); return; }
  const spendable = wallet.spendable;
  if (amt > spendable) { ui.giftError = t('giftExceedsBalance'); render(); return; }
  // A specific-amount gift must leave us a dust change output (the gift PSBT
  // commits one). If the amount is so close to the balance that no dust change
  // is possible, point the user at Max to gift the whole balance instead.
  const lock = wallet.giftLockPreview(amt);
  if (lock == null) {
    ui.giftError = t('giftNeedsHeadroom', { n: fmtAmount(Math.max(0, spendable - 294)) + ' ' + unitLabel() });
    render();
    return;
  }
  // Creating the gift now locks the whole source coin until it's claimed. If
  // best-fit can't find a near-exact coin, a pre-split would shrink the locked
  // change down to a dust pad (294) — worth offering only when the liquidity it
  // frees exceeds the split's own fee (otherwise you'd pay more than you regain).
  const splitFee = Math.ceil((11 + 68 + 31 * 2) * Math.max(1, Math.round(rate)));
  const freed = lock - amt - 294;
  if (freed > splitFee && !wallet.offline) {
    ui.giftSplitOffer = { amt, lock, freed, fee: splitFee };
    ui.giftError = '';
    render();
    return;
  }
  doCreateGift(amt, rate);
}
function doCreateGift(amt, rate) {
  try {
    ui.giftCode = wallet.createGift(amt, rate).code;
    ui.giftError = '';
    ui.giftSplitOffer = null;
  } catch (e) {
    ui.giftError = e.message;
    ui.giftSplitOffer = null;
  }
  render();
}
// Gift the whole spendable balance as a no-change sweep (the recipient receives
// everything minus their claim fee).
function doCreateGiftAll(rate) {
  try {
    ui.giftCode = wallet.createGiftAll(rate).code;
    ui.giftError = '';
    ui.giftMax = false;
    ui.giftSplitOffer = null;
  } catch (e) {
    ui.giftError = e.message;
  }
  render();
}
// Split + gift in one tap: broadcast a self-send carving out a right-sized
// coin, then immediately build the gift from that (unconfirmed) carve-out, so
// only ~the gift amount is locked and there's no confirmation wait. The link is
// ready right away; the recipient sees a pending balance until the split lands.
async function doSplitForGift(amt) {
  if (wallet.offline) { ui.giftError = t('scanOffline'); render(); return; }
  ui.busy = true; ui.giftError = ''; render();
  try {
    const rate = (wallet.feeRates && wallet.feeRates.halfHourFee) || 5;
    ui.giftCode = (await wallet.createGiftFromSplit(amt, rate)).code;
    ui.giftSplitOffer = null;
    ui.giftError = '';
  } catch (e) {
    ui.giftError = e.message || t('giftSplitFailed');
  }
  ui.busy = false;
  wallet.scan().catch(() => {}); // reconcile the split from the mempool
  render();
}
function giftCard() {
  const active = wallet.outstandingGifts();
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, t('giftLink')),
    h('p', { class: 'small muted', style: 'margin:0' }, t('giftLinkDesc')),
    h('div', { class: 'warn-box' }, t('giftLinkWarn')),
    ui.giftCode
      ? h('div', { class: 'col', style: 'align-items:center;gap:10px' },
          h('div', { html: qrSvg(giftUrl()) }),
          h('div', { class: 'addr-box break', style: 'width:100%;font-size:12px' }, giftUrl()),
          h('div', { class: 'row gap6 wrap' },
            copyBtn(giftUrl(), t('copyLink')),
            h('button', { class: 'btn-sm grow', onClick: () => { ui.giftCode = null; ui.giftAmount = ''; ui.giftMax = false; render(); } }, t('giftAnother'))
          )
        )
      : ui.giftSplitOffer
      ? (() => {
          const o = ui.giftSplitOffer;
          const u = ' ' + unitLabel();
          return h('div', { class: 'col gap6' },
            h('div', { class: 'small muted' },
              t('giftSplitExplain', { lock: fmtAmount(o.lock) + u, change: fmtAmount(o.lock - o.amt) + u, fee: fmtAmount(o.fee) + u })),
            ui.giftError && h('div', { class: 'notice err' }, ui.giftError),
            ui.busy
              ? h('button', { class: 'btn-primary btn-block', disabled: true }, h('span', { class: 'spinner' }))
              : h('div', { class: 'col gap6' },
                  h('button', { class: 'btn-primary btn-block', onClick: () => doSplitForGift(o.amt) }, t('giftSplitFirst')),
                  h('button', { class: 'btn-block', onClick: () => doCreateGift(o.amt, giftRate()) }, t('giftLockWhole', { n: fmtAmount(o.lock) + u })),
                  h('button', { class: 'linklike small', style: 'align-self:center', onClick: () => { ui.giftSplitOffer = null; render(); } }, t('back'))
                )
          );
        })()
      : h('div', { class: 'col gap6' },
          h('div', { class: 'input-group' },
            h('input', { type: 'number', step: unit === 'sats' ? '1' : '0.00000001', min: '0', inputmode: 'decimal', placeholder: t('giftAmountLabel'),
              disabled: ui.giftMax,
              value: ui.giftMax ? (unit === 'sats' ? String(wallet.spendable) : fmtBtc(wallet.spendable)) : ui.giftAmount,
              onInput: (e) => (ui.giftAmount = e.target.value) }),
            h('button', { type: 'button', class: ui.giftMax ? 'btn-primary' : '', onClick: () => { ui.giftMax = !ui.giftMax; ui.giftError = ''; render(); } }, t('max')),
            h('div', { style: 'display:flex;align-items:center' }, unitTag())
          ),
          h('div', { class: 'small faint' }, ui.giftMax ? t('giftAllNote') : t('giftMinNote', { n: fmtAmount(giftMinimum(giftRate())) + ' ' + unitLabel() })),
          ui.giftError && h('div', { class: 'notice err' }, ui.giftError),
          h('button', { class: 'btn-block', onClick: createGiftLink }, t('giftLinkReveal'))
        ),
    active.length
      ? h('div', { class: 'col gap6', style: 'margin-top:4px' },
          h('span', { class: 'small muted' }, t('giftReserved', { n: active.length })),
          ...active.map((g) => {
            const amt = g.value != null ? fmtAmount(g.value) + ' ' + unitLabel() : g.id.slice(0, 12) + '…';
            const label = amt + (g.reserved ? '' : ' · ' + t('giftReclaimedTag'));
            if (ui.revokeId === g.id) {
              return h('div', { class: 'col gap6' },
                h('span', { class: 'small muted' }, g.reserved ? t('giftReclaimPrompt') : t('giftRevokeConfirm')),
                ui.busy
                  ? h('button', { class: 'btn-primary btn-block', disabled: true }, h('span', { class: 'spinner' }))
                  : h('div', { class: 'row gap6' },
                      g.reserved ? h('button', { class: 'btn-ghost grow', onClick: () => doReclaim(g.id) }, t('giftReclaim')) : null,
                      h('button', { class: 'btn-primary grow', onClick: () => doRevoke(g.id) }, t('giftRevoke'))
                    ),
                ui.busy ? null : h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.revokeId = null; render(); } }, t('back'))
              );
            }
            return h('div', { class: 'row between' },
              h('span', { class: 'small mono' }, label),
              h('button', { class: 'btn-sm', onClick: () => { ui.revokeId = g.id; render(); } }, g.reserved ? t('giftReclaim') : t('giftRevoke'))
            );
          })
        )
      : null
  );
}

// Passive reclaim: just free the coin for a future payment (no fee, no
// broadcast). The link stays claimable until the coin is actually spent.
function doReclaim(id) {
  wallet.unreserve(id);
  ui.revokeId = null;
  toast(t('giftReclaimed'));
  render();
}

// Active revoke: spend the coin back now (pays a fee), killing the link.
async function doRevoke(id) {
  if (wallet.offline) { toast(t('scanOffline')); return; }
  ui.busy = true;
  render();
  try {
    const rate = (wallet.feeRates && wallet.feeRates.fastestFee) || 10;
    await wallet.revokeGift(id, rate);
    ui.revokeId = null;
    toast(t('giftRevoked'));
    wallet.scan().catch(() => {});
  } catch (e) {
    toast(e.message);
  }
  ui.busy = false;
  render();
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

// ================================================================ GIFT / CLAIM
// Read a #gift=<psbt> link, returning the code (and scrubbing it from the URL so
// the bearer instrument doesn't linger in the address bar / history). Validates
// that it decodes to a real gift.
function readGiftHash() {
  try {
    const m = location.hash.match(/^#gift=([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return previewGift(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

// Broadcast the presigned gift to this fresh wallet's first receive address.
async function doClaim() {
  if (wallet.offline) { ui.claimError = t('scanOffline'); render(); return; }
  ui.busy = true;
  ui.claimError = '';
  render();
  try {
    const rate = (wallet.feeRates && wallet.feeRates.halfHourFee) || 5;
    const to = wallet.receive[0] ? wallet.receive[0].address : wallet.derive(0, 0).address;
    const claim = buildClaimTx(ui.claimCode, to, rate, wallet.netCfg.net);
    await wallet.broadcast(claim.hex);
    ui.claimedAmount = claim.amount;
    ui.claimStep = 'backup';
    wallet.scan().catch(() => {});
  } catch (e) {
    ui.claimError = t('claimFailed');
  }
  ui.busy = false;
  render();
}

// Gift-claim flow: a fresh wallet only the claimer controls. Step 'welcome'
// shows the amount + a Claim button; 'backup' (after a successful claim) shows
// the fresh recovery phrase to write down.
function claimScreen() {
  if (ui.claimStep === 'backup') {
    const words = wallet.mnemonic.split(' ');
    return h(
      'div',
      { class: 'col', style: 'gap:16px' },
      brandHeader(false),
      h('div', { class: 'card col', style: 'align-items:center;text-align:center;gap:8px' },
        h('div', { class: 'check-badge', style: 'background:var(--accent)' }, '✓'),
        h('h2', { style: 'margin:0' }, t('claimedTitle')),
        h('p', { class: 'muted', style: 'margin:0' }, t('claimedBody'))
      ),
      h('div', { class: 'card col' },
        h('h3', {}, t('recoveryPhrase')),
        h('div', { class: 'warn-box' }, t('writeDownWarn')),
        h('div', { class: 'words' },
          words.map((w, i) => h('div', { class: 'w' }, h('span', { class: 'n' }, i + 1), h('span', { class: 't' }, w)))
        ),
        h('div', { class: 'row gap6' }, copyBtn(wallet.mnemonic, t('copyPhrase'))),
        h('button', { class: 'btn-primary btn-block', onClick: () => { ui.confirm = pickConfirm(words); ui.claimError = ''; ui.claimStep = 'verify'; render(); } }, t('verifyBackup')),
        h('button', { class: 'btn-block', onClick: () => { ui.screen = 'wallet'; ui.claimStep = null; render(); } }, t('skipVerification'))
      )
    );
  }
  if (ui.claimStep === 'verify') {
    // Same word-confirmation as new-wallet creation: prove the recipient wrote
    // the phrase down before sending them off into their freshly funded wallet.
    const words = wallet.mnemonic.split(' ');
    return h(
      'div',
      { class: 'col', style: 'gap:16px' },
      brandHeader(false),
      h('div', { class: 'card col' },
        h('h3', { style: 'margin-top:0' }, t('recoveryPhrase')),
        h('p', { class: 'muted', style: 'margin:0' }, t('confirmBackupIntro')),
        ...ui.confirm.map((c, i) =>
          h('label', { class: 'field' },
            h('span', { class: 'lab' }, t('wordN', { n: c.index + 1 })),
            h('input', {
              type: 'text', class: 'mono-input', autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
              value: c.value, onInput: (e) => (ui.confirm[i].value = e.target.value.trim()),
            })
          )
        ),
        ui.claimError && h('div', { class: 'notice err' }, ui.claimError),
        h('div', { class: 'row gap6' },
          h('button', { class: 'btn-ghost', onClick: () => { ui.claimStep = 'backup'; ui.claimError = ''; render(); } }, t('back')),
          h('button', {
            class: 'btn-primary grow',
            onClick: () => {
              const ok = ui.confirm.every((c) => c.value.toLowerCase() === words[c.index]);
              if (!ok) { ui.claimError = t('wordsMismatch'); render(); return; }
              ui.screen = 'wallet'; ui.claimStep = null; ui.claimError = '';
              render();
            },
          }, t('openWallet'))
        ),
        h('button', { class: 'btn-block', onClick: () => { ui.screen = 'wallet'; ui.claimStep = null; render(); } }, t('skipVerification'))
      )
    );
  }
  const pv = previewGift(ui.claimCode);
  // The headline is the full amount received (inputs minus the sender's change).
  // The network fee is determined now, at claim time, and comes out of that
  // amount — we surface the estimate on the Claim button so it isn't a surprise.
  const rate = Math.max(1, Math.round((wallet.feeRates && wallet.feeRates.halfHourFee) || 5));
  const estFee = pv ? Math.ceil((11 + 68 * pv.inputs + 31 * 2) * rate) : 0;
  const total = pv ? pv.room : 0;
  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    brandHeader(false),
    h('div', { class: 'card col', style: 'align-items:center;text-align:center;gap:12px' },
      h('div', { class: 'check-badge', style: 'background:var(--accent)' }, '🎁'),
      h('h2', { style: 'margin:0' }, t('giftWelcome')),
      h('div', { class: 'amt', style: 'font-size:30px' },
        h('span', { class: 'amount-pos' }, fmtAmount(total)), ' ', unitTag('unit')
      ),
      h('p', { class: 'muted', style: 'margin:0' }, t('claimBody'))
    ),
    ui.claimError && h('div', { class: 'notice err' }, ui.claimError),
    ui.busy
      ? h('button', { class: 'btn-primary btn-block', disabled: true }, h('span', { class: 'spinner' }))
      : h('button', { class: 'btn-primary btn-block', onClick: doClaim },
          t('claimBtn'), ' ',
          h('span', { style: 'font-size:0.85em;opacity:0.9' }, '(' + t('claimFeeNote', { n: fmtAmount(estFee) + ' ' + unitLabel() }) + ')'))
  );
}

// Account switcher: pick a wallet, add another, or lock the session.
function accountsScreen() {
  if (ui.pw) return h('div', { class: 'col', style: 'gap:16px' }, brandHeader(false), pwPromptCard());
  if (ui.confirmClear) {
    return h('div', { class: 'col', style: 'gap:16px' },
      brandHeader(false),
      h('div', { class: 'card col' },
        h('h3', {}, t('clearAll')),
        h('div', { class: 'warn-box' }, t('clearAllWarn')),
        h('div', { class: 'row gap6' },
          h('button', { class: 'btn-ghost grow', onClick: () => { ui.confirmClear = false; render(); } }, t('back')),
          h('button', { class: 'btn-primary grow', onClick: clearAll }, t('clearAll'))
        )
      )
    );
  }
  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    brandHeader(false),
    h('div', { class: 'card col' },
      h('h3', {}, t('accounts')),
      h('div', { class: 'col', style: 'gap:0' },
        accounts.map((a) => {
          const isActive = a.id === activeId;
          const tag = a.type === 'watch' ? ' · ' + t('watchOnlyTag') : ''; // "saved" shown in the link below, not the title
          if (ui.editId === a.id) {
            return h('div', { class: 'row gap6', style: 'padding:10px 0; border-bottom:1px solid var(--line)' },
              h('input', { type: 'text', style: 'flex:1', value: ui.editLabel, autofocus: true,
                onInput: (e) => (ui.editLabel = e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') renameAccount(a.id); } }),
              h('button', { class: 'btn-sm', onClick: () => renameAccount(a.id) }, t('save')),
              h('button', { class: 'btn-sm', onClick: () => { ui.editId = null; render(); } }, t('back'))
            );
          }
          return h('div', { class: 'col', style: 'gap:4px; padding:10px 0; border-bottom:1px solid var(--line)' },
            h('div', { class: 'row between' },
              h('button', {
                class: 'linklike', style: 'text-align:left;flex:1;font-size:15px;' + (isActive ? 'font-weight:600' : ''),
                onClick: () => { if (isActive) { ui.screen = 'wallet'; render(); } else switchAccount(a.id); },
              }, (isActive ? '● ' : '○ ') + a.label + tag),
              h('button', { class: 'btn-sm', title: t('rename'), onClick: () => { ui.editId = a.id; ui.editLabel = a.label; render(); } }, '✎'),
              h('button', { class: 'btn-sm', title: t('remove'), onClick: () => removeAccount(a.id) }, '✕')
            ),
            a.type === 'full'
              ? h('button', { class: 'linklike small', style: 'align-self:flex-start', onClick: () => (a.persisted ? startForget(a.id) : startSave(a.id)) },
                  a.persisted ? t('forgetDevice') : t('saveDevice'))
              : null
          );
        })
      ),
      h('button', { class: 'btn-block', onClick: () => { ui.screen = 'unlock'; ui.unlockTab = 'create'; ui.fromWallet = true; ui.unlockError = ''; render(); } }, t('addWallet')),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.confirmClear = true; render(); } }, t('clearAll'))
    ),
    h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.screen = 'wallet'; render(); } }, t('back'))
  );
}

function renameAccount(id) {
  const acc = accounts.find((a) => a.id === id);
  if (acc) {
    const v = (ui.editLabel || '').trim();
    if (v) acc.label = v;
    persistAccounts();
    if (acc.type === 'watch') saveWatchAccounts();
    if (acc.persisted) writeVault();
  }
  ui.editId = null;
  render();
}

// Wipe every wallet from this device: session accounts, the encrypted vault,
// and saved watch-only accounts. Unbacked-up seeds are unrecoverable after this.
function clearAll() {
  try { localStorage.removeItem(VAULT_KEY); } catch {}
  try { localStorage.removeItem(WATCH_KEY); } catch {}
  ui.confirmClear = false;
  lock();
}

function pwPromptCard() {
  const p = ui.pw;
  return h('div', { class: 'card col' },
    h('h3', {}, p.mode === 'set' ? t('setPassword') : t('enterPassword')),
    h('p', { class: 'small muted', style: 'margin:0' }, p.mode === 'set' ? t('setPasswordDesc') : t('enterPasswordDesc')),
    h('input', { type: 'password', placeholder: t('password'), value: p.v1, onInput: (e) => (p.v1 = e.target.value) }),
    p.mode === 'set' ? h('input', { type: 'password', placeholder: t('confirmPassword'), value: p.v2, onInput: (e) => (p.v2 = e.target.value) }) : null,
    p.error && h('div', { class: 'notice err' }, p.error),
    h('div', { class: 'row gap6' },
      h('button', { class: 'btn-ghost grow', onClick: cancelPw }, t('back')),
      h('button', { class: 'btn-primary grow', onClick: submitPw }, p.mode === 'set' ? t('save') : t('unlock'))
    )
  );
}

function vaultScreen() {
  return h(
    'div',
    { class: 'col', style: 'gap:16px' },
    brandHeader(false),
    h('div', { class: 'card col' },
      h('h3', {}, t('unlockSaved')),
      h('p', { class: 'small muted', style: 'margin:0' }, t('unlockSavedDesc')),
      h('input', { type: 'password', placeholder: t('password'), value: ui.vaultPw,
        onInput: (e) => (ui.vaultPw = e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') unlockVault(); } }),
      ui.vaultError && h('div', { class: 'notice err' }, ui.vaultError),
      h('button', { class: 'btn-primary btn-block', onClick: unlockVault }, t('unlock')),
      h('button', { class: 'btn-ghost btn-block', onClick: skipVault }, t('useAnotherWallet'))
    )
  );
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
  const locked = wallet.lockedValue;
  const pending = wallet.pendingIncoming;
  return h(
    'div',
    { class: 'card balance' },
    h('div', { class: 'row between', style: 'align-items:center' },
      h('div', { class: 'small faint', style: 'text-transform:uppercase;letter-spacing:.05em' }, t('balance')),
      // Live = receiving instant WebSocket pushes; otherwise we're polling, so
      // deposits can lag a few seconds. Surfaced so a stuck socket is visible.
      wallet.offline ? null
        : h('span', { class: 'badge ' + (wallet.live ? 'live' : 'off') + ' dot', style: 'font-size:11px;padding:2px 8px' },
            wallet.live ? t('liveTag') : t('pollingTag'))
    ),
    // Headline is the spendable balance: confirmed coins plus our own pending
    // change, minus gift locks — so a pending spend debits immediately, while a
    // pending incoming receive stays out of it until it confirms.
    h('div', { class: 'amt', style: firstLoad ? 'opacity:.3' : '' }, fmtAmount(wallet.spendable), ' ', unitTag('unit')),
    pending > 0 || locked > 0
      ? h(
          'div',
          { class: 'split' },
          pending > 0
            ? h('div', {}, h('div', { class: 'k' }, t('pending')), h('div', { class: 'v pending' }, fmtAmount(pending), ' ', unitTag()))
            : null,
          locked > 0
            ? h('div', {}, h('div', { class: 'k' }, t('lockedInGifts')), h('div', { class: 'v' }, fmtAmount(locked), ' ', unitTag()))
            : null
        )
      : null
  );
}

function tabsBar() {
  const tabs = [
    ['receive', t('tabReceive')],
    // Watch-only wallets can't sign, so no Send tab.
    ...(wallet.watchOnly ? [] : [['send', t('tabSend')]]),
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
        ui.giftsAll = false; // and back to the paged history, not the all-gifts view
        ui.bump = null;
        ui.giftMode = false;
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

// A payment is "recent" enough to celebrate if it's still pending or confirmed
// within the last couple hours. This is a hard guard so an old payment can never
// trigger the celebration on import, regardless of receive-index bookkeeping.
function hasRecentIncoming() {
  const now = Date.now() / 1000;
  return wallet.txs.some((tx) => tx.net > 0 && (!tx.confirmed || (tx.blockTime && now - tx.blockTime < 2 * 3600)));
}

// ---------------------------------------------------------------- Receive
function receiveTab() {
  // A payment landed on the shown address (the fresh index advanced past what
  // the user last saw) — celebrate, and wait for a tap before showing the next.
  // Until receiveSeenIndex has been baselined (post-scan, in enterWallet) it
  // stays null and we never celebrate. The recency guard additionally ensures an
  // already-old payment never celebrates when a wallet is opened.
  if (ui.receiveSeenIndex != null && wallet.nextReceiveIndex > ui.receiveSeenIndex && hasRecentIncoming()) {
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
  if (ui.giftMode) return giftView();
  return sendForm();
}

// The gift UI as a send-page sub-view (entered from a link on the send form).
function giftView() {
  return h(
    'div',
    { class: 'col', style: 'gap:12px' },
    giftCard(),
    h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.giftMode = false; ui.giftCode = null; ui.giftError = ''; ui.giftMax = false; ui.giftSplitOffer = null; ui.revokeId = null; render(); } }, t('back'))
  );
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
    h('button', { class: 'btn-primary btn-block', onClick: reviewSend }, t('reviewTx')),
    h('button', { class: 'linklike small', style: 'align-self:center;margin-top:2px', onClick: () => { ui.giftMode = true; ui.sendError = ''; render(); } }, '🎁 ' + t('giftLink'))
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
        h('div', { class: 'mono small break' }, shortAddr(u.address, 14, 10),
          !u.confirmed ? h('span', { class: 'tag pending', style: 'margin-left:6px' }, t('pendingTag')) : null),
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
    wallet.spendsUnconfirmed(d.tx)
      ? h('div', { class: 'notice info' }, t('unconfirmedInputWarn'))
      : null,
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
// An outstanding sent gift shown in History: tappable to cancel (reclaim the
// coin for a future payment, or revoke the link on-chain) without going through
// the Send → gift card. Reuses the same confirm state and handlers.
function giftHistoryItem(g) {
  if (ui.revokeId === g.id) {
    return h('div', { class: 'item col', style: 'align-items:stretch;gap:8px' },
      h('span', { class: 'small muted' }, g.reserved ? t('giftReclaimPrompt') : t('giftRevokeConfirm')),
      ui.busy
        ? h('button', { class: 'btn-primary btn-block', disabled: true }, h('span', { class: 'spinner' }))
        : h('div', { class: 'row gap6' },
            g.reserved ? h('button', { class: 'btn-ghost grow', onClick: () => doReclaim(g.id) }, t('giftReclaim')) : null,
            h('button', { class: 'btn-primary grow', onClick: () => doRevoke(g.id) }, t('giftRevoke'))
          ),
      ui.busy ? null : h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.revokeId = null; render(); } }, t('back'))
    );
  }
  return h('div', { class: 'item' },
    h('div', { class: 'ico out' }, '🎁'),
    h('div', { class: 'grow' },
      h('div', { class: 'row gap6' }, t('giftHistoryTitle'),
        h('span', { class: 'tag pending' }, g.reserved ? t('giftUnclaimedTag') : t('giftReclaimedTag'))),
      g.reserved ? h('div', { class: 'small faint' }, t('lockedInGifts')) : null
    ),
    h('div', { style: 'text-align:right' },
      g.value != null ? h('div', { class: 'amount' }, fmtAmount(g.value)) : null,
      h('button', { class: 'btn-sm', style: 'margin-top:4px', onClick: () => { ui.revokeId = g.id; render(); } }, t('giftCancel'))
    )
  );
}

function txHistoryItem(tx) {
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
}

// Prev / page-of / next controls. Returns null when there's only one page.
const PAGE_SIZE = 10;
function pager(page, total, onPage) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  return h('div', { class: 'row between', style: 'align-items:center;padding-top:10px' },
    h('button', { class: 'btn-sm', disabled: page <= 0, onClick: () => onPage(page - 1) }, t('prevPage')),
    h('span', { class: 'small muted' }, t('pageXofY', { x: page + 1, y: pages })),
    h('button', { class: 'btn-sm', disabled: page >= pages - 1, onClick: () => onPage(page + 1) }, t('nextPage'))
  );
}

// Full paginated list of outstanding sent gifts, reached via "View all" when
// there are more than fit inline on the History page.
function giftsAllView(gifts) {
  const pages = Math.ceil(gifts.length / PAGE_SIZE);
  const page = Math.min(ui.giftsPage, Math.max(0, pages - 1));
  const slice = gifts.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  return h(
    'div',
    { class: 'card col', style: 'gap:12px' },
    h('div', { class: 'row between' },
      h('h3', { style: 'margin:0' }, t('giftReserved', { n: gifts.length })),
      h('button', { class: 'btn-sm', onClick: () => { ui.giftsAll = false; ui.revokeId = null; render(); } }, t('back'))
    ),
    h('div', { class: 'list' }, ...slice.map(giftHistoryItem)),
    pager(page, gifts.length, (p) => { ui.giftsPage = p; render(); })
  );
}

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
  // Outstanding sent gifts (reserved/reclaimed but unclaimed) sit above the
  // on-chain history; they aren't transactions until claimed or revoked.
  const gifts = wallet.loaded ? wallet.outstandingGifts() : [];
  if (ui.giftsAll && gifts.length) return giftsAllView(gifts);
  if (!wallet.txs.length && !gifts.length)
    return h('div', { class: 'card' }, h('p', { class: 'muted center', style: 'margin:0' }, t('noTxYet')));

  // Show at most 3 gifts inline; the rest live behind "View all". Transactions
  // paginate 10 at a time.
  const giftsHead = gifts.slice(0, 3);
  const txPages = Math.ceil(wallet.txs.length / PAGE_SIZE);
  const txPage = Math.min(ui.txPage, Math.max(0, txPages - 1));
  const txSlice = wallet.txs.slice(txPage * PAGE_SIZE, txPage * PAGE_SIZE + PAGE_SIZE);
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'list' },
      ...giftsHead.map(giftHistoryItem),
      ...txSlice.map(txHistoryItem)
    ),
    gifts.length > 3
      ? h('button', { class: 'btn-sm btn-block', style: 'margin-top:8px', onClick: () => { ui.giftsAll = true; ui.giftsPage = 0; ui.revokeId = null; render(); } }, t('viewAllGifts', { n: gifts.length }))
      : null,
    pager(txPage, wallet.txs.length, (p) => { ui.txPage = p; render(); }),
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
  const code = readGiftHash();
  if (code) { enterWallet(newMnemonic(), '', { gift: code }); return; }
  if (!restoreAccountsState()) render();
});





