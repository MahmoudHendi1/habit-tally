// The app shell: boot, the sign-in gate, the three tabs (by address hash), notices, the sign-out
// sequence and the midnight check. How a screen plugs in: the contract at the top of src/ui/common.js.
import { keyOf } from '../shared/logic.js';
import { createStore, BACKEND } from './store.js';
import { createPush } from './push.js';
import { initPwa } from './pwa.js';
import { esc, patch, toast, clearToasts, closeSheet, initTheme, getTheme, setTheme } from './ui/common.js';
import * as today from './ui/today.js';
import * as progress from './ui/progress.js';
import * as settings from './ui/settings.js';
import * as signin from './ui/signin.js';
import { openEditor } from './ui/editor.js';

/** @typedef {import('./ui/common.js').State} State */
/** @typedef {import('./ui/common.js').Ctx} Ctx */
/** @typedef {import('./ui/common.js').Screen} Screen */
/** @typedef {'loading' | 'signin' | 'today' | 'progress' | 'settings'} View */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const app = $('app'), tabs = $('tabs'), noticesEl = $('notices'), noticeSlot = $('notice-slot'), screenEl = $('screen');

// index.html draws the splash before any script runs; the same HTML serves while the store is loading.
const splashHtml = screenEl.innerHTML;
/** @type {Record<View, Screen>} */
const SCREENS = { loading: { render: () => splashHtml, bind() {} }, signin, today, progress, settings };
const TITLES = { loading: '', signin: '', today: 'Today', progress: 'Progress', settings: 'Settings' };

initTheme();
const pwa = initPwa();
const store = await createStore().catch((err) => {
  screenEl.innerHTML = '<p class="notice notice-warn" role="alert">Habit Tally could not start. Check your connection and reload the page.</p>';
  throw err;
});
const push = createPush({ store, swRegistration: pwa.swRegistration });

/** The one sign-out sequence (docs/contracts.md section 6). Every sign-out button calls this. */
async function signOut() {
  await push.detach?.(); // optional only until package B5 replaces the placeholder push.js
  await store.signOut();
}

/** @type {Ctx} */
const ctx = {
  store, push, pwa,
  today: () => keyOf(new Date()),
  navigate: (tab) => {
    location.hash = `#/${tab}`;
  },
  openEditor: (habitId = null) => openEditor(habitId, ctx),
  toast, signOut, getTheme, setTheme,
  refresh: update,
};

/** The tab named by the address. Unknown addresses mean Today, and the address is corrected. @returns {View} */
function tabFromAddress() {
  const name = location.hash.replace(/^#\/?/, '');
  const tab = name === 'progress' || name === 'settings' ? name : 'today';
  if (location.hash && location.hash !== `#/${tab}`) history.replaceState(null, '', `#/${tab}`);
  return tab;
}

/** @param {State} state @returns {string} */
function shellNotices(state) {
  return (state.mode === 'demo' ? '<p class="notice notice-demo" data-key="demo">Demo: saved in this browser only</p>' : '')
    + (state.lastError ? `<p class="notice notice-warn" data-key="error" role="alert">${esc(state.lastError.message)}</p>` : '');
}

/** @type {{ view: View | null, root: HTMLElement | null, cleanup: void | (() => void) }} */
let mounted = { view: null, root: null, cleanup: undefined };
let lastStatus = '';
let dayDrawn = '';

function draw() {
  const state = store.getState();
  const ready = state.status === 'ready';
  /** @type {View} */
  const view = state.status === 'loading' ? 'loading' : ready ? tabFromAddress() : 'signin';
  dayDrawn = ctx.today();

  if (ready && lastStatus !== 'ready') push.resume().catch(() => { /* reminders stay as they were; Settings shows the status */ });
  if (lastStatus === 'ready' && !ready) {
    clearToasts(); // "Deleted <habit name>." must not stay on the sign-in screen
    // Signing out from Settings must not bring the next person back to Settings.
    if (location.hash) history.replaceState(null, '', '#/today');
  }
  lastStatus = state.status;

  app.dataset.view = view;
  document.title = TITLES[view] ? `${TITLES[view]} · Habit Tally` : 'Habit Tally';
  tabs.hidden = !ready;
  for (const link of tabs.querySelectorAll('a')) {
    if (link.getAttribute('href') === `#/${view}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  patch(noticesEl, view === 'loading' ? '' : shellNotices(state));
  patch(noticeSlot, ready ? settings.notice(state, ctx) : '');

  const screen = SCREENS[view];
  if (mounted.view !== view || !mounted.root) {
    mounted.cleanup?.();
    closeSheet();
    const root = document.createElement('div');
    root.className = 'screen';
    patch(root, screen.render(state, ctx));
    screenEl.replaceChildren(root);
    window.scrollTo(0, 0);
    mounted = { view, root, cleanup: undefined };
    mounted.cleanup = screen.bind(root, ctx);
  } else patch(mounted.root, screen.render(state, ctx));
}

let drawing = false, drawAgain = false;

/** Render now. A change made while rendering (a screen's bind() writing to the store) renders once more. */
function update() {
  if (drawing) {
    drawAgain = true;
    return;
  }
  drawing = true;
  try {
    do {
      drawAgain = false;
      draw();
    } while (drawAgain);
  } finally {
    drawing = false;
  }
}

/** "Today" follows the clock: when the app stays open past midnight, draw the new day. */
function checkDay() {
  if (!document.hidden && ctx.today() !== dayDrawn) update();
}

settings.bindNotice?.(noticeSlot, ctx);
store.subscribe(update);
window.addEventListener('hashchange', update);
document.addEventListener('visibilitychange', checkDay);
window.addEventListener('focus', checkDay);
window.addEventListener('pageshow', checkDay);
setInterval(checkDay, 20_000);

// A handle for browser tests and the console, never in the real app.
if (BACKEND !== 'firebase') /** @type {any} */ (window).habitTally = ctx;
