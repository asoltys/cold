// Standalone bundle for the QR decoder, emitted as a separate dist/jsqr.js and
// loaded on demand by scan.js — only when a browser lacks the native
// BarcodeDetector API and the user actually opens the scanner. Keeps jsQR
// (~130 KB) out of the main single-file bundle and off the initial load.
import jsQR from 'jsqr';

window.jsQR = jsQR;
