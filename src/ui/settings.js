// Placeholder. Package A5 (sign-in and Settings screens) replaces this file.
// Screen contract: src/ui/common.js.
import { esc, on, screenHead } from './common.js';

/** @param {import('./common.js').State} state @param {import('./common.js').Ctx} _ctx @returns {string} */
export function render(state, _ctx) {
  return `${screenHead({ title: 'Settings' })}
    <div class="card stack">
      <p class="muted">Signed in as ${esc(state.user?.email)}. Reminders, theme and account settings will be here.</p>
      <button type="button" class="btn" data-action="sign-out">Sign out</button>
    </div>`;
}

/** @param {HTMLElement} root @param {import('./common.js').Ctx} ctx */
export function bind(root, ctx) {
  on(root, 'click', '[data-action="sign-out"]', () => ctx.signOut());
}

/** The time-zone prompt shown above every screen (docs/contracts.md section 11). '' = nothing to show.
 *  @param {import('./common.js').State} _state @param {import('./common.js').Ctx} _ctx @returns {string} */
export function notice(_state, _ctx) {
  return '';
}

/** Listeners for the notice, attached once to the slot the shell keeps for it.
 *  @param {HTMLElement} _root @param {import('./common.js').Ctx} _ctx */
export function bindNotice(_root, _ctx) {}
