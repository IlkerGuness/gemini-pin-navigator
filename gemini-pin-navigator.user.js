// ==UserScript==
// @name         Gemini Pin Navigator v6 — Header Anchor Edition
// @namespace    https://github.com/userscripts/gemini-pin-navigator
// @version      6.0.0
// @description  📍 Pin button anchored to the stable Gemini logo header — never fights the input area again. Full per-conversation pin system with color picker, labels, sidebar minimap, and smooth teleport.
// @author       ZOGOLDER & CLAUDE
// @match        https://gemini.google.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

'use strict';

/* ══════════════════════════════════════════════════════════════════════
   GEMINI PIN NAVIGATOR  v6 — HEADER ANCHOR EDITION
   ══════════════════════════════════════════════════════════════════════

   ANCHOR STRATEGY
   ───────────────────────────────────────────────────────────────────
   We target the Gemini logo span:
       <span class="bard-text" data-test-id="bard-text">Gemini</span>

   The button is inserted as the next sibling of that span inside its
   parent container — i.e. immediately to the right of the word
   "Gemini" in the top-left header.

   Why this is the safest anchor on the page:
   • It is rendered at app boot and never torn down during a session.
   • It sits outside every flex column that Gemini rebuilds on each
     keystroke or generation event.
   • It is not affected by fullscreen mode, max-width plugins, or any
     of the Beauty Night CSS overrides.

   RESILIENCE
   ───────────────────────────────────────────────────────────────────
   A MutationObserver watches document.body. If Gemini ever removes
   the button's parent (e.g. on a hard internal navigation that
   re-mounts the header), the observer fires, finds the anchor again,
   and re-injects in < 300 ms. Debounced to avoid thrashing.

   FALLBACK SELECTOR CHAIN  (in priority order)
   ───────────────────────────────────────────────────────────────────
   1. [data-test-id="bard-text"]          ← primary, most future-proof
   2. span.bard-text                      ← class fallback
   3. [aria-label="Gemini"] parent span   ← aria fallback
   4. header span, nav span               ← structural fallback
   The first match that exists is used. If none exist yet the observer
   will keep retrying until the header renders.

   PIN SYSTEM  (identical to v5)
   ───────────────────────────────────────────────────────────────────
   • Click button → color picker → 6-char label → pin stamped on last
     Gemini response element via data-gpn6-id attribute.
   • Right sidebar minimap: colored tiles, click = smooth scroll + flash.
   • Pins stored per-conversation in GM_setValue.
   • Teleport falls back to saved scrollY if element is re-rendered.
   • SPA navigation detected via pushState patch + polling.

   ══════════════════════════════════════════════════════════════════════ */

/* ── CONFIG ─────────────────────────────────────────────────────────── */
const CFG = Object.freeze({
  COLORS   : ['#FF5252', '#FFEB3B', '#4CAF50', '#2196F3', '#E040FB', '#FF7043', '#00BCD4'],
  MAX_NOTE : 10,
  FLASH_MS : 2000,
  INIT_MS  : 900,    // ms after DOMContentLoaded before first mount attempt
  RETRY_MS : 400,    // debounce for MutationObserver re-injection
  NAV_MS   : 1000,   // ms after SPA nav before reloading pins
  POLL_MS  : 700,    // URL polling interval

  // Z-index ladder — all our UI sits above Gemini + all three Stylus plugins
  Z_BTN    : 2147483630,
  Z_PICKER : 2147483640,
  Z_MODAL  : 2147483647,
  Z_SIDEBAR: 2147483635,

  // GM storage keys
  SK_PINS  : c => `gpn6::pins::${c}`,

  // Anchor selectors in priority order
  ANCHOR_SELECTORS: [
    '[data-test-id="bard-text"]',   // primary
    'span.bard-text',               // class fallback
    '.app-header span[class*="bard"]',
    'header [class*="bard-text"]',
    'nav [class*="wordmark"]',
    'nav span[class*="title"]',
  ],
});

/* ── LOGGER ─────────────────────────────────────────────────────────── */
const L = {
  log  : (...a) => console.log ('[gpn6]', ...a),
  warn : (...a) => console.warn('[gpn6]', ...a),
};

/* ── STATE ──────────────────────────────────────────────────────────── */
const S = {
  cid      : null,   // current conversation ID
  pins     : [],     // pin objects for current conversation
  poll     : null,   // SPA interval handle
  observer : null,   // MutationObserver handle
  debounce : null,   // observer debounce timer
  syncing  : false,  // is syncPins() in progress?
};

/* ── STORAGE ────────────────────────────────────────────────────────── */
const DB = {
  savePins : (c, p) => GM_setValue(CFG.SK_PINS(c), JSON.stringify(p)),
  loadPins : c      => { try { return JSON.parse(GM_getValue(CFG.SK_PINS(c), '[]')); } catch { return []; } },
};

/* ── UTILITIES ──────────────────────────────────────────────────────── */
const $  = (sel, r = document) => r.querySelector(sel);
const $$ = (sel, r = document) => Array.from(r.querySelectorAll(sel));
const convId = () => { const m = location.pathname.match(/\/(?:app|chat)\/([a-zA-Z0-9_-]+)/); return m ? m[1] : '__home__'; };
const uid    = () => `gpn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/* ══════════════════════════════════════════════════════════════════════
   FIND THE HEADER ANCHOR SPAN
   Returns the first matching element from CFG.ANCHOR_SELECTORS, or null.
   ══════════════════════════════════════════════════════════════════════ */
function findAnchor() {
  for (const sel of CFG.ANCHOR_SELECTORS) {
    const el = $(sel);
    if (el) { L.log('Anchor found via:', sel); return el; }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
   INJECT THE PIN BUTTON  (idempotent — safe to call multiple times)
   ══════════════════════════════════════════════════════════════════════ */
function mountBtn() {
  // Already in DOM?
  if ($('#gpn6-btn')) return;

  const anchor = findAnchor();
  if (!anchor) {
    L.warn('Header anchor not found yet — observer will retry.');
    return;
  }

  /* ── Build the button ── */
  const btn = document.createElement('button');
  btn.id          = 'gpn6-btn';
  btn.type        = 'button';
  btn.title       = 'Pin last Gemini response (Gemini Pin Navigator)';
  btn.textContent = '📍 PIN';

  /* ── Block ALL upward propagation ──────────────────────────────────────
     The Gemini logo is wrapped in an <a href="/app"> link. Without
     suppression on BOTH events the browser fires:
       mousedown → mouseup → click → <a> navigates to gemini.google.com/app

     Fix: intercept in CAPTURE phase so we fire before any ancestor listener.
     • mousedown capture — kills Gemini's own mousedown handlers upstream.
     • click     capture — kills the <a> navigation; we trigger our action here
                           (once, after the full press cycle, the correct moment).  */
  btn.addEventListener('mousedown', e => {
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

  btn.addEventListener('click', e => {
    e.stopImmediatePropagation();
    e.preventDefault();
    pinLastResponse();
  }, true);

  /* ── Insert immediately AFTER the anchor span ──
     anchor.after() is the cleanest DOM API for "right of this element".
     We do NOT wrap or modify the anchor itself.                        */
  anchor.after(btn);

  updateBtnLabel();
  L.log('Pin button injected into header.');
}

/* ── Update button label to show pin count ── */
function updateBtnLabel() {
  const btn = $('#gpn6-btn');
  if (!btn) return;
  // Clear all children safely — no innerHTML
  while (btn.firstChild) btn.removeChild(btn.firstChild);

  const icon = document.createTextNode('📍 PIN');
  btn.appendChild(icon);

  const n = S.pins.length;
  if (n > 0) {
    const badge = document.createElement('span');
    badge.className   = 'gpn6-badge';
    badge.textContent = String(n);
    btn.appendChild(badge);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   MUTATION OBSERVER
   Watches for DOM changes. If the button disappears (Gemini re-mounts
   its header), we re-inject after a short debounce.
   ══════════════════════════════════════════════════════════════════════ */
function startObserver() {
  if (S.observer) S.observer.disconnect();

  S.observer = new MutationObserver(() => {
    clearTimeout(S.debounce);
    S.debounce = setTimeout(() => {
      if (!$('#gpn6-btn')) {
        L.log('Button missing — re-injecting.');
        mountBtn();
      }
    }, CFG.RETRY_MS);
  });

  S.observer.observe(document.body, { childList: true, subtree: true });
  L.log('MutationObserver active.');
}

/* ══════════════════════════════════════════════════════════════════════
   GLOBAL STYLES
   ══════════════════════════════════════════════════════════════════════ */
function injectStyles() {
  if ($('#gpn6-styles')) return;
  const s = document.createElement('style');
  s.id = 'gpn6-styles';
  s.textContent = `

  /* ╔═════════════════════════════════════════════╗
     ║  PIN BUTTON  — sits in the header           ║
     ╚═════════════════════════════════════════════╝
     • display:inline-flex so it flows naturally inside
       the header's flex row without pushing content.
     • No position:fixed — it rides with the header.
     • z-index still set so it's never obscured.      */
  #gpn6-btn {
    display        : inline-flex !important;
    align-items    : center !important;
    justify-content: center !important;
    gap            : 4px !important;
    height         : 28px !important;
    padding        : 0 10px !important;
    margin-left    : 10px !important;
    border-radius  : 14px !important;
    border         : 1px solid rgba(139,128,249,.45) !important;
    background     : rgba(14,12,22,.80) !important;
    color          : #c8c4ff !important;
    font           : 600 12px/1 'Google Sans', system-ui, sans-serif !important;
    letter-spacing : .03em !important;
    white-space    : nowrap !important;
    cursor         : pointer !important;
    user-select    : none !important;
    pointer-events : all !important;
    vertical-align : middle !important;
    position       : relative !important;
    z-index        : ${CFG.Z_BTN} !important;
    backdrop-filter: blur(10px) saturate(130%) !important;
    -webkit-backdrop-filter: blur(10px) saturate(130%) !important;
    box-shadow     : 0 1px 8px rgba(0,0,0,.40),
                     0 0 0 1px rgba(139,128,249,.18) inset !important;
    transition     : background .17s, box-shadow .17s, transform .11s !important;
    outline        : none !important;
    -webkit-tap-highlight-color: transparent !important;
    /* Prevent Gemini's header CSS from collapsing the button */
    flex-shrink    : 0 !important;
    overflow       : visible !important;
  }
  #gpn6-btn:hover {
    background  : rgba(139,128,249,.22) !important;
    box-shadow  : 0 0 0 1.5px rgba(139,128,249,.65),
                  0 3px 14px rgba(0,0,0,.50) !important;
    transform   : translateY(-1px) !important;
  }
  #gpn6-btn:active {
    transform: scale(.96) !important;
  }

  /* Pin count badge */
  #gpn6-btn .gpn6-badge {
    display        : inline-flex !important;
    align-items    : center !important;
    justify-content: center !important;
    min-width      : 16px !important;
    height         : 16px !important;
    padding        : 0 3px !important;
    background     : rgba(139,128,249,.38) !important;
    border-radius  : 8px !important;
    font-size      : 9.5px !important;
    font-weight    : 700 !important;
    color          : #e0dcff !important;
    line-height    : 1 !important;
  }

  /* ╔═════════════════════════════════════════════╗
     ║  RIGHT SIDEBAR MINIMAP                      ║
     ╚═════════════════════════════════════════════╝ */
  #gpn6-sidebar {
    position      : fixed !important;
    top           : 50% !important;
    right         : 0 !important;
    transform     : translateY(-50%) !important;
    z-index       : ${CFG.Z_SIDEBAR} !important;
    width         : 68px !important;
    min-width     : 68px !important;
    max-width     : 68px !important;
    visibility    : visible !important;
    display       : flex !important;
    flex-direction: column !important;
    align-items   : stretch !important;
    gap           : 5px !important;
    padding       : 10px 5px !important;
    background    : rgba(13,13,20,.92) !important;
    backdrop-filter: blur(14px) !important;
    -webkit-backdrop-filter: blur(14px) !important;
    border-radius : 12px 0 0 12px !important;
    border        : 1px solid rgba(255,255,255,.08) !important;
    border-right  : none !important;
    box-shadow    : -4px 0 28px rgba(0,0,0,.55) !important;
    max-height    : 72vh !important;
    overflow-y    : auto !important;
    overflow-x    : hidden !important;
    scrollbar-width: none !important;
    pointer-events: all !important;
    opacity       : 1 !important;
    transition    : opacity .25s, transform .25s !important;
  }
  #gpn6-sidebar.gpn6-empty {
    opacity       : 0 !important;
    pointer-events: none !important;
    transform     : translateY(-50%) translateX(100%) !important;
  }
  #gpn6-sidebar::-webkit-scrollbar { display: none !important; }

  #gpn6-sb-hdr {
    font           : 700 7.5px/.9 'Google Sans', system-ui, sans-serif !important;
    letter-spacing : .12em !important;
    text-transform : uppercase !important;
    color          : rgba(255,255,255,.30) !important;
    text-align     : center !important;
    padding-bottom : 5px !important;
    border-bottom  : 1px solid rgba(255,255,255,.07) !important;
    margin-bottom  : 2px !important;
    user-select    : none !important;
  }

  /* ── Sidebar pin tiles ── */
  .gpn6-tile {
    position      : relative !important;
    display       : flex !important;
    flex-direction: column !important;
    align-items   : center !important;
    justify-content: center !important;
    width         : 100% !important;
    min-height    : 34px !important;
    border-radius : 7px !important;
    font          : 700 9px/1.2 'Google Sans', system-ui, sans-serif !important;
    color         : #fff !important;
    text-align    : center !important;
    word-break    : break-all !important;
    padding       : 4px 3px !important;
    cursor        : pointer !important;
    pointer-events: all !important;
    user-select   : none !important;
    text-shadow   : 0 1px 4px rgba(0,0,0,.6) !important;
    box-shadow    : inset 0 1px 0 rgba(255,255,255,.18) !important;
    letter-spacing: .04em !important;
    transition    : transform .13s, filter .13s, box-shadow .16s !important;
  }
  .gpn6-tile:hover {
    transform  : scale(1.06) translateX(-3px) !important;
    filter     : brightness(1.18) !important;
    box-shadow : -3px 0 14px rgba(0,0,0,.5),
                 inset 0 1px 0 rgba(255,255,255,.22) !important;
  }
  .gpn6-del {
    display       : none !important;
    position      : absolute !important;
    top           : -5px !important;
    right         : -4px !important;
    width         : 15px !important;
    height        : 15px !important;
    background    : #111 !important;
    border-radius : 50% !important;
    border        : 1px solid rgba(255,255,255,.22) !important;
    font-size     : 9px !important;
    align-items   : center !important;
    justify-content: center !important;
    color         : #ccc !important;
    cursor        : pointer !important;
    pointer-events: all !important;
    z-index       : 2 !important;
    transition    : background .12s !important;
  }

  .gpn6-tile:hover .gpn6-del { display: flex !important; }
  .gpn6-del:hover { background: #e53935 !important; color: #fff !important; }

  /* ── Sync button ── */
  #gpn6-sync-btn {
    display        : flex !important;
    align-items    : center !important;
    justify-content: center !important;
    gap            : 4px !important;
    width          : 100% !important;
    padding        : 6px 4px !important;
    border-radius  : 7px !important;
    border         : 1px solid rgba(255,200,0,.35) !important;
    background     : rgba(255,200,0,.10) !important;
    color          : #ffe57a !important;
    font           : 700 8px/.9 'Google Sans', system-ui, sans-serif !important;
    letter-spacing : .08em !important;
    text-transform : uppercase !important;
    cursor         : pointer !important;
    pointer-events : all !important;
    user-select    : none !important;
    transition     : background .15s, border-color .15s, opacity .2s !important;
    flex-shrink    : 0 !important;
  }
  #gpn6-sync-btn:hover:not([disabled]) {
    background  : rgba(255,200,0,.22) !important;
    border-color: rgba(255,200,0,.70) !important;
  }
  #gpn6-sync-btn[disabled] {
    opacity : .45 !important;
    cursor  : not-allowed !important;
  }
  #gpn6-sync-btn.gpn6-syncing {
    animation: gpn6-syncPulse 1s ease-in-out infinite !important;
  }
  @keyframes gpn6-syncPulse {
    0%,100% { border-color: rgba(255,200,0,.35); }
    50%     { border-color: rgba(255,200,0,.90); }
  }
  #gpn6-sync-btn.gpn6-sync-done {
    border-color: rgba(76,175,80,.70) !important;
    background  : rgba(76,175,80,.15) !important;
    color       : #a5d6a7 !important;
    animation   : none !important;
  }

  /* ── Home / bottom button ── */
  #gpn6-home-btn {
    display        : flex !important;
    align-items    : center !important;
    justify-content: center !important;
    width          : 100% !important;
    padding        : 6px 4px !important;
    margin-top     : 4px !important;
    border-radius  : 7px !important;
    border         : 1px solid rgba(139,128,249,.35) !important;
    background     : rgba(139,128,249,.10) !important;
    color          : #c8c4ff !important;
    font           : 700 8px/.9 'Google Sans', system-ui, sans-serif !important;
    letter-spacing : .08em !important;
    text-transform : uppercase !important;
    cursor         : pointer !important;
    pointer-events : all !important;
    user-select    : none !important;
    flex-shrink    : 0 !important;
    transition     : background .15s, border-color .15s !important;
  }
  #gpn6-home-btn:hover {
    background  : rgba(139,128,249,.22) !important;
    border-color: rgba(139,128,249,.70) !important;
  }

  /* ╔═════════════════════════════════════════════╗
     ║  COLOR PICKER                               ║
     ╚═════════════════════════════════════════════╝ */
  #gpn6-picker {
    position      : fixed !important;
    display       : flex !important;
    gap           : 8px !important;
    padding       : 10px 13px !important;
    background    : rgba(14,12,22,.97) !important;
    border-radius : 12px !important;
    border        : 1px solid rgba(139,128,249,.32) !important;
    box-shadow    : 0 6px 30px rgba(0,0,0,.65) !important;
    z-index       : ${CFG.Z_PICKER} !important;
    pointer-events: all !important;
    animation     : gpn6-popin .14s ease !important;
  }
  .gpn6-swatch {
    width         : 26px !important;
    height        : 26px !important;
    border-radius : 50% !important;
    cursor        : pointer !important;
    border        : 2px solid transparent !important;
    pointer-events: all !important;
    flex-shrink   : 0 !important;
    transition    : transform .13s, border-color .13s, box-shadow .13s !important;
  }
  .gpn6-swatch:hover {
    transform   : scale(1.32) !important;
    border-color: rgba(255,255,255,.85) !important;
    box-shadow  : 0 0 8px currentColor !important;
  }

  /* ╔═════════════════════════════════════════════╗
     ║  NOTE / LABEL MODAL                         ║
     ╚═════════════════════════════════════════════╝ */
  #gpn6-overlay {
    position       : fixed !important;
    inset          : 0 !important;
    z-index        : ${CFG.Z_MODAL} !important;
    display        : flex !important;
    align-items    : center !important;
    justify-content: center !important;
    background     : rgba(0,0,0,.58) !important;
    backdrop-filter: blur(6px) !important;
    -webkit-backdrop-filter: blur(6px) !important;
    pointer-events : all !important;
    animation      : gpn6-fadein .17s ease !important;
    font-family    : 'Google Sans', system-ui, sans-serif !important;
  }
  #gpn6-modal {
    background    : #12121e !important;
    border-radius : 14px !important;
    padding       : 26px 28px 22px !important;
    width         : 295px !important;
    box-shadow    : 0 14px 52px rgba(0,0,0,.75) !important;
    display       : flex !important;
    flex-direction: column !important;
    gap           : 13px !important;
    pointer-events: all !important;
  }
  #gpn6-modal-title {
    font  : 700 15px/1.2 'Google Sans', system-ui, sans-serif !important;
    color : #dde0f8 !important;
  }
  #gpn6-modal-sub {
    font-size  : 11px !important;
    color      : rgba(255,255,255,.36) !important;
    margin-top : -8px !important;
  }
  #gpn6-modal-input {
    background    : #1c1c2e !important;
    border-radius : 8px !important;
    border        : 1.5px solid rgba(255,255,255,.14) !important;
    color         : #fff !important;
    padding       : 9px 12px !important;
    font          : 14px 'Google Sans', system-ui, sans-serif !important;
    outline       : none !important;
    width         : 100% !important;
    box-sizing    : border-box !important;
    pointer-events: all !important;
    transition    : border-color .15s !important;
  }
  #gpn6-modal-input:focus { border-color: rgba(139,128,249,.70) !important; }
  #gpn6-modal-row {
    display        : flex !important;
    gap            : 8px !important;
    justify-content: flex-end !important;
  }
  .gpn6-mbtn {
    padding      : 7px 18px !important;
    border-radius: 7px !important;
    border       : none !important;
    font         : 600 13px 'Google Sans', system-ui, sans-serif !important;
    cursor       : pointer !important;
    pointer-events: all !important;
    transition   : filter .13s, transform .11s !important;
  }
  .gpn6-mbtn:hover { filter: brightness(1.16) !important; transform: translateY(-1px) !important; }
  .gpn6-mbtn.cancel { background: #252538 !important; color: #999 !important; }
  .gpn6-mbtn.ok     { color: #fff !important; }

  /* ╔═════════════════════════════════════════════╗
     ║  FLASH ON TELEPORT                          ║
     ╚═════════════════════════════════════════════╝ */
  @keyframes gpn6-flash {
    0%   { outline: 3px solid var(--gpn6-c) !important; outline-offset: 2px; }
    50%  { outline: 3px solid var(--gpn6-c) !important; outline-offset: 9px; }
    100% { outline: 3px solid transparent  !important; outline-offset: 2px; }
  }
  .gpn6-flashing { animation: gpn6-flash .44s ease-in-out 5 !important; }

  /* ── Shared keyframes ── */
  @keyframes gpn6-popin {
    from { opacity:0; transform:scale(.88) translateY(-4px); }
    to   { opacity:1; transform:scale(1)   translateY(0); }
  }
  @keyframes gpn6-fadein {
    from { opacity:0; } to { opacity:1; }
  }
  `;
  document.head.appendChild(s);
  L.log('Styles injected.');
}

/* ══════════════════════════════════════════════════════════════════════
   FIND THE RESPONSE CURRENTLY IN THE VIEWPORT
   ──────────────────────────────────────────────────────────────────────
   Instead of blindly grabbing the last element in the DOM, we score
   every candidate by how many pixels of it are visible right now and
   return the winner — i.e. whatever the user is actually looking at.

   Scoring: visibleHeight = overlap between element rect and viewport.
   Tie-break: element that appears later in the DOM wins (most recent
   fully-visible block when multiple fill the screen equally).

   Falls back to the DOM-last element only when nothing is visible at
   all (e.g. the page hasn't scrolled yet and the viewport is empty).
   ══════════════════════════════════════════════════════════════════════ */
function findViewportResponse() {
  const strats = [
    () => $$('[data-test-id="response-container"],[data-test-id="model-response"]'),
    () => $$('model-response, ms-chat-turn'),
    () => $$('[role="presentation"]').filter(el =>
            el.querySelector('.model-response-text,.response-content,[class*="response"]')),
    () => $$('[class*="response-container"],[class*="model-turn"],[class*="chat-turn"]'),
  ];

  // Collect all candidates from the first strategy that returns anything
  let candidates = [];
  for (const fn of strats) {
    const list = fn();
    if (list.length) { candidates = list; break; }
  }

  if (!candidates.length) {
    L.warn('No response elements found.');
    return null;
  }

  const vpBottom = window.innerHeight;

  let best      = null;
  let bestScore = -1;

  candidates.forEach(el => {
    const r      = el.getBoundingClientRect();
    const visTop = Math.max(r.top,    0);
    const visBtm = Math.min(r.bottom, vpBottom);
    const score  = Math.max(0, visBtm - visTop);   // px overlap with viewport

    if (score > bestScore) {
      bestScore = score;
      best      = el;
    }
  });

  // Nothing on screen at all — fall back to DOM-last element
  if (bestScore <= 0) {
    L.warn('No response in viewport — falling back to last element.');
    return candidates[candidates.length - 1];
  }

  L.log('Viewport target: ' + Math.round(bestScore) + 'px visible.');
  return best;
}

/* ══════════════════════════════════════════════════════════════════════
   SIDEBAR
   ══════════════════════════════════════════════════════════════════════ */
function ensureSidebar() {
  if ($('#gpn6-sidebar')) return;
  const sb = document.createElement('div');
  sb.id = 'gpn6-sidebar';
  sb.classList.add('gpn6-empty');
  document.body.appendChild(sb);
}

function renderSidebar() {
  const sb = $('#gpn6-sidebar');
  if (!sb) return;
  // Safe DOM clear — no innerHTML, Trusted Types compliant
  while (sb.firstChild) sb.removeChild(sb.firstChild);

  if (!S.pins.length) { sb.classList.add('gpn6-empty'); return; }
  sb.classList.remove('gpn6-empty');

  // ── Sync button (above the header) ──────────────────────────────────
  const syncBtn = document.createElement('button');
  syncBtn.id        = 'gpn6-sync-btn';
  syncBtn.type      = 'button';
  syncBtn.title     = 'Scroll to top, force-load all messages, re-link lost pins';
  syncBtn.textContent = '⟳ SYNC PINS';
  syncBtn.addEventListener('click', e => {
    e.stopImmediatePropagation();
    e.preventDefault();
    syncPins(syncBtn);
  }, true);
  sb.appendChild(syncBtn);

  const hdr = document.createElement('div');
  hdr.id = 'gpn6-sb-hdr';
  hdr.textContent = '📍 PINS';
  sb.appendChild(hdr);

  // ── Conversational-order sort ──────────────────────────────────────
  // Priority 1: if both pins have live elements in the DOM, use
  //   compareDocumentPosition — the browser's own source-of-truth for
  //   which node physically appears first in the document tree.
  // Priority 2: if one or both are orphaned (element not in DOM),
  //   fall back to the saved scrollY offset.
  // S.pins itself is NOT mutated — storage order stays chronological.
  const sorted = S.pins.slice().sort((a, b) => {
    const elA = document.querySelector('[data-gpn6-id="' + a.id + '"]');
    const elB = document.querySelector('[data-gpn6-id="' + b.id + '"]');
    if (elA && elB) {
      // DOCUMENT_POSITION_FOLLOWING (4) means elB comes after elA → a first
      return elA.compareDocumentPosition(elB) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    }
    // At least one orphan — use saved scroll offset
    return a.scrollY - b.scrollY;
  });

  sorted.forEach(pin => {
    const tile = document.createElement('div');
    tile.className = 'gpn6-tile';
    tile.style.background = pin.color;
    tile.title = `Jump → ${pin.note}`;

    // Dim tiles whose element is not currently stamped in the DOM
    const live = !!document.querySelector('[data-gpn6-id="' + pin.id + '"]');
    if (!live) tile.style.opacity = '0.45';

    const lbl = document.createElement('span');
    lbl.textContent = pin.note;
    tile.appendChild(lbl);

    const del = document.createElement('span');
    del.className = 'gpn6-del';
    del.textContent = '×';
    del.title = 'Remove pin';
    del.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      removePin(pin.id);
    });
    tile.appendChild(del);

    tile.addEventListener('mousedown', e => {
      if (e.target !== del) { e.stopPropagation(); teleport(pin); }
    });
    sb.appendChild(tile);
  });

  // ── Home button — always at the bottom of the sidebar ───────────────
  const homeBtn = document.createElement('button');
  homeBtn.id          = 'gpn6-home-btn';
  homeBtn.type        = 'button';
  homeBtn.title       = 'Jump to the bottom of the conversation';
  homeBtn.textContent = '▼ BOTTOM';
  homeBtn.addEventListener('click', e => {
    e.stopImmediatePropagation();
    e.preventDefault();
    const c = findScrollContainer();
    c.scrollTop = c.scrollHeight;
  }, true);
  sb.appendChild(homeBtn);
}

/* ══════════════════════════════════════════════════════════════════════
   SYNC PINS  — Search & Rescue after page refresh
   ══════════════════════════════════════════════════════════════════════

   The problem: Gemini lazy-loads chat messages. After a refresh, old
   DOM nodes are gone and our data-gpn6-id stamps with them. Pins whose
   elements no longer exist fall back to scrollY and cannot flash.

   The fix — three phases:
   1. CLIMB  Scroll to window top (scrollY=0). Gemini begins rendering
             messages from the start of the conversation.
   2. WAIT   Poll until the page stops growing (document.body.scrollHeight
             stabilises for two consecutive checks 600ms apart). This
             signals that all lazy content has been injected.
   3. MATCH  For every pin whose data-gpn6-id is absent from the DOM,
             collect all response candidates and pick the one whose
             absolute scrollY is closest to pin.scrollY (primary signal).
             If two candidates tie within 150px, use textSnippet overlap
             as a tie-breaker.
             Re-stamp the winner with the pin's id.

   After the pass, renderSidebar() refreshes tile opacity and the
   button transitions to a green "DONE" state for 2.5 s.
   ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════
   FIND GEMINI'S SCROLLABLE CHAT CONTAINER
   ══════════════════════════════════════════════════════════════════════
   Gemini renders chat messages inside a specific overflow div — NOT
   on window / document.body. We find it by walking up from a known
   response element (or from the anchor) until we hit the first ancestor
   whose computed overflow-y is "auto" or "scroll" AND has actual
   scrollable height.

   Fallback chain if no response element exists yet:
     1. Walk up from [data-test-id="bard-text"] parent chain
     2. Known class/tag heuristics
     3. document.documentElement (last resort — will at least not throw)
   ══════════════════════════════════════════════════════════════════════ */
function findScrollContainer() {
  // Try to start from a rendered response element — most reliable
  const seedStrats = [
    () => document.querySelector('[data-test-id="response-container"],[data-test-id="model-response"]'),
    () => document.querySelector('model-response, ms-chat-turn'),
    () => document.querySelector('[class*="response-container"],[class*="model-turn"]'),
    () => document.querySelector('[data-test-id="bard-text"]'),
  ];

  let seed = null;
  for (const fn of seedStrats) { seed = fn(); if (seed) break; }

  if (seed) {
    let el = seed.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        L.log('Scroll container found:', el.tagName, el.className.slice(0, 60));
        return el;
      }
      el = el.parentElement;
    }
  }

  // Structural fallbacks
  const fallbacks = [
    'main',
    '[class*="chat-container"]',
    '[class*="conversation-container"]',
    '[class*="scroll-container"]',
    '[class*="content-container"]',
  ];
  for (const sel of fallbacks) {
    const el = document.querySelector(sel);
    if (el && el.scrollHeight > el.clientHeight) {
      L.log('Scroll container via fallback selector:', sel);
      return el;
    }
  }

  L.warn('No scroll container found — falling back to documentElement');
  return document.documentElement;
}

/* ══════════════════════════════════════════════════════════════════════
   SYNC PINS  — Incremental climb + live scan
   ══════════════════════════════════════════════════════════════════════

   Strategy (revised):
   Instead of jumping to the top and waiting, we scroll the chat
   container upward in 500px steps every 100ms. At each step we
   immediately scan for newly rendered elements that match orphaned
   pins. This directly mirrors how Gemini lazy-loads: content appears
   as the scroll position climbs past it.

   CLIMB LOOP  (setInterval, 100ms)
   ─────────────────────────────────────────────────────────────────────
   • Subtract 500px from container.scrollTop each tick.
   • After scrolling, call tryScanStep() to re-stamp any newly visible
     orphaned pins.
   • Stop when: scrollTop reaches 0, OR all orphaned pins are resolved.

   MATCHING (per step)
   ─────────────────────────────────────────────────────────────────────
   For each unresolved pin, check every currently-rendered response
   candidate. Accept the one whose absolute Y offset (container.scrollTop
   + element.getBoundingClientRect().top) is within MATCH_TOL px of the
   saved pin.scrollY. Closest match wins; claimed elements are excluded.

   MATCH_TOL = 400px — generous enough for layout reflow across screen
   sizes, tight enough to avoid cross-pin mismatches in dense chats.
   ══════════════════════════════════════════════════════════════════════ */
async function syncPins(btnEl) {
  if (S.syncing) return;
  S.syncing = true;

  const STEP_PX  = 500;   // px scrolled per tick
  const TICK_MS  = 100;   // ms between ticks
  const MATCH_TOL = 400;  // px tolerance for scrollY matching

  // ── UI: enter syncing state ──────────────────────────────────────────
  function setLabel(txt) { if (btnEl) btnEl.textContent = txt; }
  if (btnEl) { btnEl.disabled = true; btnEl.classList.add('gpn6-syncing'); }
  setLabel('⟳ FINDING…');

  // ── Locate the scrollable container ─────────────────────────────────
  const container = findScrollContainer();
  L.log('Sync using container:', container.tagName, '| scrollHeight:', container.scrollHeight);

  // ── Build the set of pins that still need re-linking ─────────────────
  // (pins whose data-gpn6-id attribute is absent from the live DOM)
  const orphans = new Set(
    S.pins
      .filter(p => !document.querySelector('[data-gpn6-id="' + p.id + '"]'))
      .map(p => p.id)
  );

  L.log('Orphaned pins to rescue:', orphans.size, '/', S.pins.length);

  if (orphans.size === 0) {
    // Nothing to do — all pins already live
    finishSync(0, btnEl);
    return;
  }

  let relinked = 0;
  setLabel('⟳ CLIMBING…');

  /* ── Core response selectors (same chain as findViewportResponse) ── */
  const RESP_SELS = [
    '[data-test-id="response-container"],[data-test-id="model-response"]',
    'model-response,ms-chat-turn',
    '[class*="response-container"],[class*="model-turn"],[class*="chat-turn"]',
  ];
  function getAllCandidates() {
    for (const sel of RESP_SELS) {
      const list = $$(sel);
      if (list.length) return list;
    }
    return [];
  }

  /* ── Per-tick scan — two-stage pipeline ────────────────────────────
     Stage 1 (STAMP): For each orphan, find the best-matching candidate
       within MATCH_TOL and stamp data-gpn6-id on it. Move the pin from
       `orphans` → `pending` (Map: pin.id → stamped element).
       We do NOT count it as "found" yet.

     Stage 2 (GRADUATE): For each pending pin, check whether the
       container has scrolled far enough to physically pass over the
       stamped element — i.e. container.scrollTop <= el.offsetTop.
       Only then is the pin considered fully re-linked and removed from
       `pending`. This guarantees Gemini has rendered the element at its
       correct position before we stop climbing.
     ────────────────────────────────────────────────────────────────── */

  // pending: Map< pin.id → stamped DOM element >
  const pending = new Map();

  function tryScanStep() {
    const candidates = getAllCandidates();
    const cTop = container.scrollTop;

    // Stage 1: stamp newly discoverable orphans
    if (orphans.size > 0) {
      S.pins.forEach(pin => {
        if (!orphans.has(pin.id)) return;

        let best = null, bestDist = Infinity;
        candidates.forEach(el => {
          if (el.hasAttribute('data-gpn6-id')) return;  // already claimed
          const absY = cTop + el.getBoundingClientRect().top;
          const dist = Math.abs(absY - pin.scrollY);
          if (dist < bestDist) { bestDist = dist; best = el; }
        });

        if (best && bestDist <= MATCH_TOL) {
          best.setAttribute('data-gpn6-id', pin.id);
          pin.scrollY = Math.round(cTop + best.getBoundingClientRect().top - 100);
          orphans.delete(pin.id);
          pending.set(pin.id, best);
          L.log('Stamped "' + pin.note + '" — waiting to scroll past (dist=' + Math.round(bestDist) + 'px)');
        }
      });
    }

    // Stage 2: graduate pending pins whose element has been scrolled past
    pending.forEach((el, id) => {
      // offsetTop is the element's top relative to its offsetParent,
      // which inside the scroll container equals its position in the
      // scrollable content area — directly comparable to scrollTop.
      const elOffsetTop = el.offsetTop;
      if (cTop <= elOffsetTop) {
        pending.delete(id);
        relinked++;
        L.log('Graduated pin id=' + id + ' (scrollTop=' + Math.round(cTop) + ' <= offsetTop=' + Math.round(elOffsetTop) + ')');
      }
    });
  }

  function allResolved() {
    return orphans.size === 0 && pending.size === 0;
  }

  /* ── Climb loop ─────────────────────────────────────────────────────────
     Three-phase recursive tick chain:

     PHASE A — CLIMBING  (scrollTop > 0)
       Scroll up STEP_PX per tick. After each scroll, yield 80ms for
       Gemini's lazy-loader, then call tryScanStep(). Keep going until
       scrollTop reaches 0 OR all pins are graduated.

     PHASE B — DWELL AT TOP  (scrollTop == 0, pins still pending)
       Hold at the top and keep scanning every DWELL_TICK ms.
       Gemini may still be injecting older elements into the DOM.

     Stop conditions (checked every tick):
       • allResolved() — all pins stamped AND scrolled past
       • SAFETY_MS exceeded — give up on truly missing pins
     ──────────────────────────────────────────────────────────────────── */
  const SAFETY_MS  = 20000;
  const DWELL_TICK = 250;
  const startTime  = Date.now();
  let atTopPhase   = false;

  await new Promise(resolve => {
    function tick() {
      if (Date.now() - startTime > SAFETY_MS) {
        if (!allResolved())
          L.warn('Sync timeout. orphans=' + orphans.size + ' pending=' + pending.size);
        resolve();
        return;
      }

      if (allResolved()) { resolve(); return; }

      if (container.scrollTop > 0) {
        atTopPhase = false;
        container.scrollTop = Math.max(0, container.scrollTop - STEP_PX);
        setTimeout(() => {
          tryScanStep();
          setLabel('⟳ ' + relinked + '/' + S.pins.length);
          setTimeout(tick, TICK_MS);
        }, 80);

      } else {
        if (!atTopPhase) {
          atTopPhase = true;
          L.log('At top — dwelling. orphans=' + orphans.size + ' pending=' + pending.size);
        }
        tryScanStep();
        setLabel('⟳ ' + relinked + '/' + S.pins.length + ' …');
        setTimeout(tick, DWELL_TICK);
      }
    }

    tick();
  });

  // Persist updated scrollY values for all re-linked pins
  if (relinked > 0) DB.savePins(S.cid, S.pins);

  // ── Auto-return: scroll back to the bottom of the conversation ───────
  setLabel('⟳ RETURNING…');
  container.scrollTop = container.scrollHeight;
  // Small pause so the user sees the container snap back before UI resets
  await pause(300);

  finishSync(relinked, btnEl);
}

function finishSync(relinked, btnEl) {
  renderSidebar();  // refresh tile opacity (dimmed = still-orphaned)

  const doneBtn = $('#gpn6-sync-btn');
  if (doneBtn) {
    doneBtn.classList.remove('gpn6-syncing');
    doneBtn.classList.add('gpn6-sync-done');
    doneBtn.textContent = '✓ ' + relinked + '/' + S.pins.length + ' SYNCED';
    setTimeout(() => {
      doneBtn.classList.remove('gpn6-sync-done');
      doneBtn.textContent = '⟳ SYNC PINS';
      doneBtn.disabled    = false;
    }, 2500);
  }

  S.syncing = false;
  L.log('Sync complete. Re-linked: ' + relinked + '/' + S.pins.length);
}

// Simple promise-based delay (used elsewhere)
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ══════════════════════════════════════════════════════════════════════
   TELEPORT + FLASH
   ══════════════════════════════════════════════════════════════════════ */
function teleport(pin) {
  const el = document.querySelector(`[data-gpn6-id="${pin.id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flash(el, pin.color);
    L.log('Teleport →', pin.id);
  } else {
    L.warn('Element gone — scrollY fallback:', pin.scrollY);
    window.scrollTo({ top: pin.scrollY, behavior: 'smooth' });
  }
}

function flash(el, color) {
  el.style.setProperty('--gpn6-c', color);
  el.classList.remove('gpn6-flashing');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('gpn6-flashing');
  setTimeout(() => el.classList.remove('gpn6-flashing'), CFG.FLASH_MS + 400);
}

/* ══════════════════════════════════════════════════════════════════════
   COLOR PICKER
   ══════════════════════════════════════════════════════════════════════ */
function showPicker(anchorEl, cb) {
  closePicker();
  const p = document.createElement('div');
  p.id = 'gpn6-picker';

  CFG.COLORS.forEach(c => {
    const sw = document.createElement('div');
    sw.className = 'gpn6-swatch';
    sw.style.cssText = `background:${c}; color:${c};`;
    sw.title = c;
    sw.addEventListener('mousedown', e => {
      e.stopPropagation(); e.preventDefault();
      closePicker();
      cb(c);
    });
    p.appendChild(sw);
  });

  // Position below the button (it's in the header, so always room below)
  const r  = anchorEl.getBoundingClientRect();
  const px = Math.max(8, Math.min(r.left, window.innerWidth - 230));
  const py = r.bottom + 8;
  p.style.cssText = `top:${py}px; left:${px}px;`;
  document.body.appendChild(p);

  setTimeout(() =>
    document.addEventListener('mousedown', outsidePickerClick, { capture: true, once: true })
  , 60);
}

function outsidePickerClick(e) {
  const p = $('#gpn6-picker');
  if (p && !p.contains(e.target)) closePicker();
  else if (p) document.addEventListener('mousedown', outsidePickerClick, { capture: true, once: true });
}
function closePicker() {
  $('#gpn6-picker')?.remove();
  document.removeEventListener('mousedown', outsidePickerClick, { capture: true });
}

/* ══════════════════════════════════════════════════════════════════════
   NOTE / LABEL MODAL
   All elements built with createElement + textContent — no innerHTML
   anywhere, fully Trusted Types compliant.
   ══════════════════════════════════════════════════════════════════════ */
function showNoteModal(color, cb) {
  closeModal();

  // ── Overlay (full-screen backdrop) ──────────────────────────────────
  const ov = document.createElement('div');
  ov.id = 'gpn6-overlay';

  // ── Modal card ───────────────────────────────────────────────────────
  const modal = document.createElement('div');
  modal.id = 'gpn6-modal';
  modal.style.border = `2px solid ${color}`;

  // Title
  const title = document.createElement('div');
  title.id          = 'gpn6-modal-title';
  title.textContent = '📍 Label this pin';

  // Subtitle
  const sub = document.createElement('div');
  sub.id          = 'gpn6-modal-sub';
  sub.textContent = `Max ${CFG.MAX_NOTE} chars — e.g. "BUG:1" or "TODO"`;

  // Text input
  const inp = document.createElement('input');
  inp.id          = 'gpn6-inp';
  inp.type        = 'text';
  inp.maxLength   = CFG.MAX_NOTE;
  inp.placeholder = 'NOTE:1';
  inp.autocomplete = 'off';
  inp.spellcheck  = false;

  // Button row
  const row = document.createElement('div');
  row.id = 'gpn6-modal-row';

  const can = document.createElement('button');
  can.id          = 'gpn6-cancel';
  can.type        = 'button';
  can.className   = 'gpn6-mbtn cancel';
  can.textContent = 'Cancel';

  const ok = document.createElement('button');
  ok.id                    = 'gpn6-ok';
  ok.type                  = 'button';
  ok.className             = 'gpn6-mbtn ok';
  ok.textContent           = 'Pin it ✓';
  ok.style.background      = color;

  // Assemble
  row.appendChild(can);
  row.appendChild(ok);
  modal.appendChild(title);
  modal.appendChild(sub);
  modal.appendChild(inp);
  modal.appendChild(row);
  ov.appendChild(modal);
  document.body.appendChild(ov);

  // ── Commit logic ─────────────────────────────────────────────────────
  const commit = () => {
    const v = inp.value.trim();
    if (!v) { inp.style.borderColor = '#FF5252'; inp.focus(); return; }
    closeModal();
    cb(v);
  };

  ok .addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); commit(); });
  can.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); closeModal(); });
  ov .addEventListener('mousedown', e => { if (e.target === ov) closeModal(); });

  // Capture all keystrokes so Gemini doesn't swallow them
  ['keydown', 'keyup', 'keypress'].forEach(ev =>
    inp.addEventListener(ev, e => {
      e.stopImmediatePropagation();
      if (ev === 'keydown') {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') closeModal();
      }
    }, true)
  );

  setTimeout(() => inp.focus(), 80);
}
function closeModal() {
  $('#gpn6-overlay')?.remove();
}

/* ══════════════════════════════════════════════════════════════════════
   PIN LIFECYCLE
   ══════════════════════════════════════════════════════════════════════ */
function pinLastResponse() {
  const target = findViewportResponse();
  if (!target) {
    L.warn('No Gemini response found to pin.');
    return;
  }
  const anchorBtn = $('#gpn6-btn') || document.body;
  showPicker(anchorBtn, color =>
    showNoteModal(color, note =>
      commitPin(target, color, note)
    )
  );
}

function commitPin(el, color, note) {
  const id = uid();
  el.setAttribute('data-gpn6-id', id);

  // Capture a short text snippet for secondary matching after re-renders
  const rawText   = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const snippet   = rawText.slice(0, 80);

  const pin = {
    id,
    color,
    note,
    snippet,
    // Absolute page offset — primary key for re-linking after refresh
    scrollY: Math.round(window.scrollY + el.getBoundingClientRect().top - 100),
  };

  S.pins.push(pin);
  DB.savePins(S.cid, S.pins);
  renderSidebar();
  updateBtnLabel();
  flash(el, color);
  L.log('Pin committed:', pin);
}

function removePin(id) {
  document.querySelector(`[data-gpn6-id="${id}"]`)?.removeAttribute('data-gpn6-id');
  S.pins = S.pins.filter(p => p.id !== id);
  DB.savePins(S.cid, S.pins);
  renderSidebar();
  updateBtnLabel();
  L.log('Pin removed:', id);
}

/* ══════════════════════════════════════════════════════════════════════
   LOAD PINS FROM STORAGE
   ══════════════════════════════════════════════════════════════════════ */
function loadPins() {
  S.pins = DB.loadPins(S.cid);
  L.log(`Loaded ${S.pins.length} pin(s) for "${S.cid}"`);
  renderSidebar();
  updateBtnLabel();
}

/* ══════════════════════════════════════════════════════════════════════
   SPA NAVIGATION DETECTION
   ══════════════════════════════════════════════════════════════════════ */
function onNav() {
  const newCid = convId();
  if (newCid === S.cid) return;
  L.log(`Nav: ${S.cid} → ${newCid}`);
  S.cid  = newCid;
  S.pins = [];
  renderSidebar();
  updateBtnLabel();
  setTimeout(loadPins, CFG.NAV_MS);
}

function watchSPA() {
  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = (...a) => { _push(...a);    onNav(); };
  history.replaceState = (...a) => { _replace(...a); onNav(); };
  window.addEventListener('popstate', onNav);

  let last = location.href;
  S.poll = setInterval(() => {
    if (location.href !== last) { last = location.href; onNav(); }
  }, CFG.POLL_MS);

  L.log('SPA watchers installed.');
}

/* ══════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════ */
function init() {
  L.log('══ Gemini Pin Navigator v6 — Header Anchor Edition ══');
  L.log('Button anchors to: [data-test-id="bard-text"] (Gemini logo span)');

  injectStyles();
  ensureSidebar();

  S.cid = convId();
  L.log('Conversation:', S.cid);

  watchSPA();
  startObserver(); // starts watching immediately so it catches the header render

  // Give Gemini time to render the header before first injection attempt
  setTimeout(() => {
    mountBtn();
    loadPins();
  }, CFG.INIT_MS);
}

/* ── Singleton guard ── */
if (window.__gpnv6) {
  L.warn('Already running — skipping duplicate init.');
} else {
  window.__gpnv6 = true;
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
}