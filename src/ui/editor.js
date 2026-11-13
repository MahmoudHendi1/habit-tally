// Placeholder. Package A3 (habit editor with reminder times) replaces this file.
// Contract: src/ui/common.js, rules 1 and 3.
import { openSheet } from './common.js';

/** Open the editor for one habit, or for a new habit when `habitId` is null.
 *  @param {string | null} habitId @param {import('./common.js').Ctx} ctx */
export function openEditor(habitId, ctx) {
  const habit = ctx.store.getState().habits.find((h) => h.id === habitId);
  openSheet({
    title: habit ? 'Edit habit' : 'New habit',
    html: `<p class="muted">The habit editor is not built yet.</p>
      <div class="sheet-actions"><button type="button" class="btn" data-sheet-close>Close</button></div>`,
  });
}
