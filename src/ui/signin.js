// Placeholder. Package A5 (sign-in and Settings screens) replaces this file.
// Screen contract: src/ui/common.js. Mounted while the status is 'signedOut' or 'waiting'.
import { esc, on, screenHead } from './common.js';

let problem = '';

/** @param {import('./common.js').State} state @param {import('./common.js').Ctx} _ctx @returns {string} */
export function render(state, _ctx) {
  if (state.status === 'waiting') {
    return `${screenHead({ title: 'Waiting for approval' })}
      <div class="card stack">
        <p class="muted">Account id: ${esc(state.user?.uid)}</p>
        <div class="row"><button type="button" class="btn btn-primary" data-action="retry">Check again</button>
          <button type="button" class="btn" data-action="sign-out">Sign out</button></div>
      </div>`;
  }
  return `${screenHead({ title: 'Sign in' })}
    <form class="card stack" novalidate>
      <div class="field"><label for="signin-email">Email</label>
        <input class="input" id="signin-email" name="email" type="email" autocomplete="username" inputmode="email" /></div>
      <div class="field"><label for="signin-password">Password</label>
        <input class="input" id="signin-password" name="password" type="password" autocomplete="current-password" /></div>
      ${problem ? `<p class="field-error" role="alert">${esc(problem)}</p>` : ''}
      <div class="row"><button type="submit" class="btn btn-primary" value="in">Sign in</button>
        <button type="submit" class="btn" value="up">Create account</button></div>
    </form>`;
}

/** @param {HTMLElement} root @param {import('./common.js').Ctx} ctx */
export function bind(root, ctx) {
  on(root, 'submit', 'form', async (event, form) => {
    event.preventDefault();
    const data = new FormData(/** @type {HTMLFormElement} */ (form));
    const email = String(data.get('email')), password = String(data.get('password'));
    try {
      if (event.submitter?.value === 'up') await ctx.store.signUp(email, password);
      else await ctx.store.signIn(email, password);
      problem = '';
    } catch (err) {
      problem = err instanceof Error ? err.message : 'Something went wrong. Try again.';
      ctx.refresh();
    }
  });
  on(root, 'click', '[data-action]', (_event, el) => {
    if (el.dataset.action === 'retry') ctx.store.retry();
    else if (el.dataset.action === 'sign-out') ctx.signOut();
  });
  return () => {
    problem = '';
  };
}
