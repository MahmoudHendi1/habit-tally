// @ts-check
// Shared pieces for every screen, and the contract a screen module follows. Styles: src/styles.css.
// Safe to import under `node --test`: nothing here touches the DOM until a function is called.
//
// ================================ THE SCREEN CONTRACT ================================
//
// 1. MODULE SHAPE
//    A screen (today.js, progress.js, settings.js, signin.js) exports:
//
//      export function render(state, ctx): string
//        The screen's whole HTML for this State (docs/contracts.md section 5). Pure: no DOM access, no
//        listeners, no store writes. It may read module-level variables (the screen's own UI state).
//      export function bind(root, ctx): void | (() => void)
//        Called once per mount, right after the first render, with the element that holds that HTML.
//        Attach delegated listeners to `root` here (rule 4) and focus something if you need to. It may
//        return a clean-up function, which runs when the screen is unmounted (tab change, sign-out):
//        unsubscribe there and reset the module-level UI state.
//      `root` is a <div class="screen">: a column with 16px between the top-level elements of your HTML.
//      export function dayChanged(ctx): void      (optional)
//        Called just before a render when the local day is not the one of the last render (midnight
//        passed): drop UI state that belonged to the old day, and tell the person with ctx.toast().
//
//    - signin.js is mounted while state.status is 'signedOut' OR 'waiting'; its render() switches on it.
//    - settings.js also exports `notice(state, ctx): string` (contracts section 11) and
//      `bindNotice(root, ctx): void`. While the status is 'ready' the shell shows the notice HTML above
//      whichever screen is active ('' = nothing) and re-renders it with every screen render.
//      bindNotice() is called once at start-up with the slot element, which lives as long as the page:
//      attach the notice's delegated listeners there (same rules as bind; it may be empty, but export
//      it, or the build warns).
//    - editor.js is not a screen. It exports `openEditor(habitId | null, ctx): void` and shows itself with
//      openSheet() (rule 3). Screens open it through ctx.openEditor().
//    - pwa.js exports `initPwa(): { swRegistration: () => Promise<ServiceWorkerRegistration | null> }`.
//    - Screen styles go in editor.css, progress.css and account.css. index.html already links all three:
//      do NOT `import` a .css file from a screen module, or `node --test` can no longer load the module.
//
// 2. RE-RENDERING
//    main.js calls render(state, ctx) after every store change, after ctx.refresh() and when the local
//    day changes, and applies the result with patch(root, html). patch() does not replace the DOM: it
//    edits the existing nodes until they match the new HTML. So across re-renders focus stays where it
//    is, scroll positions stay, CSS transitions run, and half-typed input is kept. What follows from that:
//    a. Give repeated siblings (list items, cards) data-key="<stable id>" (an `id` also counts), unique
//       among their siblings, so each keeps its own node when the list changes. Siblings without keys
//       are matched in order by tag name, which is right for parts that simply appear and disappear.
//    b. Form controls: render() gives a control its INITIAL value (`value`, `checked`, `selected`). Once
//       the person has typed in it or toggled it, the DOM owns the live value and later renders do not
//       overwrite it. To change one from code (clear a field, step a number), set `.value` / `.checked`
//       on the element in your handler. Read values in handlers from the DOM (`new FormData(form)`).
//    c. Every other attribute is owned by render(): one that is missing from the new HTML is removed.
//       If the person can change it (`<details open>`), keep that in a module-level variable and render
//       it, or put data-keep on the element: patch() never touches a data-keep element or its children
//       once it exists.
//    d. The screen's own UI state (picked day, form mode, error text, busy flag) lives in module-level
//       variables. After changing one, call ctx.refresh().
//    Store calls are synchronous and optimistic: the listeners have run, and the screen has been
//    re-rendered, before `store.addCount(...)` returns.
//
// 3. SHEETS (the editor, any dialog)
//    openSheet({ title, html, onClose, canClose }) shows a modal bottom sheet (a centred dialog on wide
//    screens) and returns { body, close }. A sheet is NOT re-rendered by main.js, on store changes or otherwise:
//    its content belongs to the module that opened it. Keep a draft in module-level variables, attach
//    delegated listeners to `sheet.body`, and when the draft changes call patch(sheet.body, html)
//    yourself (rules 2a to 2c apply, so typed text and focus survive). If the sheet must react to the
//    store, subscribe yourself and unsubscribe in onClose. The container does the rest: focus moves
//    into the sheet (to the element with `autofocus`, else the first control) and returns to the opener
//    (when the opener is gone, as after a delete: to the toast's action button, else the screen's h1);
//    Escape, the backdrop, the close button and any element with data-sheet-close close it; the page
//    behind is inert. A sheet with a draft to lose passes canClose(): boolean. It is asked before each
//    of those four ways of closing (Android's Back counts as Escape); when it returns false the sheet
//    stays open, and canClose itself shows why inside the sheet ("Discard changes?"). It is not asked
//    by the close() that openSheet returned, which is how the opener closes after a save or a discard,
//    nor by closeSheet(), which the shell calls when the screen behind changes. A second Back in a
//    row closes without asking: browsers do not let a page hold on to it. One sheet at a time. Toasts appear on the page, not above an open sheet: show a
//    sheet's errors inside the sheet.
//
// 4. EVENTS
//    Listen on `root` (or `sheet.body`) only, with on(root, 'click', '[data-action]', handler), and mark
//    elements with data-action="..." plus data-id or other data-* values. Never attach a listener to an
//    element inside root (patch() may replace it), never use inline on*= attributes, and attach to
//    `document` or `window` only if bind() returns a clean-up that removes the listener. In a handler,
//    read the newest state with ctx.store.getState().
//
// 5. ctx (one object, made once by main.js; the same for every screen and for the editor)
//      ctx.store                 the Store (docs/contracts.md section 5)
//      ctx.push                  the Push object (section 6); never import push.js in a screen
//      ctx.pwa                   whatever initPwa() returned
//      ctx.today(): string       the device's local day 'YYYY-MM-DD'; follows the clock, so call it in
//                                render() and in handlers and never keep the result
//      ctx.navigate(tab)         'today' | 'progress' | 'settings' (sets the address to #/tab)
//      ctx.openEditor(habitId)   open the editor for that habit; null or nothing = a new habit
//      ctx.openRoutine(routineId) open the routine editor (src/ui/routine.js); null or nothing = a new routine
//      ctx.toast(message, { actionLabel, onAction, duration })    e.g. ctx.toast('Deleted.', {
//                                actionLabel: 'Undo', onAction: () => ctx.store.restoreHabit(id) })
//      ctx.signOut(): Promise    THE sign-out sequence; every sign-out button calls this, nothing else
//      ctx.getTheme()            'system' | 'light' | 'dark'
//      ctx.setTheme(theme)       applies it now and remembers it; 'system' forgets the choice
//      ctx.refresh()             re-render the mounted screen (and the notice slot) now
//
// 6. USER TEXT
//    Habit names, units, emails, ids, error messages, anything read from the DOM: every value that
//    comes from a person or from the backend goes through esc() on its way into HTML, in text and in
//    attributes. Only numbers and the day keys made by shared/logic.js may go in bare. toast() and
//    announce() take plain text and need no escaping.
//
// 7. HELPERS EXPORTED HERE
//    esc, patch, on, icon, tallyMarks, formatDay, screenHead, emptyState, openSheet, closeSheet, toast,
//    clearToasts, announce, getTheme, setTheme. Dates, counts, streaks and validation come from shared/logic.js.
//
// 8. CSS VOCABULARY (all defined in styles.css; reuse before inventing)
//    Colours, never literals: --bg page, --surface cards and sheets, --sunk recessed areas, --ink text,
//      --muted secondary text, --line hairlines, --line-strong borders of controls, --accent filled
//      controls, --accent-ink text on --accent, --accent-soft tinted background, --accent-text accent-
//      coloured text and icons, --warn / --warn-soft, --danger / --danger-soft, --heat0 to --heat3
//      calendar levels (shared/logic.js calendarWeeks), --focus. Each has a light and a dark value.
//    Sizes: --r, --r-sm radii; --tap (44px) smallest touch target; --gap (16px) page gutter.
//    Layout: .stack (column, 16px gaps), .row (wrapping row, 8px gaps), .spread (row, ends apart).
//    Text: .screen-head with .eyebrow and h1 (use screenHead(); an h1 written by hand carries
//      tabindex="-1", so focus can fall back to it); h2; .muted; .small; .num (tabular figures); .sr-only.
//    Surfaces: .card; .chip, .chip-done, .chip-warn; .notice, .notice-warn; .empty (use emptyState()).
//    Buttons (all at least 44px high; aria-disabled="true" on a .btn-round dims it like `disabled` but
//      keeps the focus, and the handler must ignore the tap): .btn plus .btn-primary, .btn-danger, .btn-quiet (no border),
//      .btn-block (full width), .btn-dashed; .btn-round (44px circle) plus .btn-plus (56px, filled);
//      .icon-btn (44px square, icon only: give it an aria-label).
//    Forms: .field > label + .input (+ .field-hint, .field-error); select.input;
//      fieldset.segmented > legend + label > (input[type=radio] + span) for 2 to 4 choices.
//    Sheets: .sheet-actions (button row at the bottom of a sheet).
//    Tally: tallyMarks() output; .tally.is-done draws it in the accent colour.
// =====================================================================================
import { parseKey } from '../../shared/logic.js';

/** @typedef {import('../store-local.js').State} State */
/** @typedef {import('../store-local.js').Habit} Habit */
/** @typedef {'system' | 'light' | 'dark'} Theme */
/** @typedef {{ actionLabel?: string, onAction?: () => void, duration?: number }} ToastOptions */
/** @typedef {ReturnType<typeof import('../store-local.js').createLocalStore>} Store docs/contracts.md section 5 */
/** @typedef {'demo' | 'unsupported' | 'off' | 'blocked' | 'on'} PushStatus */
/** @typedef {{ getStatus: () => PushStatus, subscribe: (fn: (status: PushStatus) => void) => () => void,
 *     enable: () => Promise<PushStatus>, disable: () => Promise<void>, detach: () => Promise<void>,
 *     resume: () => Promise<void> }} Push docs/contracts.md section 6 */
/**
 * @typedef {object} Ctx
 * @property {Store} store
 * @property {Push} push
 * @property {ReturnType<typeof import('../pwa.js').initPwa>} pwa
 * @property {() => string} today
 * @property {(tab: 'today' | 'progress' | 'settings') => void} navigate
 * @property {(habitId?: string | null) => void} openEditor
 * @property {(routineId?: string | null) => void} openRoutine
 * @property {(message: string, options?: ToastOptions) => void} toast
 * @property {() => Promise<void>} signOut
 * @property {() => Theme} getTheme
 * @property {(theme: Theme) => void} setTheme
 * @property {() => void} refresh
 */
/** @typedef {{ render: (state: State, ctx: Ctx) => string,
 *     bind: (root: HTMLElement, ctx: Ctx) => void | (() => void), dayChanged?: (ctx: Ctx) => void }} Screen */

// ---------- text ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Make any value safe to put into HTML, as text or inside a quoted attribute.
 *  @param {unknown} text @returns {string} */
export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ESCAPES[/** @type {keyof typeof ESCAPES} */ (c)]);

const DAY_STYLES = {
  long: { weekday: 'long', day: 'numeric', month: 'long' },      // Friday 13 November
  short: { weekday: 'short', day: 'numeric', month: 'short' },   // Fri 13 Nov
  date: { day: 'numeric', month: 'short', year: 'numeric' },     // 13 Nov 2026
  weekday: { weekday: 'short' },                                  // Fri
};

/** A day key as English text. The app is English only, so a non-English browser gets British dates.
 *  @param {string} key 'YYYY-MM-DD'
 *  @param {keyof typeof DAY_STYLES | Intl.DateTimeFormatOptions} [style]
 *  @returns {string} plain text: escape it like any other value */
export function formatDay(key, style = 'long') {
  const own = typeof navigator !== 'undefined' && /^en\b/.test(navigator.language || '') ? navigator.language : 'en-GB';
  const options = typeof style === 'string' ? DAY_STYLES[style] : style;
  return parseKey(key).toLocaleDateString(own, /** @type {Intl.DateTimeFormatOptions} */ (options));
}

// ---------- rendering ----------

/** What a node is when old children are matched to new ones: its key, else its tag (and input type),
 *  else "text". The second value says whether it is keyed.
 *  @param {Node} node @returns {[string, boolean]} */
function kindOf(node) {
  if (!(node instanceof Element)) return [`#${node.nodeType}`, false];
  const key = node.getAttribute('data-key') || node.id;
  return key ? [`${node.nodeName}=${key}`, true] : [`${node.nodeName}:${node.getAttribute('type') ?? ''}`, false];
}

/** @param {Node} from @param {Node} to */
function morphNode(from, to) {
  if (!(from instanceof Element) || !(to instanceof Element)) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.hasAttribute('data-keep') || from.isEqualNode(to)) return;
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  morphChildren(from, to);
}

/** Pair each new child with the old child it continues: the longest run of same-kind nodes in the same
 *  order (so one element appearing or disappearing never rebuilds its neighbours). Paired nodes stay
 *  where they are and are edited in place; a keyed node that changed place is moved; the rest of the
 *  old nodes go and the rest of the new ones come in.
 *  @param {Node} from @param {Node} to */
function morphChildren(from, to) {
  const olds = [...from.childNodes], news = [...to.childNodes];
  const a = olds.map((n) => kindOf(n)[0]), b = news.map((n) => kindOf(n)[0]);
  /** @type {Map<Node, Node>} new node -> old node */
  const pairs = new Map();
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) pairs.set(news[start], olds[start++]);
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) pairs.set(news[--endB], olds[--endA]);
  const rows = endA - start, cols = endB - start;
  if (rows > 0 && cols > 0) { // longest common subsequence of what is left in the middle
    const len = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        len[i][j] = a[start + i] === b[start + j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
      }
    }
    for (let i = 0, j = 0; i < rows && j < cols;) {
      if (a[start + i] === b[start + j]) pairs.set(news[start + j++], olds[start + i++]);
      else if (len[i + 1][j] >= len[i][j + 1]) i++;
      else j++;
    }
  }
  const paired = new Set(pairs.values());
  /** @type {Map<string, Node>} keyed old nodes that are wanted in another place */
  const moved = new Map();
  for (const node of olds) {
    if (paired.has(node)) continue;
    from.removeChild(node);
    const [kind, keyed] = kindOf(node);
    if (keyed) moved.set(kind, node);
  }
  let old = from.firstChild;
  for (const next of news) {
    const match = pairs.get(next) ?? moved.get(kindOf(next)[0]);
    if (!match) from.insertBefore(next, old);
    else {
      if (match === old) old = old.nextSibling;
      else from.insertBefore(match, old);
      morphNode(match, next);
    }
  }
}

/** Make `root`'s content match `html` by editing the existing nodes in place (contract rule 2).
 *  @param {Element} root @param {string} html */
export function patch(root, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  morphChildren(root, template.content);
}

/** Delegated listener: `handler(event, el)` runs when the event comes from inside an element of `root`
 *  that matches `selector`; `el` is that element. Use 'focusin'/'focusout' for focus (they bubble).
 *  @param {Element} root @param {string} type @param {string} selector
 *  @param {(event: any, el: HTMLElement) => void} handler */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (event) => {
    const el = event.target instanceof Element ? event.target.closest(selector) : null;
    if (el instanceof HTMLElement && root.contains(el)) handler(event, el);
  });
}

// ---------- shared HTML ----------

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  forward: '<path d="M9 6l6 6-6 6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  sort: '<path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4"/>',
};

/** An inline icon in the current text colour, hidden from screen readers (label the button instead).
 *  @param {keyof typeof ICONS} name @param {number} [size] in px @returns {string} HTML */
export function icon(name, size = 24) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

const TALLY_GROUPS_MAX = 12;
const TALLY_LEAN = [0.7, -0.5, 0.4, -0.6]; // each upright leans a little, like marks made by hand

/** Tally marks: gates of five (four uprights, then a strike across them). Marks up to `count` are
 *  drawn solid and the uprights still to go up to `target` faintly, so the row shows how far there is
 *  to go. Decorative (aria-hidden): say the numbers in text next to it. At most 60 marks are drawn; a
 *  higher count ends with "+N".
 *  @param {number} count @param {number} [target] @returns {string} HTML */
export function tallyMarks(count, target = 0) {
  const marks = Math.min(Math.max(count, target), TALLY_GROUPS_MAX * 5);
  let out = '';
  for (let first = 0; first < marks; first += 5) {
    let lines = '';
    for (let i = 0; i < Math.min(4, marks - first); i++) {
      const x = 5 + i * 6;
      lines += `<line x1="${x + TALLY_LEAN[i]}" y1="2.5" x2="${x - TALLY_LEAN[i]}" y2="17.5"${first + i < count ? ' class="on"' : ''}/>`;
    }
    if (count >= first + 5) lines += '<line x1="1.5" y1="15" x2="26.5" y2="5" class="on"/>';
    out += `<svg width="28" height="20" viewBox="0 0 28 20">${lines}</svg>`;
  }
  if (count > marks) out += `<span class="tally-more num">+${count - marks}</span>`;
  return `<div class="tally${target > 0 && count >= target ? ' is-done' : ''}" aria-hidden="true">${out}</div>`;
}

/** The heading block at the top of a screen. Both values are plain text.
 *  @param {{ title: string, eyebrow?: string }} head @returns {string} HTML */
export function screenHead({ title, eyebrow = '' }) {
  return `<header class="screen-head">${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}<h1 tabindex="-1">${esc(title)}</h1></header>`;
}

/** A friendly "nothing here yet" card, with an optional button that carries data-action="<action>".
 *  All values are plain text.
 *  @param {{ title: string, text: string, actionLabel?: string, action?: string }} empty @returns {string} HTML */
export function emptyState({ title, text, actionLabel = '', action = '' }) {
  return `<div class="empty">${tallyMarks(5)}<h2>${esc(title)}</h2><p>${esc(text)}</p>`
    + (actionLabel ? `<button type="button" class="btn btn-primary" data-action="${esc(action)}">${esc(actionLabel)}</button>` : '')
    + '</div>';
}

// ---------- sheet ----------

/** @type {HTMLDialogElement | null} */
let openDialog = null;

/** Close the sheet that is open, if any. */
export function closeSheet() {
  openDialog?.close();
}

/** Show a modal sheet (contract rule 3).
 *  @param {{ title: string, html: string, onClose?: () => void, canClose?: () => boolean }} options
 *    `title` is plain text; `canClose` may refuse a close the person asked for (not close() or closeSheet())
 *  @returns {{ body: HTMLElement, close: () => void }} `body` holds `html`: bind and patch that element */
export function openSheet({ title, html, onClose, canClose }) {
  closeSheet();
  const opener = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.setAttribute('aria-labelledby', 'sheet-title');
  dialog.innerHTML = `<div class="sheet-panel"><header class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>`
    + `<button type="button" class="icon-btn" data-sheet-close aria-label="Close">${icon('close')}</button></header>`
    + '<div class="sheet-body"></div></div>';
  const body = /** @type {HTMLElement} */ (dialog.querySelector('.sheet-body'));
  body.innerHTML = html;
  // A click lands on the dialog itself only when it is on the backdrop. It must also have started
  // there, so selecting text with a drag that ends outside the sheet does not close it.
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => {
    downOnBackdrop = event.target === dialog;
  });
  dialog.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (((target === dialog && downOnBackdrop) || target.closest('[data-sheet-close]')) && (!canClose || canClose())) dialog.close();
  });
  if (canClose) {
    // Escape is answered here, on the key itself: after one refused `cancel` event a browser closes
    // the dialog on the next Escape without asking again.
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      if (canClose()) dialog.close();
    });
    dialog.addEventListener('cancel', (event) => { // Android's Back button
      if (!canClose()) event.preventDefault();
    });
  }
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (openDialog === dialog) openDialog = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    else { // the opener is gone (its habit was deleted): do not leave the focus on <body>
      /** @type {HTMLElement | null} */
      const next = document.querySelector('#toasts .toast-action') ?? document.querySelector('#screen h1[tabindex]');
      next?.focus();
    }
    onClose?.();
  }, { once: true });
  document.body.append(dialog);
  openDialog = dialog;
  dialog.showModal();
  return { body, close: () => dialog.close() };
}

// ---------- toast and announcements ----------

let toastTimer = 0;

/** Take away the toast that is showing, if any (main.js: when the person is signed out). */
export function clearToasts() {
  clearTimeout(toastTimer);
  document.getElementById('toasts')?.replaceChildren();
}

/** Show a short message at the bottom of the page, optionally with one action ("Deleted." + Undo).
 *  It leaves by itself (4 s, or 8 s with an action; never while it is hovered or has the keyboard's
 *  focus), and a new toast replaces the one showing. Screen readers hear it.
 *  @param {string} message plain text @param {ToastOptions} [options] */
export function toast(message, { actionLabel, onAction, duration } = {}) {
  const region = document.getElementById('toasts');
  if (!region) return;
  const box = document.createElement('div');
  box.className = 'toast';
  box.append(Object.assign(document.createElement('span'), { textContent: message }));
  const leave = () => {
    clearTimeout(toastTimer);
    box.remove();
  };
  const wait = () => {
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(leave, duration ?? (actionLabel ? 8000 : 4000));
  };
  if (actionLabel && onAction) {
    const action = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-action', textContent: actionLabel });
    action.addEventListener('click', () => {
      leave();
      onAction();
    });
    box.append(action);
  }
  box.addEventListener('pointerenter', () => clearTimeout(toastTimer));
  // Focus that a script put on the action after a tap (a sheet closing) is not somebody reading the
  // toast: only focus that shows a ring holds it, or it would stay until the next tap elsewhere.
  box.addEventListener('focusin', () => {
    if (box.querySelector(':focus-visible')) clearTimeout(toastTimer);
  });
  for (const type of ['pointerleave', 'focusout']) box.addEventListener(type, wait);
  region.replaceChildren(box);
  wait();
}

/** Tell screen-reader users about a change they cannot see (a count going up). Shows nothing.
 *  @param {string} message plain text */
export function announce(message) {
  const region = document.getElementById('announcer');
  if (region) region.textContent = message;
}

// ---------- theme ----------

const THEME_KEY = 'habit-tally:theme';
/** @param {unknown} value @returns {Theme} */
const asTheme = (value) => (value === 'light' || value === 'dark' ? value : 'system');

/** The browser bar takes the page colour of the theme in use. */
function paintBrowserBar() {
  const colour = getComputedStyle(document.body).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colour);
}

/** @param {Theme} theme */
function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  paintBrowserBar();
}

/** The person's choice: 'light' or 'dark', or 'system' when they follow the device.
 *  @returns {Theme} */
export function getTheme() {
  return asTheme(document.documentElement.getAttribute('data-theme'));
}

/** Apply a theme now and remember it for this browser; 'system' forgets the choice.
 *  @param {Theme} theme */
export function setTheme(theme) {
  const chosen = asTheme(theme);
  try {
    if (chosen === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, chosen);
  } catch { /* storage is blocked: the choice lasts until the page is closed */ }
  applyTheme(chosen);
}

/** Called once by main.js. index.html has already set data-theme before the first paint. */
export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch { /* storage is blocked: follow the device */ }
  applyTheme(asTheme(saved));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintBrowserBar);
}
