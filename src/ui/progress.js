// Placeholder. Package A4 (Progress screen and 15-week calendar) replaces this file.
// Screen contract: src/ui/common.js.
import { screenHead } from './common.js';

/** @param {import('./common.js').State} _state @param {import('./common.js').Ctx} _ctx @returns {string} */
export function render(_state, _ctx) {
  return `${screenHead({ title: 'Progress' })}<p class="muted">Totals, streaks and the 15-week calendar will be here.</p>`;
}

/** @param {HTMLElement} _root @param {import('./common.js').Ctx} _ctx */
export function bind(_root, _ctx) {}
