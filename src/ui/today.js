// @ts-check
// The Today screen: one card per habit, one tap to log, and a day picker for the last 7 days (R2, R3, R6).
// Screen contract: src/ui/common.js.
import { countOn, periodCount, isHit, isWeekly, summary, recentDays, weekStart } from '../../shared/logic.js';
import { esc, on, icon, tallyMarks, formatDay, emptyState, announce } from './common.js';

/** @typedef {import('./common.js').State} State */
/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./common.js').Habit} Habit */

/** A past day chosen in the picker. null = today, which follows the clock. @type {string | null} */
let picked = null;

/** The day being logged: the picked day while it can still be logged, otherwise today.
 *  @param {string} today */
const dayShown = (today) => (picked && recentDays(today).includes(picked) ? picked : today);

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

/** @param {Habit} habit @param {State['logs']} logs @param {string} day @param {string} today */
function habitCard(habit, logs, day, today) {
  const id = esc(habit.id), name = esc(habit.name);
  const done = isHit(habit, logs, day);
  const { main, extra } = progressText(habit, logs, day, today);
  return `<li class="card habit${done ? ' is-done' : ''}" data-key="${id}">
    <div class="habit-info">
      <h2><button type="button" class="habit-edit" data-action="edit" data-id="${id}">
        <span>${name}<span class="sr-only">, edit habit</span></span>${icon('edit', 16)}</button></h2>
      ${tallyMarks(periodCount(habit, logs, day), habit.target)}
      <p class="habit-progress num">${done ? icon('check', 18) : ''}<span>${esc(main)}</span>${done ? '<span class="sr-only">, done</span>' : ''}</p>
      ${extra ? `<p class="muted small num">${esc(extra)}</p>` : ''}
    </div>
    <div class="habit-controls">
      <button type="button" class="btn-round" data-action="undo" data-id="${id}" aria-label="Undo one: ${name}"
        ${countOn(logs, habit.id, day) === 0 ? 'aria-disabled="true"' : ''}>${icon('minus', 20)}</button>
      <button type="button" class="btn-round btn-plus" data-action="add" data-id="${id}" aria-label="Add one: ${name}">${icon('plus', 28)}</button>
    </div>
  </li>`;
}

/** @param {State} state @param {Ctx} ctx @returns {string} */
export function render(state, ctx) {
  const today = ctx.today(), day = dayShown(today), past = day !== today;
  const { habits, logs } = state;
  const head = `<header class="screen-head"><p class="eyebrow${past ? ' eyebrow-past' : ''}">${howLongAgo(day, today)}</p>`
    + `<h1 tabindex="-1">${esc(formatDay(day))}</h1></header>`;
  if (habits.length === 0) {
    return head + emptyState({
      title: 'Start your first habit',
      text: 'Add something you want to do every day or every week, like drinking water 8 times a day or going to the gym 3 times a week. Then tap + each time you do it.',
      actionLabel: 'Add a habit', action: 'new',
    });
  }
  const { done, total } = summary(habits, logs, day);
  return `${head}
    <p class="summary${done === total ? ' summary-all' : ''}"><strong class="num">${done} of ${total}</strong> ${total === 1 ? 'habit' : 'habits'} done</p>
    ${dayPicker(today, day, state)}
    ${past ? `<div class="notice notice-warn past-note" data-key="past-note"><p>You are logging for <strong>${esc(formatDay(day))}</strong>.</p>
      <button type="button" class="btn" data-action="pick-day" data-day="${today}">Back to today</button></div>` : ''}
    <ul class="habits" role="list" data-key="habits" data-day="${day}">${habits.map((h) => habitCard(h, logs, day, today)).join('')}</ul>
    <button type="button" class="btn btn-dashed btn-block" data-key="new" data-action="new">${icon('plus', 20)}Add a habit</button>`;
}

/** @param {HTMLElement} root @param {Ctx} ctx @returns {() => void} */
export function bind(root, ctx) {
  on(root, 'click', '[data-action]', (_event, el) => {
    const { action, id = '' } = el.dataset;
    if (action === 'new') ctx.openEditor(null);
    else if (action === 'edit') ctx.openEditor(id);
    else if (action === 'pick-day') {
      picked = el.dataset.day === ctx.today() ? null : el.dataset.day ?? null;
      ctx.refresh();
    } else if (action === 'add' || action === 'undo') {
      // Nothing to undo: the button stays focusable (it is not `disabled`, which would strand the focus
      // on a dead button after the last undo) and the tap does nothing.
      if (el.getAttribute('aria-disabled') === 'true') return;
      // Log on the day the card was drawn for: just after midnight that can still be yesterday.
      const day = /** @type {HTMLElement} */ (el.closest('[data-day]')).dataset.day ?? ctx.today();
      ctx.store.addCount(day, id, action === 'add' ? 1 : -1);
      const { habits, logs } = ctx.store.getState();
      const habit = habits.find((h) => h.id === id);
      if (habit) announce(`${habit.name}: ${progressText(habit, logs, day, ctx.today()).main}`);
    }
  });
  return () => {
    picked = null; // coming back to this tab starts on today again
  };
}
