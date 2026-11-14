// @ts-check
// The sign-in screen (status 'signedOut') and the waiting screen of an account that is not approved
// yet (status 'waiting'): R10. Screen contract: src/ui/common.js. Store calls and error codes:
// docs/contracts.md section 5. Styles: account.css.
import { esc, on, icon, screenHead, announce } from './common.js';

/** @typedef {import('./common.js').State} State */
/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {'in' | 'up' | 'reset'} Mode */

const GENERIC = 'Something went wrong. Try again.';
/** One plain sentence per sign-in error code (docs/contracts.md section 5, Errors). */
const MESSAGES = {
  'invalid-email': 'Enter a valid email address, like name@example.com.',
  'wrong-credentials': 'Wrong email or password. Check both and try again.',
  'email-in-use': 'There is already an account with this email. Sign in instead, or reset the password.',
  'weak-password': 'That password is too short. Use at least 6 characters.',
  'too-many-requests': 'Too many tries. Wait a few minutes, then try again.',
  offline: 'You are offline. Connect to the internet, then try again.',
};
const RESET_SENT = 'If an account exists for that address, a reset email is on its way.';
const STILL_WAITING = 'Still waiting for approval.';
const TEXT = {
  in: { title: 'Sign in', submit: 'Sign in', busy: 'Signing in…' },
  up: { title: 'Create account', submit: 'Create account', busy: 'Creating account…' },
  reset: { title: 'Reset password', submit: 'Send reset email', busy: 'Sending…' },
};
/** The field a refused sign-in points at. Other codes (offline, too many tries) point at none. */
const FIELD_OF = new Map([['invalid-email', 'email'], ['email-in-use', 'email'], ['weak-password', 'password'], ['wrong-credentials', 'password']]);
/** Reset errors that are the same whether or not the account exists, so showing them gives nothing away. */
const RESET_SHOWN = ['invalid-email', 'offline', 'too-many-requests'];

// The screen's own state (contract rule 2d). bind()'s clean-up puts it back.
/** @type {Mode} */
let mode = 'in';
/** @type {'' | 'submit' | 'check' | 'sign-out'} */
let busy = '';
/** @type {{ code: string, message: string, field: string } | null} */
let problem = null;
let resetSent = false, showPassword = false, copied = false, waitNote = '';
let noteTimer = 0, copiedTimer = 0;
let visit = 0; // goes up when the screen is unmounted, so a result that arrives later is dropped

/** What to show for a rejected store call. The text is chosen here by the contract's error code, so the
 *  person never reads a backend's own wording; a code that is not in the list gets the general sentence.
 *  @param {unknown} err */
function problemOf(err) {
  const code = String(/** @type {any} */ (err)?.code ?? '');
  return { code, message: Object.hasOwn(MESSAGES, code) ? MESSAGES[/** @type {keyof typeof MESSAGES} */ (code)] : GENERIC, field: FIELD_OF.get(code) ?? '' };
}

/** @param {string} action @param {string} label @param {string} busyLabel @param {string} [more] class and attributes */
function button(action, label, busyLabel, more = 'class="btn"') {
  const waiting = busy === action;
  return `<button ${waiting ? more.replace('class="', 'class="account-busy ') : more}${waiting ? ' aria-busy="true" aria-disabled="true"' : ''}>${waiting ? busyLabel : label}</button>`;
}

/** @param {string} name */
const invalid = (name) => (problem?.field === name ? ' aria-invalid="true" aria-describedby="signin-problem"' : '');
/** @param {Mode} to @param {string} label */
const modeButton = (to, label) => `<button type="button" class="btn btn-quiet" data-action="mode" data-mode="${to}">${label}</button>`;

/** @param {State} state */
function signInView(state) {
  const text = TEXT[mode], demo = state.mode === 'demo';
  return `<p class="account-lede">Habit Tally keeps count of your habits: set a target, then tap once each time you do it.</p>
    <form class="card stack account-form" novalidate aria-labelledby="signin-title">
      <h1 id="signin-title" tabindex="-1">${text.title}</h1>
      ${demo ? '<p class="notice" data-key="demo">Demo mode: any email and a password of 6 or more characters work. Nothing leaves this browser.</p>' : ''}
      ${mode === 'up' ? `<p class="notice" data-key="approval">${demo ? 'In the full app, new' : 'Habit Tally is invite-only for now. New'} accounts need approval before they can be used.</p>` : ''}
      ${mode === 'reset' ? '<p class="muted" data-key="intro">Enter the email of your account to get a link for choosing a new password.</p>' : ''}
      <div class="field" data-key="email"><label for="signin-email">Email</label>
        <input class="input" id="signin-email" name="email" type="email" inputmode="email" autocomplete="email"
          autocapitalize="none" spellcheck="false" required${invalid('email')} /></div>
      ${mode === 'reset' ? '' : `<div class="field" data-key="password"><label for="signin-password">Password</label>
        <div class="account-password">
          <input class="input" id="signin-password" name="password" type="${showPassword ? 'text' : 'password'}"
            autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" autocapitalize="none" spellcheck="false" required${invalid('password')} />
          <button type="button" class="btn" data-action="show" aria-controls="signin-password"
            aria-label="${showPassword ? 'Hide' : 'Show'} password">${showPassword ? 'Hide' : 'Show'}</button>
        </div>
        ${mode === 'up' ? '<p class="field-hint">At least 6 characters.</p>' : ''}</div>`}
      ${problem ? `<p class="field-error" id="signin-problem" role="alert">${esc(problem.message)}</p>` : ''}
      ${resetSent ? `<p class="notice account-ok" data-key="sent" role="status">${RESET_SENT}${demo ? ' (Demo mode sends no email.)' : ''}</p>` : ''}
      ${button('submit', text.submit, text.busy, 'type="submit" class="btn btn-primary btn-block" data-key="submit"')}
      ${mode === 'in' ? modeButton('reset', 'Forgot password?') : ''}
      <p class="account-switch" data-key="switch">${mode === 'in' ? `New to Habit Tally? ${modeButton('up', 'Create account')}`
        : mode === 'up' ? `Already have an account? ${modeButton('in', 'Sign in')}` : modeButton('in', 'Back to sign in')}</p>
    </form>`;
}

/** @param {State} state */
function waitingView(state) {
  return `${screenHead({ title: 'Almost there', eyebrow: 'Waiting for approval' })}
    <div class="card stack">
      <p>Habit Tally is invite-only for now. Your account is created, and you can use it as soon as it has been approved.</p>
      <dl class="account-facts">
        <div><dt>Signed in as</dt><dd>${esc(state.user?.email)}</dd></div>
        <div><dt>Account id</dt><dd class="account-id"><code id="waiting-uid">${esc(state.user?.uid)}</code>
          <button type="button" class="btn" data-action="copy">${copied ? `${icon('check', 18)}Copied` : 'Copy'}<span class="sr-only"> account id</span></button></dd></div>
      </dl>
      <p>Send this account id to the person who invited you. Once they have approved it, tap Check again.</p>
      <div class="row">${button('check', 'Check again', 'Checking…', 'type="button" class="btn btn-primary" data-action="check"')}
        ${button('sign-out', 'Sign out', 'Signing out…', 'type="button" class="btn" data-action="sign-out"')}</div>
      ${waitNote ? `<p class="notice" data-key="note">${esc(waitNote)}</p>` : ''}
    </div>`;
}

/** The sign-in form, or the waiting screen for an account that is not approved yet.
 *  @param {State} state @param {Ctx} _ctx @returns {string} */
export function render(state, _ctx) {
  return state.status === 'waiting' ? waitingView(state) : signInView(state);
}

/** @param {HTMLFormElement} form @param {HTMLElement} root @param {Ctx} ctx */
async function submit(form, root, ctx) {
  if (busy) return;
  const data = new FormData(form);
  const email = String(data.get('email') ?? ''), password = String(data.get('password') ?? '');
  const sent = mode, mine = visit;
  busy = 'submit';
  problem = null;
  resetSent = false;
  ctx.refresh();
  let failure = null;
  try {
    if (sent === 'reset') await ctx.store.resetPassword(email);
    else if (sent === 'up') await ctx.store.signUp(email, password);
    else await ctx.store.signIn(email, password);
  } catch (err) {
    failure = problemOf(err);
  }
  if (mine !== visit) return; // signed in: the screen is gone
  busy = '';
  // A reset never says whether the account exists: anything but a plainly neutral error reads as sent.
  if (sent === 'reset' && (!failure || !RESET_SHOWN.includes(failure.code))) resetSent = true;
  else problem = failure;
  ctx.refresh();
  if (problem?.field) /** @type {HTMLElement | null} */ (root.querySelector(`#signin-${problem.field}`))?.focus();
}

/** @param {HTMLElement} root @param {Ctx} ctx */
async function copyId(root, ctx) {
  const code = root.querySelector('#waiting-uid');
  try {
    await navigator.clipboard.writeText(ctx.store.getState().user?.uid ?? '');
    copied = true;
    announce('Account id copied.');
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copied = false;
      ctx.refresh();
    }, 2500);
  } catch { // no clipboard access: select the id, so it can be copied by hand
    if (code) getSelection()?.selectAllChildren(code);
    ctx.toast('Could not copy. The id is selected: copy it from there.');
  }
  ctx.refresh();
}

/** retry() gives no answer, so wait a moment: an approved account leaves this screen by itself.
 *  @param {Ctx} ctx */
function checkAgain(ctx) {
  const uid = ctx.store.getState().user?.uid;
  busy = 'check';
  waitNote = '';
  ctx.refresh();
  try {
    ctx.store.retry();
  } catch { /* reads as still waiting */ }
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => {
    busy = '';
    const { status, user } = ctx.store.getState();
    if (status === 'waiting' && user?.uid === uid) {
      waitNote = STILL_WAITING;
      announce(STILL_WAITING);
      noteTimer = window.setTimeout(() => {
        waitNote = '';
        ctx.refresh();
      }, 6000);
    }
    ctx.refresh();
  }, 1200);
}

/** @param {Ctx} ctx */
async function leave(ctx) {
  const mine = visit;
  busy = 'sign-out';
  ctx.refresh();
  try {
    await ctx.signOut();
  } catch {
    ctx.toast('Could not sign out. Try again.');
  }
  if (mine !== visit) return;
  clearTimeout(noteTimer);
  [mode, busy, waitNote, copied] = ['in', '', '', false];
  ctx.refresh();
}

/** @param {HTMLElement} root @param {Ctx} ctx @returns {() => void} */
export function bind(root, ctx) {
  on(root, 'submit', 'form', (event, form) => {
    event.preventDefault();
    submit(/** @type {HTMLFormElement} */ (form), root, ctx);
  });
  on(root, 'click', '[data-action]', (_event, el) => {
    const { action } = el.dataset;
    if (action === 'show') showPassword = !showPassword;
    else if (action === 'copy') return void copyId(root, ctx);
    else if (busy) return;
    else if (action === 'check') return checkAgain(ctx);
    else if (action === 'sign-out') return void leave(ctx);
    else if (action === 'mode') {
      mode = /** @type {Mode} */ (el.dataset.mode);
      problem = null;
      resetSent = false;
    }
    ctx.refresh();
    // The form changed under the button: put focus on its new title, which screen readers then read.
    if (action === 'mode') /** @type {HTMLElement | null} */ (root.querySelector('#signin-title'))?.focus();
  });
  return () => {
    visit++;
    clearTimeout(noteTimer);
    clearTimeout(copiedTimer);
    [mode, busy, problem, resetSent, showPassword, copied, waitNote] = ['in', '', null, false, false, false, ''];
  };
}
