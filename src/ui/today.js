// @ts-check
// The Today screen: one card per habit, one tap to log, and a day picker for the last 7 days (R2, R3, R6).
// Habits that belong to a routine are shown under its heading, and "Reorder" turns the + and - of every
// card into Move up and Move down (docs/contracts.md section 10, "Routines on the screens").
// Screen contract: src/ui/common.js.
import { countOn, periodCount, isHit, isWeekly, summary, recentDays, weekStart, groupHabits } from '../../shared/logic.js';
import { esc, on, icon, tallyMarks, formatDay, emptyState, announce } from './common.js';

/** @typedef {import('./common.js').State} State */
/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./common.js').Habit} Habit */

/** A past day chosen in the picker. null = today, which follows the clock. @type {string | null} */
let picked = null;

/** Reorder mode: cards and routine headings show Move up and Move down instead of the logging buttons. */
let reordering = false;

/** The day being logged: the picked day while it can still be logged, otherwise today.
 *  @param {string} today */
const dayShown = (today) => (picked && recentDays(today).includes(picked) ? picked : today);

/** The picked day has left the 7 days that can be logged (midnight passed): go to today and say so,
 *  instead of changing the day silently under the person's finger. @param {Ctx} ctx */
function leaveOldDay(ctx) {
  picked = null;
  ctx.toast('That day can no longer be logged. Showing today.');
}

/** Called by main.js before it renders a new local day (contract rule 2). @param {Ctx} ctx */
export function dayChanged(ctx) {
  if (picked && !recentDays(ctx.today()).includes(picked)) leaveOldDay(ctx);
}

/** "Today", "Yesterday" or "3 days ago". @param {string} day @param {string} today */
function howLongAgo(day, today) {
  const back = recentDays(today).indexOf(day);
  return back <= 0 ? 'Today' : back === 1 ? 'Yesterday' : `${back} days ago`;
}

/** "2 of 6 glasses today" or "2 of 3 runs this week"; for a weekly habit also what that one day added,
 *  which is what the undo button takes from.
 *  @param {Habit} habit @param {State['logs']} logs @param {string} day @param {string} today
 *  @returns {{ main: string, extra: string }} plain text */
function progressText(habit, logs, day, today) {
  const onDay = day === today ? 'today' : 'that day';
  const main = `${periodCount(habit, logs, day)} of ${habit.target}${habit.unit ? ` ${habit.unit}` : ''}`;
  if (!isWeekly(habit)) return { main: `${main} ${onDay}`, extra: '' };
  const week = weekStart(day) === weekStart(today) ? 'this week' : 'that week';
  return { main: `${main} ${week}`, extra: `${countOn(logs, habit.id, day) || 'None'} logged ${onDay}` };
}

// ---------- the order of habits and routines (pure) ----------

/** @param {string[]} ids @param {string} id @param {number} delta -1 up, +1 down
 *  @returns {string[] | null} the list with `id` one place further, or null when it cannot move */
function swapped(ids, id, delta) {
  const from = ids.indexOf(id), to = from + (delta < 0 ? -1 : 1);
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const out = [...ids];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

/** The argument of `store.reorderHabits()` that moves one habit one place inside its own section: every
 *  live habit id in the new display order (sections in order, the loose habits last).
 *  @param {{ id: string }[]} habits @param {{ id: string }[]} routines @param {string} id @param {number} delta
 *  @returns {string[] | null} null when the habit is first (or last) in its section, or unknown */
export function movedHabits(habits, routines, id, delta) {
  /** @type {string[][]} */
  const sections = groupHabits(habits, routines).map((/** @type {{ habits: { id: string }[] }} */ entry) => entry.habits.map((h) => h.id));
  const at = sections.findIndex((ids) => ids.includes(id));
  const moved = at < 0 ? null : swapped(sections[at], id, delta);
  if (!moved) return null;
  sections[at] = moved;
  return sections.flat();
}

/** The argument of `store.reorderRoutines()` that moves one routine one place.
 *  @param {{ id: string }[]} routines `state.routines` @param {string} id @param {number} delta
 *  @returns {string[] | null} */
export const movedRoutines = (routines, id, delta) => swapped(routines.map((r) => r.id), id, delta);

/** Whether "Reorder" has anything to do: two routines, or two habits in one section.
 *  @param {{ habits: unknown[] }[]} groups `groupHabits()` @param {unknown[]} routines */
export const canReorder = (groups, routines) => routines.length > 1 || groups.some((g) => g.habits.length > 1);

/** @param {string} today @param {string} day @param {State} state */
function dayPicker(today, day, { habits, logs }) {
  // Today comes first for keyboards and screen readers; the stylesheet lays the row out right to left,
  // so today sits at the right end and is in view before any scrolling on a narrow phone.
  const buttons = recentDays(today).map((key) => {
    const { done, total } = summary(habits, logs, key);
    const mark = done === 0 ? '' : done < total ? ' day-some' : ' day-all';
    const label = `${key === today ? 'Today, ' : ''}${formatDay(key)}: ${done} of ${total} done`;
    return `<button type="button" class="day${mark}" data-key="${key}" data-action="pick-day" data-day="${key}" `
      + `aria-pressed="${key === day}" aria-label="${esc(label)}">`
      + `<span class="day-name">${key === today ? 'Today' : esc(formatDay(key, 'weekday'))}</span>`
      + `<span class="day-num num">${Number(key.slice(8))}</span><span class="day-mark"></span></button>`;
  });
  return `<div class="days" role="group" aria-label="Day to log">${buttons.join('')}</div>`;
}

/** Move up and Move down for one habit or routine, shown in Reorder mode.
 *  @param {'habit' | 'routine'} kind @param {string} id escaped @param {string} name escaped
 *  @param {{ first: boolean, last: boolean }} at */
function moveButtons(kind, id, name, at) {
  const button = (/** @type {number} */ delta, /** @type {boolean} */ off) => `<button type="button" class="btn-round" data-action="move" `
    + `data-kind="${kind}" data-id="${id}" data-delta="${delta}" aria-label="Move ${delta < 0 ? 'up' : 'down'}: ${name}"${off ? ' disabled' : ''}>`
    + `${icon(delta < 0 ? 'up' : 'down', 22)}</button>`;
  return `<div class="habit-controls move-controls">${button(-1, at.first)}${button(1, at.last)}</div>`;
}

/** @param {Habit} habit @param {State['logs']} logs @param {string} day @param {string} today
 *  @param {{ tag: 'h2' | 'h3', move: { first: boolean, last: boolean } | null }} how the heading level of the
 *    name (h3 under a section heading), and where the card is in its section while reordering */
function habitCard(habit, logs, day, today, { tag, move }) {
  const id = esc(habit.id), name = esc(habit.name);
  const done = isHit(habit, logs, day);
  const { main, extra } = progressText(habit, logs, day, today);
  return `<li class="card habit${done ? ' is-done' : ''}" data-key="${id}">
    <div class="habit-info">
      <${tag} class="habit-name"><button type="button" class="habit-edit" data-action="edit" data-id="${id}">
        <span>${name}<span class="sr-only">, edit habit</span></span>${icon('edit', 16)}</button></${tag}>
      ${tallyMarks(periodCount(habit, logs, day), habit.target)}
      <p class="habit-progress num">${done ? icon('check', 18) : ''}<span>${esc(main)}</span>${done ? '<span class="sr-only">, done</span>' : ''}</p>
      ${extra ? `<p class="muted small num">${esc(extra)}</p>` : ''}
    </div>
    ${move ? moveButtons('habit', id, name, move) : `<div class="habit-controls">
      <button type="button" class="btn-round" data-action="undo" data-id="${id}" aria-label="Undo one: ${name}"
        ${countOn(logs, habit.id, day) === 0 ? 'aria-disabled="true"' : ''}>${icon('minus', 20)}</button>
      <button type="button" class="btn-round btn-plus" data-action="add" data-id="${id}" aria-label="Add one: ${name}">${icon('plus', 28)}</button>
    </div>`}
  </li>`;
}

/** The cards of one section. @param {Habit[]} list @param {State['logs']} logs @param {string} day
 *  @param {string} today @param {'h2' | 'h3'} tag */
const cards = (list, logs, day, today, tag) => list.map((h, i) => habitCard(h, logs, day, today,
  { tag, move: reordering ? { first: i === 0, last: i === list.length - 1 } : null })).join('');

/** One section of Today: a routine with its habits, or the loose habits under "Other habits".
 *  @param {{ routine: State['routines'][number] | null, habits: Habit[] }} entry from groupHabits()
 *  @param {{ first: boolean, last: boolean }} at among the routines
 *  @param {State['logs']} logs @param {string} day @param {string} today */
function section(entry, at, logs, day, today) {
  const { routine, habits } = entry;
  const list = `<ul class="habits" role="list">${cards(habits, logs, day, today, 'h3')}</ul>`;
  if (!routine) {
    return `<section class="routine" data-key="loose" aria-labelledby="routine-title-loose">
      <div class="routine-head"><h2 id="routine-title-loose">Other habits</h2></div>${list}</section>`;
  }
  const id = esc(routine.id), name = esc(routine.name);
  const { done, total } = summary(habits, logs, day);
  return `<section class="routine" data-key="routine-${id}" aria-labelledby="routine-title-${id}">
    <div class="routine-head">
      <h2 id="routine-title-${id}"><button type="button" class="habit-edit" data-action="edit-routine" data-id="${id}"
        aria-label="${name}, edit routine"><span>${name}</span>${icon('edit', 16)}</button></h2>
      ${total > 0 && !reordering ? `<p class="routine-count num${done === total ? ' is-all' : ''}">${done === total ? icon('check', 16) : ''}${done} of ${total} done</p>` : ''}
      ${reordering ? moveButtons('routine', id, name, at) : ''}
    </div>
    ${total > 0 ? list : '<p class="routine-empty muted small">No habits in this routine yet. Open a habit, or add one, and choose this routine in it.</p>'}
  </section>`;
}

/** @param {State} state @param {Ctx} ctx @returns {string} */
export function render(state, ctx) {
  const today = ctx.today(), day = dayShown(today), past = day !== today;
  const { habits, logs, routines = [] } = state;
  const head = `<header class="screen-head"><p class="eyebrow${past ? ' eyebrow-past' : ''}">${howLongAgo(day, today)}</p>`
    + `<h1 tabindex="-1">${esc(formatDay(day))}</h1></header>`;
  const empty = habits.length === 0 ? emptyState({
    title: 'Start your first habit',
    text: 'Add something you want to do every day or every week, like drinking water 8 times a day or going to the gym 3 times a week. Then tap + each time you do it.',
    actionLabel: 'Add a habit', action: 'new',
  }) : '';
  if (empty && routines.length === 0) return head + empty;

  const groups = groupHabits(habits, routines);
  const { done, total } = summary(habits, logs, day);
  const count = `<p class="summary${done === total ? ' summary-all' : ''}"><strong class="num">${done} of ${total}</strong> ${total === 1 ? 'habit' : 'habits'} done</p>`;
  // One button that stays where it is and changes its name, so the focus stays on it. "Done" is short
  // enough to stay beside the count on a narrow phone; its full name is "Done reordering".
  const bar = reordering || canReorder(groups, routines)
    ? `<div class="today-bar" data-key="bar">${count}<button type="button" class="btn ${reordering ? 'btn-primary' : 'btn-quiet'} today-reorder" data-action="reorder"`
      + `${reordering ? ` aria-label="Done reordering">${icon('check', 18)}Done` : `>${icon('sort', 18)}Reorder`}</button></div>`
    : count;
  // With no routines Today is one plain list, as it was before there were routines.
  const lists = routines.length === 0
    ? `<ul class="habits" role="list" data-key="habits" data-day="${day}">${cards(habits, logs, day, today, 'h2')}</ul>`
    : `<div class="routines" data-key="habits" data-day="${day}">${groups.map((entry, i) => section(entry,
      { first: i === 0, last: i === routines.length - 1 }, logs, day, today)).join('')}</div>`;
  return `${head}
    ${empty || `${bar}
    ${dayPicker(today, day, state)}`}
    ${past && !empty ? `<div class="notice notice-warn past-note" data-key="past-note"><p>You are logging for <strong>${esc(formatDay(day))}</strong>.</p>
      <button type="button" class="btn" data-action="pick-day" data-day="${today}">Back to today</button></div>` : ''}
    ${lists}
    ${empty ? '' : `<button type="button" class="btn btn-dashed btn-block" data-key="new" data-action="new">${icon('plus', 20)}Add a habit</button>`}
    <button type="button" class="btn btn-quiet btn-block" data-key="new-routine" data-action="new-routine">${icon('plus', 20)}Add a routine</button>`;
}

/** One press of Move up or Move down. The store re-renders the screen before it returns; the focus then
 *  goes back to the button that was pressed, or to its twin when the item has reached the end.
 *  @param {HTMLElement} root @param {Ctx} ctx @param {HTMLElement} el */
function move(root, ctx, el) {
  const { kind, id = '' } = el.dataset, delta = Number(el.dataset.delta);
  const { habits, routines = [] } = ctx.store.getState();
  const item = (kind === 'routine' ? routines : habits).find((x) => x.id === id);
  const ids = kind === 'routine' ? movedRoutines(routines, id, delta) : movedHabits(habits, routines, id, delta);
  if (!item || !ids) return;
  if (kind === 'routine') ctx.store.reorderRoutines(ids);
  else ctx.store.reorderHabits(ids);
  const twins = /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[data-action="move"]')])
    .filter((b) => b.dataset.kind === kind && b.dataset.id === id);
  const same = twins.find((b) => Number(b.dataset.delta) === delta);
  (same && !same.disabled ? same : twins.find((b) => !b.disabled))?.focus();
  const after = ctx.store.getState();
  const list = kind === 'routine' ? (after.routines ?? [])
    : groupHabits(after.habits, after.routines ?? []).map((/** @type {{ habits: Habit[] }} */ g) => g.habits).find((g) => g.some((h) => h.id === id)) ?? [];
  announce(`${item.name} moved ${delta < 0 ? 'up' : 'down'}: now ${list.findIndex((x) => x.id === id) + 1} of ${list.length}`);
}

/** @param {HTMLElement} root @param {Ctx} ctx @returns {() => void} */
export function bind(root, ctx) {
  on(root, 'click', '[data-action]', (_event, el) => {
    const { action, id = '' } = el.dataset;
    if (action === 'new') ctx.openEditor(null);
    else if (action === 'edit') ctx.openEditor(id);
    else if (action === 'new-routine') ctx.openRoutine(null);
    else if (action === 'edit-routine') ctx.openRoutine(id);
    else if (action === 'reorder') {
      reordering = !reordering;
      ctx.refresh();
      announce(reordering ? 'Reordering: use Move up and Move down.' : 'Done reordering.');
    } else if (action === 'move') move(root, ctx, el);
    else if (action === 'pick-day') {
      picked = el.dataset.day === ctx.today() ? null : el.dataset.day ?? null;
      ctx.refresh();
    } else if (action === 'add' || action === 'undo') {
      // Nothing to undo: the button stays focusable (it is not `disabled`, which would strand the focus
      // on a dead button after the last undo) and the tap does nothing.
      if (el.getAttribute('aria-disabled') === 'true') return;
      // Log on the day the card was drawn for: just after midnight that can still be yesterday.
      const day = /** @type {HTMLElement} */ (el.closest('[data-day]')).dataset.day ?? ctx.today();
      // Midnight can pass between the render and the tap: the store would drop a count for a day that
      // is out of range without a word.
      if (!recentDays(ctx.today()).includes(day)) {
        leaveOldDay(ctx);
        ctx.refresh();
        return;
      }
      ctx.store.addCount(day, id, action === 'add' ? 1 : -1);
      const { habits, logs } = ctx.store.getState();
      const habit = habits.find((h) => h.id === id);
      if (habit) announce(`${habit.name}: ${progressText(habit, logs, day, ctx.today()).main}`);
    }
  });
  return () => {
    picked = null; // coming back to this tab starts on today again
    reordering = false;
  };
}
