// Bitcoin Wallet — UI controller (vanilla DOM, no framework).
//
// State lives in `ui` + the singleton `wallet`. Mutating handlers call render(),
// which rebuilds the active screen. Text inputs write back into `ui` on `input`
// (without re-rendering) so their values survive structural re-renders.

import { Wallet, newMnemonic, isValidMnemonic, utxoId } from './wallet.js';
import { qrSvg } from './qr.js';
import { t, LANGS, getLang, setLang, isRTL } from './i18n.js';
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
      h('a', { href: 'https://github.com/asoltys/cold', target: '_blank', rel: 'noopener' }, 'GitHub')
    ),
    h(
      'div',
      { style: 'margin-top:4px' },
      h('button', { class: 'linklike', style: 'font-weight:400', onClick: openHowItWorks }, t('howItWorks'))
    )
  );
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
      para('hiwBasics4'),
      h(
        'details',
        { class: 'hiw-tech' },
        h('summary', {}, t('hiwTechTitle')),
        h(
          'div',
          { class: 'col', style: 'gap:12px;margin-top:12px' },
          para('hiwTech1'),
          para('hiwTech2'),
          para('hiwTech4')
        )
      )
    ),
    h('button', { class: 'btn-block', onClick: back }, t('back'))
  );
}

// Turn known tokens (e.g. mempool.space) into links within a plain string,
// returning an array of text + anchor nodes. Keeps i18n strings link-free.
const HIW_LINKS = [['mempool.space', 'https://mempool.space']];
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
    // With existing state (local or remote), only check the live frontier;
    // a brand-new wallet does one full scan.
    if (hadCache || hadNostr) await wallet.refreshLive();
    else await wallet.scan();
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
            h('button', { class: 'grow', onClick: () => { ui.revealShown = false; render(); } }, t('hide'))
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
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, t('language')),
      languagePicker()
    )
  );
}

// Language selector. Changing it persists the choice, flips text direction for
// RTL languages, and re-renders the whole app in the new language.
function languagePicker() {
  return h(
    'select',
    {
      value: getLang(),
      onChange: (e) => {
        setLang(e.target.value);
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
    h('div', { class: 'amt', style: firstLoad ? 'opacity:.3' : '' }, fmtAmount(wallet.confirmed), ' ', unitTag('unit')),
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
  if (ui.receiveSeenIndex == null) ui.receiveSeenIndex = wallet.nextReceiveIndex;

  // A payment landed on the shown address (the fresh index advanced past what
  // the user last saw) — celebrate, and wait for a tap before showing the next.
  if (wallet.nextReceiveIndex > ui.receiveSeenIndex) {
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
  if (ui.draft) return reviewView();
  return sendForm();
}

// One recipient: address + amount. Max is only offered for a single recipient.
function recipientRow(s, r, i) {
  const single = s.recipients.length === 1;
  const maxOn = single && s.max;
  return h(
    'div',
    { class: 'col gap6' },
    h('div', { class: 'input-group' },
      h('input', {
        type: 'text', class: 'mono-input grow', placeholder: 'bc1q…',
        autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', value: r.address,
        onInput: (e) => (r.address = e.target.value),
      }),
      !single && h('button', { type: 'button', class: 'btn-sm', title: t('remove'), onClick: () => { s.recipients.splice(i, 1); render(); } }, '✕')
    ),
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
      h('button', { type: 'button', class: 'btn-sm', title: t('switchUnit'), onClick: toggleUnit }, unitLabel()),
      single && h('button', { type: 'button', class: s.max ? 'btn-primary' : '', onClick: () => { s.max = !s.max; render(); } }, t('max'))
    )
  );
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
    )
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
      h('div', { class: 'notice ok' }, t('txSignedNote')),
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
// Apply the detected/saved language direction, then restore a wallet left open
// in this tab; otherwise show the unlock screen.
applyDir();
if (!restoreSession()) render();





