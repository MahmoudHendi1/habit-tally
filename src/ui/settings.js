// @ts-check
// The Settings screen (account, reminders, theme) and the time-zone prompt the shell shows above every
// screen: R10, R4, R14. Screen contract: src/ui/common.js. Push statuses: docs/contracts.md section 6.
// Time-zone prompt: section 11.
import { esc, on, screenHead, announce } from './common.js';

/** @typedef {import('./common.js').State} State */
/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./common.js').PushStatus} PushStatus */

const TZ_DECLINED_KEY = 'habit-tally:tz-declined';

/** What the Reminders card says for each push status. All plain text.
 *  @type {Record<PushStatus, { chip: string, chipClass: string, text: string }>} */
const PUSH = {
  demo: { chip: 'Not in the demo', chipClass: '', text: 'Reminders are not available in demo mode. In the full app, this is where you turn them on.' },
  unsupported: { chip: 'Not supported', chipClass: '', text: 'This browser cannot show reminders. On an iPhone or iPad, add Habit Tally to the Home Screen first and open it from there.' },
  off: { chip: 'Off', chipClass: '', text: 'Get a notification on this device at the reminder times you set for each habit.' },
  blocked: { chip: 'Blocked', chipClass: ' chip-warn', text: 'Notifications are blocked for Habit Tally in this browser. Allow them in the browser’s settings for this site, then come back here.' },
  on: { chip: 'On', chipClass: ' chip-done', text: 'This device gets a notification at the reminder times you set for each habit.' },
};
const THEMES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

// The screen's own state (contract rule 2d). bind()'s clean-up puts it back.
/** @type {'' | 'push' | 'sign-out'} */
let busy = '';
let visit = 0; // goes up when the screen is unmounted, so a result that arrives later is dropped
/** The declined zone, for a browser that blocks storage: then "Keep" lasts until the page is closed. */
let declinedHere = '';

// ---------- time zone ----------

/** The device's zone, e.g. 'Europe/Berlin'; '' when the browser does not say. */
function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** The device zone the person answered "Keep" for, or ''. */
function declinedZone() {
  try {
    return localStorage.getItem(TZ_DECLINED_KEY) || '';
  } catch {
    return declinedHere;
  }
}

/** @param {string} zone '' forgets the answer */
function rememberDeclined(zone) {
  declinedHere = zone;
  try {
    if (zone) localStorage.setItem(TZ_DECLINED_KEY, zone);
    else localStorage.removeItem(TZ_DECLINED_KEY);
  } catch { /* storage is blocked: declinedHere holds it for this visit */ }
}

/** The person said yes: reminders follow `zone` from now on. Undo puts the old zone back and counts as "Keep".
 *  @param {string} zone @param {Ctx} ctx */
function switchZone(zone, ctx) {
  const before = ctx.store.getState().user?.tz ?? '';
  ctx.store.setTimeZone(zone);
  if (ctx.store.getState().user?.tz !== zone) {
    ctx.toast('Could not change the time zone. Try again.');
    return;
  }
  rememberDeclined('');
  ctx.toast(`Reminders now use ${zone} time.`, before ? {
    actionLabel: 'Undo',
    onAction: () => {
      rememberDeclined(zone);
      ctx.store.setTimeZone(before);
    },
  } : {});
}

/** The time-zone prompt shown above every screen (docs/contracts.md section 11). '' = nothing to show.
 *  @param {State} state @param {Ctx} _ctx @returns {string} */
export function notice(state, _ctx) {
  const account = state.user?.tz ?? '', device = deviceZone();
  if (state.status !== 'ready' || !account || !device || device === account || declinedZone() === device) return '';
  return `<div class="notice account-tz" data-key="tz" role="group" aria-label="Time zone of your reminders">
    <p>Your reminders use <strong>${esc(account)}</strong> time. Switch to <strong>${esc(device)}</strong>?</p>
    <div class="row">
      <button type="button" class="btn btn-primary" data-action="tz-switch" data-zone="${esc(device)}">Switch</button>
      <button type="button" class="btn" data-action="tz-keep" data-zone="${esc(device)}">Keep</button>
    </div>
  </div>`;
}

/** Listeners for the notice, attached once to the slot the shell keeps for it.
 *  @param {HTMLElement} root @param {Ctx} ctx */
export function bindNotice(root, ctx) {
  on(root, 'click', '[data-action]', (_event, el) => {
    const { action, zone = '' } = el.dataset;
    if (action === 'tz-switch') switchZone(zone, ctx);
    else if (action === 'tz-keep') {
      rememberDeclined(zone);
      ctx.refresh();
      ctx.toast('Kept. You can switch the time zone later in Settings.');
    }
  });
}

// ---------- the screen ----------

/** @param {string} action @param {string} label @param {string} busyLabel @param {string} classes */
function button(action, label, busyLabel, classes) {
  const waiting = busy === action;
  return `<button type="button" class="${classes}${waiting ? ' account-busy' : ''}" data-action="${action}"`
    + `${waiting ? ' aria-busy="true" aria-disabled="true"' : ''}>${waiting ? busyLabel : label}</button>`;
}

/** @param {State} state */
function accountCard(state) {
  const note = state.mode === 'demo'
    ? '<p class="notice" data-key="demo"><strong>Demo mode.</strong> Your habits and counts are saved in this browser only. Nothing is sent anywhere, and clearing this site’s data in the browser removes them.</p>'
    : state.mode === 'emulator'
      ? '<p class="notice" data-key="demo"><strong>Test mode.</strong> This build talks to a local test server, not to the real app.</p>'
      : '';
  return `<section class="card stack" aria-labelledby="settings-account">
    <h2 id="settings-account">Account</h2>
    <p class="account-who"><span class="muted small">Signed in as</span><span class="account-email">${esc(state.user?.email)}</span></p>
    ${note}
    <div class="row" data-key="actions">${button('sign-out', 'Sign out', 'Signing out…', 'btn')}</div>
  </section>`;
}

/** @param {State} state @param {Ctx} ctx */
function remindersCard(state, ctx) {
  const status = ctx.push.getStatus(), info = PUSH[status] ?? PUSH.unsupported;
  const account = state.user?.tz ?? '', device = deviceZone();
  const action = status === 'off' ? button('push-on', 'Turn on reminders', 'Turning on…', 'btn btn-primary')
    : status === 'on' ? button('push-off', 'Turn off reminders', 'Turning off…', 'btn') : '';
  const zone = !account ? '<p class="muted" data-key="none">No time zone is set for your reminders yet.</p>'
    : `<p data-key="follows">Reminder times follow <strong>${esc(account)}</strong> time.</p>${
      !device || device === account ? '<p class="muted small" data-key="same">That is the time zone of this device.</p>'
        : `<p class="muted small" data-key="other">This device is on ${esc(device)} time.</p>
          <div class="row" data-key="switch"><button type="button" class="btn" data-action="tz-switch" data-zone="${esc(device)}">Switch to ${esc(device)}</button></div>`}`;
  return `<section class="card stack" aria-labelledby="settings-reminders">
    <div class="spread"><h2 id="settings-reminders">Reminders</h2><span class="chip${info.chipClass}" id="settings-push">${info.chip}</span></div>
    <p data-key="text">${info.text}</p>
    ${action ? `<div class="row" data-key="actions">${action}</div>` : ''}
    <div class="account-zone" data-key="zone">
      <h3>Time zone</h3>
      ${zone}
    </div>
  </section>`;
}

/** @param {Ctx} ctx */
function themeCard(ctx) {
  const chosen = ctx.getTheme();
  return `<section class="card stack" aria-labelledby="settings-theme">
    <h2 id="settings-theme">Appearance</h2>
    <fieldset class="segmented">
      <legend class="sr-only">Theme</legend>
      ${THEMES.map(([value, label]) => `<label><input type="radio" name="theme" value="${value}"${value === chosen ? ' checked' : ''} /><span>${label}</span></label>`).join('')}
    </fieldset>
    <p class="field-hint">System follows the light or dark setting of this device.</p>
  </section>`;
}

/** @param {State} state @param {Ctx} ctx @returns {string} */
export function render(state, ctx) {
  return screenHead({ title: 'Settings' }) + accountCard(state) + remindersCard(state, ctx) + themeCard(ctx);
}

/** Run one of the screen's slow actions with its button marked busy.
 *  @param {'push' | 'sign-out'} what @param {Ctx} ctx @param {() => Promise<void>} work */
async function run(what, ctx, work) {
  if (busy) return;
  const mine = visit;
  busy = what;
  ctx.refresh();
  try {
    await work();
  } finally {
    if (mine === visit) { // else the screen is gone (signed out, or another tab was opened)
      busy = '';
      ctx.refresh();
    }
  }
}

/** Only ever called from a tap: enable() is what asks the browser for permission.
 *  @param {Ctx} ctx */
const turnOn = (ctx) => run('push', ctx, async () => {
  /** @type {PushStatus | 'failed'} */
  let status = 'failed';
  try {
    status = await ctx.push.enable();
  } catch { /* enable() should never reject; if it does, say so below */ }
  if (status === 'on') ctx.toast('Reminders are on.');
  else if (status === 'blocked') announce('Reminders are blocked. Notifications are not allowed for this site.');
  else if (status === 'unsupported') announce('This browser cannot show reminders.');
  else if (status !== 'demo') ctx.toast('Reminders were not turned on. Try again.');
});

/** @param {Ctx} ctx */
const turnOff = (ctx) => run('push', ctx, async () => {
  try {
    await ctx.push.disable();
    ctx.toast('Reminders are off.');
  } catch {
    ctx.toast('Could not turn reminders off. Try again.');
  }
});

/** @param {Ctx} ctx */
const leave = (ctx) => run('sign-out', ctx, async () => {
  try {
    await ctx.signOut();
  } catch {
    ctx.toast('Could not sign out. Try again.');
  }
});

/** @param {HTMLElement} root @param {Ctx} ctx @returns {() => void} */
export function bind(root, ctx) {
  on(root, 'click', '[data-action]', (_event, el) => {
    const { action, zone = '' } = el.dataset;
    if (action === 'sign-out') leave(ctx);
    else if (action === 'push-on') turnOn(ctx);
    else if (action === 'push-off') turnOff(ctx);
    else if (action === 'tz-switch') switchZone(zone, ctx);
  });
  on(root, 'change', 'input[name="theme"]', (_event, el) => {
    ctx.setTheme(/** @type {import('./common.js').Theme} */ (/** @type {HTMLInputElement} */ (el).value));
    ctx.refresh();
  });
  // The status can change without a tap here: permission taken away in the browser, a registration that ends.
  // subscribe() calls back at once; that first status is the one render() has just drawn.
  let drawn = false;
  const unsubscribe = ctx.push.subscribe(() => {
    if (drawn) ctx.refresh();
  });
  drawn = true;
  return () => {
    unsubscribe();
    visit++;
    busy = '';
  };
}
