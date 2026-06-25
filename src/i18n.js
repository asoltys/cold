// Lightweight i18n. t('key', {vars}) interpolates {var} and falls back to the
// English string (then the key). The chosen language persists in localStorage;
// otherwise it's guessed from the browser. Arabic/Urdu render right-to-left.
//
// NOTE: non-English translations are machine-generated and would benefit from
// native-speaker review. The English table (en) is the source of truth.

export const LANGS = [
  ['en', 'English'],
  ['zh', '中文'],
  ['hi', 'हिन्दी'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['ar', 'العربية'],
  ['bn', 'বাংলা'],
  ['pt', 'Português'],
  ['ru', 'Русский'],
  ['ur', 'اردو'],
  ['id', 'Indonesia'],
  ['de', 'Deutsch'],
  ['ja', '日本語'],
  ['sw', 'Kiswahili'],
  ['mr', 'मराठी'],
  ['te', 'తెలుగు'],
  ['tr', 'Türkçe'],
  ['ta', 'தமிழ்'],
  ['vi', 'Tiếng Việt'],
  ['ko', '한국어'],
];

const RTL = new Set(['ar', 'ur']);
export const isRTL = (l) => RTL.has(l || lang);

const STR = {
  en: {
    appTitle: 'Hal Wallet',
    home: 'Home',
    logout: 'Logout',
    accounts: 'Accounts',
    addWallet: 'Add wallet',
    clearAll: 'Clear all',
    clearAllWarn: '⚠ This removes every wallet from this device. Any wallet whose recovery phrase or key you have not backed up will be lost for good.',
    rename: 'Rename',
    remove: 'Remove',
    watchOnly: 'Watch-only',
    watchOnlyTag: 'watch-only',
    watchOnlyAdd: 'Add watch-only',
    watchOnlyDesc: 'Watch any wallet from its account public key. You can receive and view balance and history, but not send.',
    watchOnlyNote: 'This is a watch-only wallet. You can receive and view, but you cannot send.',
    watchXpubLabel: 'Account xpub or zpub',
    labelOptional: 'Label (optional)',
    walletLabelN: 'Wallet {n}',
    watchLabelN: 'Watch {n}',
    saveDevice: 'Save on this device',
    forgetDevice: 'Saved · forget',
    savedTag: 'saved',
    setPassword: 'Set a password',
    setPasswordDesc: 'Encrypts this wallet on this device. You will need it to unlock saved wallets later.',
    enterPassword: 'Enter your password',
    enterPasswordDesc: 'Unlock your saved wallets to continue.',
    password: 'Password',
    confirmPassword: 'Confirm password',
    pwTooShort: 'Use at least 8 characters.',
    pwMismatch: 'Passwords do not match.',
    pwWrong: 'Wrong password.',
    unlockSaved: 'Unlock saved wallets',
    unlockSavedDesc: 'Enter your password to open the wallets saved on this device.',
    unlock: 'Unlock',
    useAnotherWallet: 'Use another wallet',
    save: 'Save',
    publicKey: 'Public key',
    publicKeyDesc: 'Share this to watch this wallet read-only on another device or app. It reveals your addresses, not your keys.',
    copyKey: 'Copy key',
    showPublicKey: 'Show public key',
    createNew: 'Create new',
    importExisting: 'Import existing',
    genIntro: 'Generate a new 12-word seed phrase. Write it down. It’s the only way to recover this wallet.',
    generateSeed: 'Generate seed phrase',
    writeDownWarn: '⚠ Write these 12 words down on paper, in order. Anyone with them can spend your coins.',
    copyPhrase: 'Copy phrase',
    regenerate: 'Regenerate',
    verifyBackup: 'Verify backup',
    skipVerification: 'Skip verification',
    confirmBackupIntro: 'Confirm your backup by entering the requested words.',
    wordN: 'Word #{n}',
    reenterPassphrase: 'Re-enter passphrase',
    back: '← Back',
    openWallet: 'Open wallet',
    wordsMismatch: 'Those words don’t match your phrase. Check your backup.',
    passphraseMismatch: 'That passphrase doesn’t match the one you entered.',
    seedPhrase: 'Seed phrase',
    seedPlaceholder: 'enter your seed words separated by spaces',
    passphrase: 'Passphrase',
    show: 'Show',
    hide: 'Hide',
    invalidSeed: 'Invalid seed phrase — check the spelling and word order.',
    importLabel: 'Recovery phrase or key',
    importPlaceholder: 'Your seed words, or an xpub / xprv',
    invalidImport: 'That is not a valid recovery phrase, xpub, or xprv.',
    importedKey: 'Imported key',
    importedKeyNote: 'This wallet was imported from an extended private key, so there is no recovery phrase. Back up that key itself to keep the wallet.',
    keysNote: 'Keys never leave your browser. Works fully offline. Save this page and open it from your filesystem.',
    howItWorks: 'How it works',
    installApp: 'Install app',
    hiwBasicsTitle: 'The basics',
    hiwBasics1: 'When you make a wallet, the page generates twelve random words. Those words are the key to your wallet. Anyone who has them can spend the coins, so write them down on paper and keep them somewhere only you can get to.',
    hiwBasics2: 'If you lose the twelve words and don’t have a backup, the coins are gone for good. There’s no reset link and no one to call, so back them up before you put money in.',
    hiwBasics3: 'There’s no server and no account. The whole app is a single page that runs in your browser, so nobody holds your coins and nothing on a server ever sees your keys. To show your balance and history it reads from a public block explorer (mempool.space by default, or your own node if you set one in Settings).',
    hiwBasics4: 'You can even save this page and open it straight from your computer with no internet at all. It keeps working offline.',
    hiwBasics5: 'It follows the usual Bitcoin standards (a 12-word BIP39 phrase and BIP84 native SegWit keys), so if this site ever disappears you can restore the same phrase in Sparrow, Electrum, or any other standard wallet and your coins will be right there.',
    hiwTribute: 'The name Hal Wallet is a tribute to legendary cypherpunk and Bitcoin pioneer, Hal Finney (1956–2014).',
    balance: 'Balance',
    pending: 'Pending',
    tabReceive: 'Receive',
    tabSend: 'Send',
    tabHistory: 'History',
    tabSettings: 'Settings',
    copyAddress: 'Copy address',
    paymentReceived: 'Payment received!',
    tapToProceed: 'Tap anywhere to proceed',
    recipient: 'Recipient',
    recipients: 'Recipients',
    max: 'Max',
    feeRate: 'Fee rate',
    feeEconomy: 'Economy',
    feeNormal: 'Normal',
    feePriority: 'Priority',
    feeCustom: 'Custom',
    selectedRate: 'Selected rate: {n} sat/vB',
    coinSelection: 'Coin selection',
    automatic: 'Automatic',
    manual: 'Manual',
    noCoins: 'No coins available.',
    nSelected: '{n} selected',
    addRecipient: '+ Add recipient',
    reviewTx: 'Review transaction',
    remove: 'Remove',
    enterRecipientAddr: 'Enter a recipient address.',
    enterAddrForN: 'Enter an address for recipient {n}.',
    enterValidAmtForN: 'Enter a valid amount for recipient {n}.',
    selectCoin: 'Select at least one coin to spend.',
    networkFee: 'Network fee',
    offlineSignNote: 'Offline: sign now, then broadcast the signed transaction from an online device.',
    unconfirmedInputWarn: 'This payment spends bitcoin that hasn’t confirmed yet, so it won’t confirm until that earlier transaction does.',
    signBroadcast: 'Sign & broadcast',
    signTx: 'Sign transaction',
    signExport: 'Sign & export (broadcast elsewhere)',
    scanQr: 'Scan QR',
    scanHint: 'Point the camera at a QR code',
    scanNoCamera: 'Could not access the camera.',
    scanNoDecoder: 'QR scanning needs a connection the first time it’s used.',
    scanUnrecognized: 'Couldn’t read a Bitcoin address from that QR.',
    broadcastScanned: 'Broadcast transaction?',
    broadcastNow: 'Broadcast',
    bumpFee: 'Bump fee',
    bumpConfirm: 'Replace with a higher fee?',
    replaceTx: 'Replace',
    bumpInsufficient: 'Not enough funds to bump at this rate. Try a lower rate.',
    scanOffline: 'You’re offline — reconnect to broadcast this transaction.',
    broadcastFailed: 'Broadcast failed: {msg}',
    signingFailed: 'Signing failed: {msg}',
    done: 'Done',
    txSignedNote: 'Signed, but not sent yet. To actually send it, broadcast the code below from any online device (e.g. mempool.space → Broadcast). It will not send on its own.',
    transactionId: 'Transaction ID',
    signedTxRaw: 'Signed transaction (code)',
    copyHex: 'Copy code',
    downloadLabel: 'Download',
    showQrAirgap: 'Show QR (for offline transfer)',
    txBroadcast: '✓ Transaction broadcast!',
    copyTxid: 'Copy transaction ID',
    viewOnMempool: 'View on block explorer ↗',
    noTxYet: 'No transactions yet.',
    loadingHistory: 'Loading transactions…',
    received: 'Received',
    sent: 'Sent',
    pendingTag: '⏳ pending',
    stuckTag: '⚠ stuck',
    stuckNote: 'Fee too low — may not confirm',
    stuckIncomingNote: '⚠ This payment’s fee is below the current network floor, so it may not confirm. Only the sender can speed it up (bump or re-send).',
    stuckOutgoingNote: '⚠ This transaction’s fee is below the current network floor, so it may not confirm on its own. Bump the fee below to rebroadcast it at a higher rate.',
    liveTag: 'Live',
    pollingTag: 'Polling',
    awaitingConfirmation: 'awaiting confirmation',
    feeShort: 'fee {x}',
    historyOffline: 'Transaction history is unavailable in offline mode.',
    status: 'Status',
    confirmed: 'Confirmed',
    confirmedTag: 'confirmed',
    pendingInMempool: 'Pending (in mempool)',
    block: 'Block',
    date: 'Date',
    copyId: 'Copy ID',
    backToHistory: '← Back to history',
    recoveryPhrase: 'Recovery phrase',
    giftWelcome: 'You’ve been sent Bitcoin',
    giftBackedUp: 'I’ve written it down',
    giftLink: 'Gift some Bitcoin',
    giftLinkDesc: 'Presign an amount as a link. Whoever opens it claims the Bitcoin into a brand-new wallet that only they control.',
    giftLinkWarn: '⚠ Anyone who opens this link can claim the amount, so share it only with the person you are gifting. Keep amounts small.',
    giftLinkReveal: 'Create gift link',
    giftAmountLabel: 'Amount to gift',
    giftAmountInvalid: 'Enter at least {n}.',
    giftMinNote: 'Minimum {n} at current fees, so it clears dust when claimed.',
    giftAllNote: 'Gifts your whole balance; the recipient pays the claim fee.',
    giftExceedsBalance: 'That’s more than your balance.',
    giftNeedsHeadroom: 'Gift up to {n}, or tap Max to gift your whole balance.',
    giftAnother: 'Create another',
    giftSplitExplain: 'This gift would lock {lock} until it’s claimed ({change} of it comes back to you then). You can split a right-sized coin first for about {fee} so only the gift amount stays locked.',
    giftSplitFirst: 'Split a coin first',
    giftLockWhole: 'Lock the whole coin ({n})',
    giftSplitFailed: 'Could not split the coin.',
    giftHistoryTitle: 'Gift link',
    giftUnclaimedTag: 'unclaimed',
    giftCancel: 'Cancel',
    viewAllGifts: 'View all gifts ({n})',
    prevPage: '‹ Prev',
    nextPage: 'Next ›',
    pageXofY: 'Page {x} of {y}',
    lockedInGifts: 'Locked in gifts',
    giftReserved: 'Unclaimed gift links ({n})',
    giftReclaim: 'Reclaim',
    giftReclaimPrompt: 'Reclaim frees this coin for your next payment, but the link stays claimable until you spend it. Pay a network fee to revoke it right now instead?',
    giftReclaimed: 'Coin reclaimed',
    giftReclaimedTag: 'still claimable',
    giftRevoke: 'Revoke now',
    giftRevokeConfirm: 'Revoke this gift now? This spends the coin back into your wallet and disables the link.',
    giftRevoked: 'Gift revoked',
    copyLink: 'Copy link',
    claimBody: 'Claim it into a brand-new wallet that only you control.',
    claimBtn: 'Claim it',
    claimFeeNote: '~{n} fee',
    claimFailed: 'This gift has already been claimed or is no longer available.',
    claimedTitle: 'Claimed!',
    claimedBody: 'Your Bitcoin is on its way. Back up your recovery phrase to keep it safe.',
    recoveryWarn: '⚠ Anyone who can see these words can steal your funds. Make sure nobody is watching before you reveal them.',
    bip39Passphrase: 'Passphrase',
    copyPassphrase: 'Copy passphrase',
    revealRecovery: 'Reveal recovery phrase',
    offlineTransfer: 'Offline transfer',
    offlineTransferDesc: 'Export your coins on an online device, then import the file on an offline device (with this wallet + seed) to sign without internet.',
    exportSnapshot: '⤓ Export snapshot',
    importSnapshot: 'Import snapshot…',
    rescan: 'Rescan',
    rescanDesc: 'Your current address updates automatically. Rescan an individual address only if a payment was sent to an old (reused) one and isn’t showing.',
    rescanWallet: 'Rescan wallet',
    rescanAddresses: 'Rescan an address',
    rescanAddrDesc: 'Tap Rescan next to the address a payment was sent to. Only that address is re-checked.',
    rescanOne: 'Rescan',
    rescanDone: 'Address rescanned',
    rescanFailed: 'Rescan failed',
    unusedTag: 'unused',
    scanning: 'Scanning…',
    explorer: 'Block explorer',
    explorerDesc: 'The server this wallet queries for balances and history. Point it at your own node for maximum privacy.',
    explorerUrl: 'Server URL',
    explorerUrlHint: 'Esplora / electrs REST base, e.g. https://mempool.space/api',
    deviceSync: 'Device sync',
    deviceSyncDesc: 'Keep this wallet in sync across your devices by storing an encrypted copy on a Nostr relay — only a device with your seed can read it. Turn it off to keep everything on this device.',
    syncAcross: 'Sync across devices',
    syncOn: 'On',
    syncOff: 'Off',
    relaysLabel: 'Relays',
    relaysHint: 'One wss:// URL per line.',
    language: 'Language',
    darkMode: 'Dark mode',
    lightMode: 'Light mode',
    offlineBanner: "Can't reach the network — working offline. Import a snapshot on the Settings tab to load coins.",
    retry: 'Retry',
    copied: 'Copied to clipboard',
    snapshotExported: 'Snapshot exported',
    importedNCoins: 'Imported {n} coin(s)',
    unmatchedSuffix: ' · {n} address(es) not in this wallet',
    importFailed: 'Import failed: {msg}',
    copy: 'Copy',
    switchUnit: 'Switch BTC / sats',
    footerMadeBy: 'made by',
    footerSourceOn: 'source available on',
  },
};

// --- locale loading -------------------------------------------------------
// Only English is bundled; other languages are fetched on demand from
// locales/<code>.json (emitted by the build) and cached, so each visitor only
// downloads the language they use. t() falls back to English until it loads.
const _inflight = new Map();
export function loadLocale(code) {
  if (code === 'en' || STR[code] || !SUPPORTED.has(code)) return Promise.resolve();
  if (_inflight.has(code)) return _inflight.get(code);
  const p = fetch('locales/' + code + '.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) STR[code] = d; })
    .catch(() => {})
    .finally(() => _inflight.delete(code));
  _inflight.set(code, p);
  return p;
}

// --- runtime --------------------------------------------------------------
const SUPPORTED = new Set(LANGS.map(([c]) => c));
const LANG_KEY = 'btc-wallet-lang';

function detect() {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && SUPPORTED.has(q)) return q;
  } catch {}
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved && SUPPORTED.has(saved)) return saved;
  } catch {}
  try {
    for (const l of navigator.languages || [navigator.language || 'en']) {
      const code = String(l).toLowerCase().split('-')[0];
      if (SUPPORTED.has(code)) return code;
    }
  } catch {}
  return 'en';
}

let lang = detect();

export const getLang = () => lang;

export function setLang(l) {
  if (!SUPPORTED.has(l)) return;
  lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {}
}

export function t(key, vars) {
  let s = (STR[lang] && STR[lang][key]) ?? STR.en[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', vars[k]);
  return s;
}
