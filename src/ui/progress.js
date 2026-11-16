// @ts-check
// The Progress screen: per habit, the headline numbers (R5) and a calendar of the last 15 weeks (R13).
// Every number comes from shared/logic.js (stats, calendarWeeks, periodCount); this file only words and
// draws them. Styles: progress.css. Screen contract: src/ui/common.js.
import { stats, startDay, calendarWeeks, periodCount, isHit, isWeekly, weekStart, addDays, groupHabits } from '../../shared/logic.js';
import { esc, on, icon, formatDay, screenHead, emptyState } from './common.js';

/** @typedef {import('./common.js').State} State */
/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./common.js').Habit} Habit */

/** Week columns in the calendar; the last one is this week. */
export const CALENDAR_WEEKS = 15;

/** The day whose date and count the detail line shows, chosen by a tap, the mouse or the arrow keys.
 *  @type {{ id: string, day: string } | null} */
let picked = null;

const DAY_TEXT = {
  day: 'short',                                   // Thu 12 Nov
  since: 'date',                                  // 27 Jul 2026
  week: { day: 'numeric', month: 'short' },       // 3 Aug
  month: { month: 'short' },                      // Aug
  weekday: { weekday: 'long' },                   // Monday
  initial: { weekday: 'narrow' },                 // M
};

/** formatDay() results, remembered: a render asks for the same 105 days once per habit, and making a
 *  date formatter 5,000 times would be most of the cost of drawing 50 habits. @type {Map<string, string>} */
const dayTexts = new Map();

/** @param {string} key day key @param {keyof typeof DAY_TEXT} style @returns {string} plain text */
function dayText(key, style) {
  const id = `${style} ${key}`;
  let text = dayTexts.get(id);
  if (text === undefined) {
    if (dayTexts.size > 2000) dayTexts.clear();
    text = formatDay(key, /** @type {any} */ (DAY_TEXT[style]));
    dayTexts.set(id, text);
  }
  return text;
}

/** "1 day", "3 weeks". @param {number} n @param {string} one */
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What one calendar day says, for its accessible name and for the detail line:
 *  "Thu 12 Nov: 6 of 6 glasses, target met" or "Tue 10 Nov: 1 logged, week 2 of 3 runs".
 *  @param {Habit} habit
 *  @param {{ key: string, count: number, level: number, before: boolean }} day from calendarWeeks()
 *  @param {{ hit: boolean, count: number }} week the day's week; only read for a weekly habit
 *  @param {string} today
 *  @returns {string} plain text */
function describeDay(habit, day, week, today) {
  const when = `${day.key === today ? 'Today, ' : ''}${dayText(day.key, 'day')}`;
  if (day.before) return `${when}: not started yet`;
  const unit = habit.unit ? ` ${habit.unit}` : '';
  if (isWeekly(habit)) return `${when}: ${day.count} logged, week ${week.count} of ${habit.target}${unit}${week.hit ? ', target met' : ''}`;
  return `${when}: ${day.count} of ${habit.target}${unit}${day.level === 3 ? ', target met' : ''}`;
}

/** The calendar: a table with one column per week and one row per weekday, so a screen reader can walk
 *  it with its table commands and hears "Week of 3 Aug, Monday" with each cell. The cells are not
 *  focusable; the whole calendar is one tab stop, and the arrow keys move the picked day.
 *  @param {Habit} habit @param {State['logs']} logs @param {string} today
 *  @returns {string} HTML */
function calendar(habit, logs, today) {
  const id = esc(habit.id), weekly = isWeekly(habit);
  const weeks = calendarWeeks(habit, logs, today, CALENDAR_WEEKS);
  const pick = picked && picked.id === habit.id ? picked.day : '';
  const thisWeek = weekStart(today);
  const rows = ['', '', '', '', '', '', ''];
  let head = '', weekRow = '', detail = '';
  let days = 0, daysMet = 0, weeksLive = 0, weeksMet = 0, anyBefore = false;

  weeks.forEach((week, w) => {
    // A month is named above the column that holds its first day; the first column is named too,
    // unless a month starting in the next two columns would run into it.
    const first = week.days.find((d) => d.key.endsWith('-01'));
    const crowded = weeks.slice(1, 3).some((next) => next.days.some((d) => d.key.endsWith('-01')));
    const month = first ? dayText(first.key, 'month') : w === 0 && !crowded ? dayText(week.start, 'month') : '';
    head += `<th scope="col" aria-label="Week of ${esc(dayText(week.start, 'week'))}">${esc(month)}</th>`;

    const inWeek = { hit: week.hit, count: weekly ? periodCount(habit, logs, week.start) : 0 };
    let live = false;
    week.days.forEach((day, r) => {
      if (day.future) {
        rows[r] += '<td class="progress-day is-future"></td>';
        return;
      }
      const text = describeDay(habit, day, inWeek, today);
      if (day.before) anyBefore = true;
      else {
        live = true;
        days++;
        if (day.level === 3) daysMet++;
      }
      if (day.key === pick) detail = text;
      rows[r] += `<td class="progress-day${day.before ? ' is-before' : ''}${day.key === today ? ' is-today' : ''}`
        + `${day.key === pick ? ' is-picked' : ''}" data-level="${day.level}" data-day="${day.key}" aria-label="${esc(text)}"></td>`;
    });

    if (live) weeksLive++;
    if (live && week.hit) weeksMet++;
    if (weekly) {
      const state = week.hit ? 'target met' : !live ? 'not started yet' : week.start === thisWeek ? 'in progress' : 'target not met';
      weekRow += `<td${week.hit ? ' class="is-hit"' : ''} aria-label="${inWeek.count} of ${habit.target}, ${state}">${week.hit ? icon('check', 14) : ''}</td>`;
    }
  });

  const summary = weekly
    ? `Target met in ${weeksMet} of ${plural(weeksLive, 'week')}`
    : `Target met on ${daysMet} of ${plural(days, 'day')}`;
  const swatch = (/** @type {number} */ level, /** @type {string} */ text, extra = '') =>
    `<li><span class="progress-swatch${extra}" data-level="${level}"></span>${text}</li>`;
  const legend = (weekly
    ? swatch(0, 'None') + swatch(2, 'Logged') + swatch(3, 'Logged, week met') + `<li>${icon('check', 14)}Week target met</li>`
    : swatch(0, 'None') + swatch(1, 'Some') + swatch(2, 'Half or more') + swatch(3, 'Target met'))
    + (anyBefore ? swatch(0, 'Not started', ' is-before') : '') + swatch(0, 'Today', ' is-today');

  return `<div class="progress-cal" tabindex="0" role="group" data-id="${id}" aria-label="${esc(habit.name)}: last ${CALENDAR_WEEKS} weeks"
      aria-describedby="progress-sum-${id} progress-detail-${id}">
    <div class="progress-cal-head"><h3>Last ${CALENDAR_WEEKS} weeks</h3><p class="muted small num" id="progress-sum-${id}">${summary}</p></div>
    <table class="progress-grid">
      <thead><tr><td></td>${head}</tr></thead>
      <tbody>${rows.map((cells, r) => `<tr><th scope="row" aria-label="${esc(dayText(weeks[0].days[r].key, 'weekday'))}">`
        + `${esc(dayText(weeks[0].days[r].key, 'initial'))}</th>${cells}</tr>`).join('')}
        ${weekly ? `<tr class="progress-weekrow"><th scope="row" aria-label="Week"></th>${weekRow}</tr>` : ''}</tbody>
    </table>
    <ul class="progress-legend" role="list" aria-hidden="true">${legend}</ul>
    <p class="progress-detail small num" id="progress-detail-${id}" role="status">${detail ? esc(detail) : '<span class="muted">Tap a day to see its count.</span>'}</p>
  </div>`;
}

/** @param {Habit} habit @param {State['logs']} logs @param {string} today
 *  @param {'h2' | 'h3'} [tag] the heading level of the name: h3 under a routine heading @returns {string} HTML */
function habitCard(habit, logs, today, tag = 'h2') {
  const id = esc(habit.id), weekly = isWeekly(habit), span = weekly ? 'week' : 'day';
  const { total, periods, hitPeriods, best, streak } = stats(habit, logs, today);
  const unit = habit.unit || (habit.target === 1 ? 'time' : 'times');
  const percent = periods > 0 ? Math.round((100 * hitPeriods) / periods) : 0;
  const now = periodCount(habit, logs, today), hitNow = isHit(habit, logs, today);
  const note = hitNow
    ? `${icon('check', 18)}<span>${weekly ? 'This week’s' : 'Today’s'} target is met.</span>`
    : `<span>${weekly ? 'This week' : 'Today'} is still in progress: ${now} of ${habit.target} so far. `
      + `${streak > 0 ? `Your streak is safe until the ${span} ends.` : 'Meet the target to start a streak.'}</span>`;

  return `<li class="card progress-habit" data-key="${id}">
    <header class="progress-head">
      <${tag} class="progress-name">${esc(habit.name)}</${tag}>
      <p class="muted small num">${habit.target} ${esc(unit)} a ${span} · since ${esc(dayText(startDay(habit, logs), 'since'))}</p>
    </header>
    <div class="progress-hero${streak > 0 ? ' is-running' : ''}">
      <dl>
        <div class="progress-streak"><dt>Current streak</dt><dd class="num"><strong>${streak}</strong> ${streak === 1 ? span : `${span}s`}</dd></div>
        <div class="progress-best"><dt>Best streak</dt><dd class="num">${plural(best, span)}</dd></div>
      </dl>
      <p class="progress-note${hitNow ? ' is-met' : ''} num">${note}</p>
    </div>
    <dl class="progress-stats">
      <div><dt>Target met</dt><dd class="num"><strong>${hitPeriods} of ${plural(periods, span)}</strong> <span class="muted">${percent}%</span></dd>
        <dd class="progress-bar"><svg width="100%" height="8" aria-hidden="true"><rect width="100%" height="8" rx="4"/>`
          + `<rect class="on" width="${percent}%" height="8" rx="4"/></svg></dd></div>
      <div><dt>Total done</dt><dd class="num"><strong>${total}</strong> ${esc(habit.unit || (total === 1 ? 'time' : 'times'))}</dd></div>
    </dl>
    ${calendar(habit, logs, today)}
  </li>`;
}

/** @param {State} state @param {Ctx} ctx @returns {string} */
export function render(state, ctx) {
  const head = screenHead({ title: 'Progress' });
  const { habits, logs } = state;
  if (habits.length === 0) {
    return head + emptyState({
      title: 'Your progress will show here',
      text: `Add a habit, then tap + on the Today tab each time you do it. Your totals, your streaks and a calendar of the last ${CALENDAR_WEEKS} weeks build up from there.`,
      actionLabel: 'Add a habit', action: 'new',
    });
  }
  const today = ctx.today();
  const routines = state.routines ?? [];
  // With no routines: one plain list, as before there were routines.
  if (routines.length === 0) {
    return `${head}<ul class="progress-list" role="list" data-key="habits">${habits.map((h) => habitCard(h, logs, today)).join('')}</ul>`;
  }
  // The sections and the order of Today. A routine without habits has nothing to show here.
  const sections = groupHabits(habits, routines).filter((/** @type {{ habits: Habit[] }} */ entry) => entry.habits.length > 0)
    .map((/** @type {{ routine: { id: string, name: string } | null, habits: Habit[] }} */ { routine, habits: list }) => {
      const key = routine ? `routine-${esc(routine.id)}` : 'loose';
      return `<section class="progress-group" data-key="${key}" aria-labelledby="progress-title-${key}">
        <h2 id="progress-title-${key}">${routine ? esc(routine.name) : 'Other habits'}</h2>
        <ul class="progress-list" role="list">${list.map((h) => habitCard(h, logs, today, 'h3')).join('')}</ul>
      </section>`;
    });
  return `${head}<div class="progress-groups" data-key="habits">${sections.join('')}</div>`;
}

/** @param {HTMLElement} root @param {Ctx} ctx @returns {() => void} */
export function bind(root, ctx) {
  /** @param {HTMLElement} cell a day of a calendar */
  const pick = (cell) => {
    const id = /** @type {HTMLElement} */ (cell.closest('[data-id]')).dataset.id ?? '', day = cell.dataset.day ?? '';
    if (picked && picked.id === id && picked.day === day) return;
    picked = { id, day };
    ctx.refresh();
  };
  on(root, 'click', '[data-action="new"]', () => ctx.openEditor(null));
  on(root, 'click', 'td[data-day]', (_event, cell) => pick(cell));
  on(root, 'pointerover', 'td[data-day]', (event, cell) => {
    if (event.pointerType === 'mouse') pick(cell);
  });
  // The calendar is one tab stop: up and down move a day, left and right a week, Escape lets go.
  on(root, 'keydown', '.progress-cal', (event, cal) => {
    const id = cal.dataset.id ?? '';
    if (event.key === 'Escape' && picked) {
      picked = null;
      ctx.refresh();
      return;
    }
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[/** @type {string} */ (event.key)];
    if (!step) return;
    event.preventDefault();
    const today = ctx.today();
    const first = /** @type {HTMLElement | null} */ (cal.querySelector('td[data-day]'))?.dataset.day ?? today;
    const day = picked && picked.id === id ? addDays(picked.day, step) : today;
    if (day < first || day > today) return;
    picked = { id, day };
    ctx.refresh();
  });
  return () => {
    picked = null;
  };
}
