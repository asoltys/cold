// Bitcoin Wallet — UI controller (vanilla DOM, no framework).
//
// State lives in `ui` + the singleton `wallet`. Mutating handlers call render(),
// which rebuilds the active screen. Text inputs write back into `ui` on `input`
// (without re-rendering) so their values survive structural re-renders.

import { Wallet, newMnemonic, isValidMnemonic, utxoId } from './wallet.js';
import { qrSvg } from './qr.js';
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
  screen: 'unlock', // 'unlock' | 'wallet'
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
  send: blankSend(),
  draft: null, // built tx summary awaiting review
  sendError: '',
  sendResult: null, // { txid } | { signedHex, txid }
  busy: false,
};

function blankSend() {
  return {
    address: '',
    amount: '',
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
function render() {
  root.replaceChildren(ui.screen === 'wallet' ? walletScreen() : unlockScreen());
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
  toast('Copied to clipboard');
}

function download(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function copyBtn(text, label = 'Copy') {
  return h('button', { class: 'btn-sm', onClick: () => copy(text) }, label);
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
        tabBtn('Create new', ui.unlockTab === 'create', () => {
          ui.unlockTab = 'create';
          render();
        }),
        tabBtn('Import existing', ui.unlockTab === 'import', () => {
          ui.unlockTab = 'import';
          render();
        })
      ),
      ui.unlockTab === 'create' ? createPane() : importPane(),
      ui.unlockError && h('div', { class: 'notice err' }, ui.unlockError)
    ),
    h(
      'p',
      { class: 'small muted center' },
      'Keys never leave your browser. Works fully offline — save this page and open it from your filesystem.'
    )
  );
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
        h('p', { class: 'muted' }, 'Generate a new 12-word BIP39 seed phrase. Write it down — it is the only way to recover this wallet.'),
        h(
          'button',
          {
            class: 'btn-primary btn-block',
            onClick: () => {
              ui.draftMnemonic = newMnemonic();
              render();
            },
          },
          'Generate seed phrase'
        )
      );
    }
    const words = ui.draftMnemonic.split(' ');
    return h(
      'div',
      { class: 'col' },
      h('div', { class: 'warn-box' }, '⚠ Write these 12 words down on paper, in order. Anyone with them can spend your coins.'),
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
        copyBtn(ui.draftMnemonic, 'Copy phrase'),
        h(
          'button',
          {
            class: 'btn-ghost btn-sm',
            onClick: () => {
              ui.draftMnemonic = newMnemonic();
              render();
            },
          },
          'Regenerate'
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
        'Verify backup'
      ),
      h(
        'button',
        { class: 'btn-block', onClick: () => openWallet(ui.draftMnemonic) },
        'Skip verification'
      )
    );
  }

  // confirm step (optional — reachable via "Verify backup")
  const hasPass = !!ui.passphrase;
  return h(
    'div',
    { class: 'col' },
    h('p', { class: 'muted' }, 'Confirm your backup by entering the requested words.'),
    ...ui.confirm.map((c, i) =>
      h(
        'label',
        { class: 'field' },
        h('span', { class: 'lab' }, `Word #${c.index + 1}`),
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
        h('span', { class: 'lab' }, 'Re-enter passphrase'),
        h('input', {
          type: 'password',
          class: 'mono-input',
          autocomplete: 'off',
          value: ui.confirmPass,
          onInput: (e) => (ui.confirmPass = e.target.value),
        })
      ),
    h('div', { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.createStep = 'gen'; render(); } }, '← Back'),
      h('button', {
        class: 'btn-primary grow',
        onClick: () => {
          const words = ui.draftMnemonic.split(' ');
          const ok = ui.confirm.every((c) => c.value.toLowerCase() === words[c.index]);
          if (!ok) { ui.unlockError = 'Those words don’t match your phrase. Check your backup.'; render(); return; }
          if (hasPass && ui.confirmPass !== ui.passphrase) {
            ui.unlockError = 'That passphrase doesn’t match the one you entered.'; render(); return;
          }
          openWallet(ui.draftMnemonic);
        },
      }, 'Open wallet')
    )
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
      h('span', { class: 'lab' }, 'Seed phrase'),
      h('textarea', {
        placeholder: 'enter your seed words separated by spaces',
        autocapitalize: 'none',
        autocomplete: 'off',
        spellcheck: 'false',
        value: ui.importText,
        onInput: (e) => (ui.importText = e.target.value),
      })
    ),
    optionsPanel(),
    h('button', { class: 'btn-primary btn-block', onClick: () => openWallet(ui.importText) }, 'Open wallet')
  );
}

function optionsPanel() {
  return h(
    'label',
    { class: 'field' },
    h('span', { class: 'lab' }, 'Optional passphrase'),
    h(
      'div',
      { class: 'input-group' },
      h('input', {
        type: ui.showPass ? 'text' : 'password',
        class: 'mono-input',
        placeholder: 'leave blank if unused',
        autocomplete: 'off',
        value: ui.passphrase,
        onInput: (e) => (ui.passphrase = e.target.value),
      }),
      h('button', { class: 'btn-sm', type: 'button', onClick: () => { ui.showPass = !ui.showPass; render(); } }, ui.showPass ? 'Hide' : 'Show')
    )
  );
}

async function openWallet(mnemonic) {
  ui.unlockError = '';
  const m = (mnemonic || '').trim().replace(/\s+/g, ' ');
  if (!isValidMnemonic(m)) {
    ui.unlockError = 'Invalid seed phrase — check the spelling and word order.';
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
  wallet.restoreCache(); // show last-known balance/history instantly, if cached
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
    await wallet.scan();
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
  render();
}

// ================================================================ WALLET
function brandHeader(withLock) {
  return h(
    'div',
    { class: 'row between' },
    h(
      'div',
      { class: 'brand', style: 'cursor:pointer', title: 'Home', onClick: goHome },
      h('div', { class: 'logo' }, '₿'),
      h('h1', {}, 'Bitcoin Wallet')
    ),
    withLock && h('button', { class: 'btn-sm', onClick: lock }, 'Logout')
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
      h('h3', {}, 'Recovery phrase'),
      h('div', { class: 'warn-box' }, '⚠ Anyone who can see these words can steal your funds. Make sure nobody is watching before you reveal them.'),
      h('div', { class: 'words' }, cells),
      shown && wallet.passphrase
        ? h('div', { class: 'col gap6' },
            h('span', { class: 'lab' }, 'BIP39 passphrase'),
            h('div', { class: 'addr-box' }, wallet.passphrase)
          )
        : null,
      shown
        ? h('div', { class: 'row gap6 wrap' },
            copyBtn(wallet.mnemonic, 'Copy phrase'),
            wallet.passphrase ? copyBtn(wallet.passphrase, 'Copy passphrase') : null,
            h('button', { class: 'grow', onClick: () => { ui.revealShown = false; render(); } }, 'Hide')
          )
        : h('button', { class: 'btn-primary btn-block', onClick: () => { ui.revealShown = true; render(); } }, 'Reveal recovery phrase')
    ),
    h(
      'div',
      { class: 'card col' },
      h('h3', {}, 'Offline transfer'),
      snapshotActions()
    )
  );
}

function goHome() {
  if (ui.screen === 'wallet') {
    ui.tab = wallet.offline ? 'settings' : 'receive';
    ui.draft = null;
    ui.sendResult = null;
    ui.sendError = '';
  } else {
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
    h('span', {}, "Can't reach the network — working offline. Import a snapshot on the Settings tab to load coins."),
    h('button', { class: 'btn-sm', onClick: retryOnline }, 'Retry')
  );
}

function balanceCard() {
  // Only dim on the very first load; background updates happen silently.
  const firstLoad = wallet.scanning && !wallet.loaded;
  return h(
    'div',
    { class: 'card balance' },
    h('div', { class: 'small faint', style: 'text-transform:uppercase;letter-spacing:.05em' }, 'Total balance'),
    h('div', { class: 'amt', style: firstLoad ? 'opacity:.3' : '' }, fmtBtc(wallet.total), h('span', { class: 'unit' }, 'BTC')),
    h(
      'div',
      { class: 'split' },
      h('div', {}, h('div', { class: 'k' }, 'Confirmed'), h('div', { class: 'v' }, fmtSats(wallet.confirmed) + ' sats')),
      wallet.pending > 0 &&
        h('div', {}, h('div', { class: 'k' }, 'Pending'), h('div', { class: 'v pending' }, fmtSats(wallet.pending) + ' sats'))
    )
  );
}

function tabsBar() {
  const tabs = [
    ['receive', 'Receive'],
    ['send', 'Send'],
    ['history', 'History'],
    ['settings', 'Settings'],
  ];
  return h(
    'div',
    { class: 'tabs' },
    tabs.map(([id, label]) =>
      tabBtn(label, ui.tab === id, () => {
        ui.tab = id;
        ui.revealShown = false; // re-mask the recovery phrase whenever tabs change
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
  const fresh = wallet.freshReceive();
  return h(
    'div',
    { class: 'card col', style: 'align-items:center;gap:14px' },
    h('div', { html: qrSvg(fresh.address) }),
    h('div', { class: 'addr-box', style: 'width:100%' }, fresh.address),
    copyBtn(fresh.address, 'Copy address')
  );
}

// ---------------------------------------------------------------- Send
function sendTab() {
  if (ui.sendResult) return sendResultView();
  if (ui.draft) return reviewView();
  return sendForm();
}

function sendForm() {
  const s = ui.send;
  const feeOpts = [
    ['economyFee', 'Economy'],
    ['halfHourFee', 'Normal'],
    ['fastestFee', 'Priority'],
    ['custom', 'Custom'],
  ];
  return h(
    'div',
    { class: 'card col' },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'lab' }, 'Recipient address'),
      h('input', {
        type: 'text', class: 'mono-input', placeholder: 'bc1q…',
        autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', value: s.address,
        onInput: (e) => (s.address = e.target.value),
      })
    ),
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'lab' }, 'Amount'),
      h(
        'div',
        { class: 'input-group' },
        h('input', {
          type: 'number', step: 'any', min: '0', placeholder: '0.00000000',
          disabled: s.max,
          value: s.max
            ? (s.unit === 'sats' ? String(estimatedMaxSats()) : fmtBtc(estimatedMaxSats()))
            : s.amount,
          onInput: (e) => (s.amount = e.target.value),
        }),
        h(
          'div',
          { class: 'seg' },
          h('button', { type: 'button', class: s.unit === 'btc' ? 'active' : '', onClick: () => { s.unit = 'btc'; render(); } }, 'BTC'),
          h('button', { type: 'button', class: s.unit === 'sats' ? 'active' : '', onClick: () => { s.unit = 'sats'; render(); } }, 'sats')
        ),
        h('button', { type: 'button', class: s.max ? 'btn-primary' : '', onClick: () => { s.max = !s.max; render(); } }, 'Max')
      )
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 'lab' }, 'Fee rate'),
      h(
        'div',
        { class: 'seg', style: 'display:flex;width:100%' },
        feeOpts.map(([k, label]) =>
          h('button', {
            type: 'button', class: (s.feeChoice === k ? 'active ' : '') + 'grow',
            onClick: () => { s.feeChoice = k; render(); },
          }, label)
        )
      ),
      s.feeChoice === 'custom' &&
        h('div', { class: 'input-group mt8' },
          h('input', { type: 'number', min: '1', placeholder: 'sat/vB', value: s.customFee, onInput: (e) => (s.customFee = e.target.value) }),
          h('span', { class: 'small muted', style: 'align-self:center' }, 'sat/vB')
        ),
      s.feeChoice !== 'custom' &&
        h('div', { class: 'small faint mt8' }, `Selected rate: ${currentFeeRate()} sat/vB`)
    ),
    coinControl(),
    ui.sendError && h('div', { class: 'notice err' }, ui.sendError),
    h('button', { class: 'btn-primary btn-block', onClick: reviewSend }, 'Review transaction')
  );
}

function coinControl() {
  const s = ui.send;
  const head = h(
    'div',
    { class: 'row between' },
    h('span', { class: 'lab', style: 'margin:0' }, 'Coin selection'),
    h(
      'div',
      { class: 'seg' },
      h('button', { type: 'button', class: !s.manual ? 'active' : '', onClick: () => { s.manual = false; render(); } }, 'Automatic'),
      h('button', { type: 'button', class: s.manual ? 'active' : '', onClick: () => { s.manual = true; render(); } }, 'Manual')
    )
  );
  if (!s.manual) return h('div', { class: 'col gap6' }, head);

  if (!wallet.utxos.length)
    return h('div', { class: 'col gap6' }, head, h('div', { class: 'small muted' }, 'No coins available.'));

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
      h('div', { class: 'amount small' }, fmtBtc(u.value))
    );
  });
  return h(
    'div',
    { class: 'col gap6' },
    head,
    h('div', { class: 'list' }, rows),
    h('div', { class: 'row between small' },
      h('span', { class: 'muted' }, `${s.coins.size} selected`),
      h('span', { class: 'amount' }, fmtBtc(selTotal) + ' BTC')
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
    if (!s.address.trim()) throw new Error('Enter a recipient address.');
    const feeRate = currentFeeRate();
    let coinIds = null;
    if (s.manual) {
      coinIds = [...s.coins];
      if (!coinIds.length) throw new Error('Select at least one coin to spend.');
    }
    let recipients, sendMax = false;
    if (s.max) {
      recipients = [{ address: s.address.trim(), amount: 0 }];
      sendMax = true;
    } else {
      const sats = parseAmount(s.amount, s.unit);
      if (!sats || sats <= 0) throw new Error('Enter a valid amount.');
      recipients = [{ address: s.address.trim(), amount: sats }];
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
  const recipientOuts = d.outputs.filter((o) => o.address !== changeAddr);
  const rows = recipientOuts.map((o) =>
    h('div', { class: 'line' }, h('span', { class: 'k mono break' }, shortAddr(o.address, 16, 10)), h('span', { class: 'v' }, fmtBtc(o.amount)))
  );
  const sent = recipientOuts.reduce((s, o) => s + o.amount, 0);
  return h(
    'div',
    { class: 'card col' },
    h('h3', {}, 'Review transaction'),
    h(
      'div',
      { class: 'summary col', style: 'gap:0' },
      h('div', { class: 'line' }, h('span', { class: 'k' }, 'Sending'), h('span', { class: 'v' }, fmtBtc(sent) + ' BTC')),
      ...rows,
      h('div', { class: 'line' }, h('span', { class: 'k' }, 'Network fee'), h('span', { class: 'v' }, fmtSats(d.fee) + ' sats')),
      h('div', { class: 'line' }, h('span', { class: 'k' }, 'Inputs / vsize'), h('span', { class: 'v' }, `${d.inputsCount} in · ${d.vsize} vB`)),
      d.hasChange && h('div', { class: 'line' }, h('span', { class: 'k' }, 'Change returns to'), h('span', { class: 'v mono' }, shortAddr(changeAddr, 10, 8))),
      h('div', { class: 'line' }, h('span', { class: 'k' }, 'Total cost'), h('span', { class: 'v' }, fmtBtc(sent + d.fee) + ' BTC'))
    ),
    ui.sendError && h('div', { class: 'notice err' }, ui.sendError),
    wallet.offline
      ? h('div', { class: 'notice info' }, 'Offline: sign now, then broadcast the signed transaction from an online device.')
      : null,
    h(
      'div',
      { class: 'row gap6' },
      h('button', { class: 'btn-ghost', onClick: () => { ui.draft = null; ui.sendError = ''; render(); } }, '← Back'),
      ui.busy
        ? h('button', { class: 'btn-primary grow', disabled: true }, h('span', { class: 'spinner' }))
        : wallet.offline
          ? h('button', { class: 'btn-primary grow', onClick: signForExport }, 'Sign transaction')
          : h('button', { class: 'btn-primary grow', onClick: broadcast }, 'Sign & broadcast')
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
    ui.sendError = 'Broadcast failed: ' + e.message;
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
    ui.sendError = 'Signing failed: ' + e.message;
  }
  render();
}

function sendResultView() {
  const r = ui.sendResult;
  const again = h('button', { class: 'btn-block mt8', onClick: () => { ui.sendResult = null; render(); } }, 'Done');
  if (r.signedHex) {
    return h(
      'div',
      { class: 'card col' },
      h('div', { class: 'notice ok' }, '✓ Transaction signed. Broadcast the hex below from any online device (e.g. mempool.space → Broadcast).'),
      h('div', { class: 'small muted' }, 'Transaction ID'),
      h('div', { class: 'addr-box' }, r.txid),
      h('div', { class: 'small muted mt8' }, 'Signed transaction (raw hex)'),
      h('textarea', { readonly: true, style: 'min-height:120px', value: r.signedHex }),
      h('div', { class: 'row gap6' },
        copyBtn(r.signedHex, 'Copy hex'),
        h('button', { class: 'btn-sm', onClick: () => download(`tx-${r.txid.slice(0, 8)}.txt`, r.signedHex, 'text/plain') }, 'Download'),
        h('div', { class: 'grow', html: '' })
      ),
      h('details', { class: 'mt8' }, h('summary', { class: 'small muted' }, 'Show QR (for air-gapped transfer)'), h('div', { style: 'margin-top:10px', html: qrSvg(r.signedHex) })),
      again
    );
  }
  return h(
    'div',
    { class: 'card col', style: 'align-items:center' },
    h('div', { class: 'notice ok', style: 'width:100%' }, '✓ Transaction broadcast!'),
    h('div', { class: 'small muted' }, 'Transaction ID'),
    h('div', { class: 'addr-box' }, r.txid),
    h('div', { class: 'row gap6' },
      copyBtn(r.txid, 'Copy txid'),
      h('a', { class: 'btn btn-sm', href: wallet.api.explorerTx(r.txid), target: '_blank', rel: 'noopener' }, 'View on mempool.space ↗')
    ),
    again
  );
}

// ---------------------------------------------------------------- History
function historyTab() {
  if (wallet.offline)
    return h('div', { class: 'card' }, h('p', { class: 'muted center', style: 'margin:0' }, 'Transaction history is unavailable in offline mode.'));
  if (wallet.scanning && !wallet.loaded) return h('div', { class: 'card center' }, h('span', { class: 'spinner' }));
  if (!wallet.txs.length)
    return h('div', { class: 'card' }, h('p', { class: 'muted center', style: 'margin:0' }, 'No transactions yet.'));
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'list' },
      wallet.txs.map((t) => {
        const incoming = t.net >= 0;
        const display = incoming ? t.net : t.net; // net already signed
        return h(
          'a',
          { class: 'item', href: wallet.api.explorerTx(t.txid), target: '_blank', rel: 'noopener', style: 'color:inherit' },
          h('div', { class: `ico ${incoming ? 'in' : 'out'}` }, incoming ? '↓' : '↑'),
          h('div', { class: 'grow' },
            h('div', {}, incoming ? 'Received' : 'Sent'),
            h('div', { class: 'small faint' }, t.confirmed ? timeAgo(t.blockTime) : 'unconfirmed')
          ),
          h('div', { style: 'text-align:right' },
            h('div', { class: incoming ? 'amount-pos' : 'amount-neg' }, (incoming ? '+' : '') + fmtBtc(display)),
            !incoming && t.fee ? h('div', { class: 'small faint' }, `fee ${fmtSats(t.fee)}`) : null
          )
        );
      })
    )
  );
}

// Offline snapshot exchange: export coins on an online device, import on an
// offline (air-gapped) one to sign without internet.
function snapshotActions() {
  return h(
    'div',
    { class: 'col gap6' },
    h('p', { class: 'small muted', style: 'margin:0' },
      'Offline transfer — export your coins on an online device, then import the file on an offline device (with this wallet + seed) to sign without internet.'),
    h('div', { class: 'row gap6 wrap' },
      h('button', { class: 'btn-sm', disabled: !wallet.utxos.length, onClick: exportSnapshot }, '⤓ Export snapshot'),
      h('label', { class: 'btn btn-sm', style: 'cursor:pointer' }, 'Import snapshot…',
        h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onChange: importSnapshotFile })
      )
    )
  );
}

function exportSnapshot() {
  const snap = wallet.exportSnapshot();
  const stamp = new Date().toISOString().slice(0, 10);
  download(`wallet-snapshot-${wallet.netName}-${stamp}.json`, JSON.stringify(snap, null, 2));
  toast('Snapshot exported');
}

async function importSnapshotFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const snap = JSON.parse(await file.text());
    const res = wallet.importSnapshot(snap);
    let msg = `Imported ${res.imported} coin(s)`;
    if (res.unmatched.length) msg += ` · ${res.unmatched.length} address(es) not in this wallet`;
    toast(msg);
    ui.tab = 'settings';
    render();
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ================================================================ start
// Restore a wallet left open in this tab; otherwise show the unlock screen.
if (!restoreSession()) render();
