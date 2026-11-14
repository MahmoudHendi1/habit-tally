// @ts-check
// The habit editor: a bottom sheet to add, change or delete a habit and to choose its reminder times
// (R1, R4). Not a screen: screens open it with ctx.openEditor(). Contract: src/ui/common.js, rules 1 to 6.
// Styles: editor.css. The first half of this file is pure (no DOM) and is tested by test/editor.test.mjs.
import { LIMITS, cleanHabit, validateHabit, cleanTimes, everyHours, cleanRoutine, validateRoutine, routineOf } from '../../shared/logic.js';
import { StoreError } from '../store.js';
import { esc, patch, on, icon, openSheet } from './common.js';

/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./common.js').Habit} Habit */
/** @typedef {import('./common.js').PushStatus} PushStatus */
/** What the form holds. `target` is the text in the box, so "2.5" or "abc" can be refused rather than rounded.
 *  `routine` is '' (None), the id of a routine, or NEW_ROUTINE, and then `routineName` is the name typed for it.
 *  `times` keeps the habit's own reminder times while a routine is chosen, so going back to None shows them again.
 *  @typedef {{ name: string, period: string, target: string, unit: string, times: string[], routine: string,
 *    routineName: string }} FormValues */
/** @typedef {'name' | 'period' | 'target' | 'unit' | 'times' | 'routine' | 'routineName' | 'form'} Field */
/** @typedef {{ field: Field, message: string }} Problem */

// ================================ pure parts ================================

/** The 48 times a reminder can have: every :00 and :30 of the day. */
export const HALF_HOURS = everyHours('00:00', '23:30', 0.5);

/** The choices of "Every N hours" in the quick fill. */
export const EVERY_CHOICES = [0.5, 1, 2, 3, 4, 6];

/** The value of the "Routine" choice that stands for "New routine...". Never a routine id (those are 20 characters). */
export const NEW_ROUTINE = 'new';

/** The form of a new habit. @returns {FormValues} */
export const blankForm = () => ({ name: '', period: 'day', target: '1', unit: '', times: [], routine: '', routineName: '' });

/** The form filled from a stored habit. Its routine is the live one it is in (`routineOf`), so a habit of a
 *  deleted routine shows None.
 *  @param {Pick<Habit, 'name' | 'period' | 'target' | 'unit' | 'times'> & { routine?: string }} habit
 *  @param {{ id: string }[]} [routines] `state.routines` @returns {FormValues} */
export const formOf = (habit, routines = []) => ({
  name: habit.name, period: habit.period, target: String(habit.target), unit: habit.unit, times: cleanTimes(habit.times),
  routine: routineOf(habit, routines)?.id ?? '', routineName: '',
});

/** Form values as the input of `store.saveHabit()`: with `id` to change a habit, without to add one.
 *  The target becomes a number as typed (NaN when it is not one); tidying is left to `cleanHabit`.
 *  `routine` is always there ('' for None). A habit in a routine has no reminder times of its own. For
 *  "New routine..." the routine is '' here: the editor saves the routine first and then puts its id in.
 *  @param {FormValues} form @param {string | null} [id] */
export function toInput(form, id = null) {
  const target = form.target.trim();
  return {
    ...(id ? { id } : {}),
    name: form.name, period: form.period, target: target === '' ? NaN : Number(target), unit: form.unit,
    times: form.routine ? [] : [...form.times], routine: form.routine === NEW_ROUTINE ? '' : form.routine,
  };
}

/** The name typed for "New routine...", checked with the shared rules.
 *  @param {string} name @returns {{ input: { name: string, times: string[] }, problem: Problem | null }} */
export function checkRoutineName(name) {
  const input = cleanRoutine({ name, times: [] });
  const [message] = validateRoutine(input);
  return { input, problem: message ? { field: 'routineName', message } : null };
}

/** Which field a sentence from `validateHabit` is about ('form' when it is about none of them).
 *  @param {string} message @returns {Field} */
export function fieldOf(message) {
  if (/\broutine\b/i.test(message)) return 'routine';
  if (/\bname\b/i.test(message)) return 'name';
  if (/\bper day\b|\bper week\b/i.test(message)) return 'period';
  if (/\btarget\b/i.test(message)) return 'target';
  if (/\bunit\b/i.test(message)) return 'unit';
  if (/\btimes?\b/i.test(message)) return 'times';
  return 'form';
}

/** Check a form with the shared rules. `input` is what to hand to `store.saveHabit()` when `problem` is
 *  null; otherwise `problem` is the first thing wrong and the field to show it at.
 *  @param {FormValues} form @param {string | null} [id]
 *  @returns {{ input: ReturnType<typeof toInput>, problem: Problem | null }} */
export function checkForm(form, id = null) {
  const raw = toInput(form, id);
  const input = { ...raw, ...cleanHabit(raw) };
  // cleanHabit rounds the target; validate the number as it was typed, so 2.5 is refused, not saved as 3.
  const [message] = validateHabit({ ...cleanHabit(raw), target: raw.target });
  return { input, problem: message ? { field: fieldOf(message), message } : null };
}

/** Whether a draft differs from the form the editor opened with, in what would be saved.
 *  @param {FormValues} form @param {FormValues} opened @returns {boolean} */
export function formChanged(form, opened) {
  const key = (/** @type {FormValues} */ f) => JSON.stringify([f.name.trim(), f.period, f.target.trim(), f.unit.trim(),
    f.routine ? [] : cleanTimes(f.times), f.routine, f.routine === NEW_ROUTINE ? f.routineName.trim() : '']);
  return key(form) !== key(opened);
}

/** "5 of 60 characters", once the text is within a quarter of its limit (or over it); '' before that.
 *  Counts what will be saved: trimmed, runs of spaces as one.
 *  @param {string} text @param {number} max @returns {{ text: string, over: boolean }} */
export function limitNote(text, max) {
  const { length } = cleanHabit({ name: text }).name;
  return { text: length >= max - Math.floor(max / 4) ? `${length} of ${max} characters` : '', over: length > max };
}

/** How a habit's progress will read on Today, as the hint under the unit field.
 *  @param {FormValues} form @returns {string} plain text */
export function unitHint(form) {
  const { target, unit, period } = cleanHabit(toInput(form));
  const valid = Number.isInteger(target) && target >= LIMITS.targetMin && target <= LIMITS.targetMax;
  const example = `${valid ? Math.min(3, target - 1) : 3} of ${valid ? target : 8}${unit ? ` ${unit}` : ''} ${period === 'week' ? 'this week' : 'today'}`;
  return unit ? `Reads as “${example}”.` : `Optional, like glasses or pages. Without it: “${example}”.`;
}

/** The text in the target box after one press of minus (`delta` -1) or plus (+1), kept within the limits.
 *  @param {string} text @param {number} delta @returns {string} */
export function stepTarget(text, delta) {
  const now = toInput({ ...blankForm(), target: text }).target;
  if (!Number.isFinite(now)) return String(LIMITS.targetMin);
  const next = delta > 0 ? Math.floor(now) + 1 : Math.ceil(now) - 1;
  return String(Math.min(LIMITS.targetMax, Math.max(LIMITS.targetMin, next)));
}

/** Add times to a list. The result is always a valid list (on the half hour, unique, sorted, at most
 *  `max` long), and `added` holds the times that were not in it before. When the new times do not all
 *  fit, none of them is added and `over` is how many the list would have had (0 otherwise).
 *  @param {string[]} times @param {string[]} extra @param {number} [max]
 *  @returns {{ times: string[], added: string[], over: number }} */
export function addTimes(times, extra, max = LIMITS.timesMax) {
  const before = cleanTimes(times);
  const merged = cleanTimes([...times, ...extra]);
  if (merged.length > max && merged.length > before.length) return { times: before, added: [], over: merged.length };
  return { times: merged, added: merged.filter((t) => !before.includes(t)), over: 0 };
}

/** Why times were not added: the list would have gone over the limit.
 *  @param {number} over what `addTimes` returned @param {number} [max] @param {string} [what] whose times they are
 *  @returns {string} plain text */
export const overLimitMessage = (over, max = LIMITS.timesMax, what = 'a habit') => `That would make ${over} reminder times, and ${what} can have at most ${max}. `
  + 'Nothing was added: remove some times first, or choose a wider gap.';

/** @param {number} n */
const countTimes = (n) => `${n} ${n === 1 ? 'time' : 'times'}`;

/** What the quick fill did, in one sentence: how many times it added and what it covered.
 *  @param {{ start: string, hours: number, filled: string[], added: number }} fill `filled` is what
 *    `everyHours` returned (sorted); `added` is how many of those were new to the list
 *  @returns {string} plain text */
export function quickFillSummary({ start, hours, filled, added }) {
  const n = filled.length;
  if (n === 0) return 'Nothing to add for that choice.';
  // In the order they happen: a range that runs past midnight starts with its evening times.
  const inOrder = [...filled.filter((t) => t >= start), ...filled.filter((t) => t < start)];
  const first = inOrder[0], last = inOrder[n - 1];
  const every = hours === 0.5 ? '30 minutes' : hours === 1 ? 'hour' : `${hours} hours`;
  const range = n === 1 ? `at ${first}` : `every ${every} from ${first} to ${last}${last < first ? ' (past midnight)' : ''}`;
  if (added === 0) return `Nothing added: ${n === 1 ? `${first} is` : `all ${n} times (${range}) are`} already in the list.`;
  if (added === n) return `Added ${countTimes(n)}: ${range}.`;
  return `Added ${countTimes(added)}: ${range}. The other ${n - added} ${n - added === 1 ? 'was' : 'were'} already in the list.`;
}

/** Use the quick fill "Every `hours` hours between `start` and `end`" on a list of times. An end
 *  before the start runs past midnight. When the result would go over the limit the list stays as it
 *  was and `problem` says why; otherwise `summary` says what was added.
 *  @param {string[]} times @param {string} start @param {string} end @param {number} hours @param {number} [max]
 *  @param {string} [what] whose times they are, for the message @returns {{ times: string[], summary: string, problem: string }} */
export function quickFill(times, start, end, hours, max = LIMITS.timesMax, what = 'a habit') {
  const filled = everyHours(start, end, hours);
  const result = addTimes(times, filled, max);
  if (result.over) return { times: result.times, summary: '', problem: overLimitMessage(result.over, max, what) };
  const summary = quickFillSummary({ start: filled.includes(start) ? start : filled[0] ?? '', hours, filled, added: result.added.length });
  return { times: result.times, summary, problem: '' };
}

/** What to say about this device's reminders when they are not on ('' when they are).
 *  @param {PushStatus} status @returns {string} plain text */
export function pushNote(status) {
  if (status === 'on') return '';
  if (status === 'demo') return 'The demo does not send reminders.';
  if (status === 'unsupported') return 'This browser cannot show reminders.';
  if (status === 'blocked') return 'Notifications are blocked for this app on this device.';
  return 'Reminders are not turned on for this device yet.';
}

/** @typedef {{ time: string, every: string, from: string, to: string }} Picks the selects of the reminders part */

/** What the reminder selects show when a sheet opens. @returns {Picks} */
export const firstPicks = () => ({ time: '09:00', every: '2', from: '09:00', to: '21:00' });

/** One press on a button of the reminders part (`remindersView`), for the habit editor and the routine
 *  editor alike. Returns null when `action` is not one of its buttons; otherwise the new list, what to
 *  say about it (`note`), why nothing was added (`refused`, shown as the error of the times) and the
 *  selector of the control that should have the focus if the pressed one is gone.
 *  @param {string[]} before @param {Picks} picks @param {string | undefined} action
 *  @param {{ time?: string, what?: string }} [more] the time of a pressed chip; whose times they are
 *  @returns {{ times: string[], note: string, refused: string, focus: string } | null} */
export function changeTimes(before, picks, action, { time = '', what = 'a habit' } = {}) {
  const focus = '#editor-time';
  if (action === 'add-time') {
    const { times, added, over } = addTimes(before, [picks.time]);
    if (over) return { times, note: '', refused: overLimitMessage(over, LIMITS.timesMax, what), focus };
    return { times, note: added.length > 0 ? `Added ${added[0]}.` : `${picks.time} is already in the list.`, refused: '', focus };
  }
  if (action === 'fill') {
    const { times, summary, problem } = quickFill(before, picks.from, picks.to, Number(picks.every), LIMITS.timesMax, what);
    return { times, note: summary, refused: problem, focus };
  }
  if (action === 'remove-time') {
    const times = before.filter((t) => t !== time);
    // Focus goes to the time that took its place, so several can be removed in a row from the keyboard.
    const next = times[Math.min(before.indexOf(time), times.length - 1)];
    return { times, note: `Removed ${time}.`, refused: '', focus: next ? `[data-time="${next}"]` : focus };
  }
  if (action === 'clear') return { times: [], note: `Removed all ${countTimes(before.length)}.`, refused: '', focus };
  return null;
}

// ================================ the sheet ================================

/** What the habit editor and the routine editor (routine.js) have in common: a sheet with a draft.
 *  @typedef {object} Draft
 *  @property {boolean} confirming "Discard changes?" is showing in place of Cancel and Save
 *  @property {Element | null} back what had the focus when that question came up
 *  @property {Problem | null} problem
 *  @property {boolean} gone the record was deleted somewhere else while the sheet was open
 *  @property {HTMLElement | null} body
 *  @property {() => string} view the whole content of the sheet, as HTML
 *  @property {() => void} sync take what the person typed and chose into the draft
 *  @property {() => boolean} changed whether the draft differs from what the sheet opened with */

/** @typedef {Draft & SessionOnly} Session one open habit editor */
/** @typedef {object} SessionOnly
 *  @property {Ctx} ctx
 *  @property {string | null} id the habit being changed, null for a new one
 *  @property {string} savedName its name in the store, for the "Deleted" message
 *  @property {FormValues} form the draft: read back from the DOM before every render
 *  @property {FormValues} opened the form as it was when the sheet opened
 *  @property {Picks} picks the reminder selects
 *  @property {string} note what the last change to the reminder times did
 *  @property {string} spoken for screen readers only: the target after a press of minus or plus
 *  @property {() => void} close
 *  @property {() => void} end stop following the store; safe to call twice */

/** @type {Session | null} */
let session = null;

/** @param {string} name @param {string[]} values @param {string} chosen @param {(value: string) => string} [label] */
export const options = (name, values, chosen, label = (v) => v) => values
  .map((v) => `<option value="${esc(v)}"${v === chosen ? ' selected' : ''}>${esc(label(v))}</option>`).join('');

/** @param {string} value */
const everyLabel = (value) => (value === '0.5' ? '30 min' : value === '1' ? '1 hour' : `${value} hours`);

/** The attributes that tie a control to its error and hint. @param {{ problem: Problem | null }} s @param {Field} field @param {string[]} hints */
export function describe(s, field, hints = []) {
  const bad = s.problem?.field === field;
  const ids = [...(bad ? [`editor-${field}-error`] : []), ...hints];
  return `${bad ? ' aria-invalid="true"' : ''}${ids.length ? ` aria-describedby="${ids.join(' ')}"` : ''}`;
}

/** @param {{ problem: Problem | null }} s @param {Field} field */
export const errorOf = (s, field) => (s.problem?.field === field
  ? `<p class="field-error" id="editor-${field}-error" role="alert">${esc(s.problem.message)}</p>` : '');

/** "5 of 60 characters" under a text field, once `limitNote` has something to say.
 *  @param {string} field @param {{ text: string, over: boolean }} note */
export const countView = (field, note) => (note.text
  ? `<p class="field-hint num editor-count${note.over ? ' is-over' : ''}" id="editor-${field}-count">${note.text}</p>` : '');

/** The reminders part of a sheet: the chosen times, "Add a time" and the "Every N hours" quick fill. Its
 *  buttons carry data-action add-time, fill, remove-time and clear: hand those to `changeTimes`.
 *  @param {{ times: string[], picks: Picks, problem: Problem | null, note: string, status: PushStatus, hint: string }} r
 *    `hint` is plain text: when the reminders arrive and stop */
export function remindersView({ times, picks, problem, note, status, hint }) {
  const s = { problem };
  const full = times.length >= LIMITS.timesMax;
  const chips = times.map((t) => `<li data-key="${t}"><button type="button" class="editor-time num" data-action="remove-time" data-time="${t}" `
    + `aria-label="Remove ${t}">${t}${icon('close', 14)}</button></li>`).join('');
  return `<section class="editor-reminders" aria-labelledby="editor-reminders-title">
    <h3 id="editor-reminders-title">Reminders</h3>
    <p class="field-hint" id="editor-reminders-hint">${esc(hint)}</p>
    ${status === 'on' ? '' : `<div class="notice editor-push${times.length > 0 && status !== 'demo' ? ' notice-warn' : ''}" id="editor-push">
      <p>${esc(pushNote(status))}</p></div>`}
    <div class="editor-add">
      <div class="field"><label for="editor-time">Add a time</label>
        <select class="input num" id="editor-time" name="time"${describe(s, 'times')}>${options('time', HALF_HOURS, picks.time)}</select></div>
      <button type="button" class="btn" data-action="add-time">${icon('plus', 20)}Add</button>
    </div>
    <fieldset class="editor-quick">
      <legend>Or fill in a whole day</legend>
      <div class="field"><label for="editor-every">Every</label>
        <select class="input num" id="editor-every" name="every">${options('every', EVERY_CHOICES.map(String), picks.every, everyLabel)}</select></div>
      <div class="field"><label for="editor-from">between</label>
        <select class="input num" id="editor-from" name="from">${options('from', HALF_HOURS, picks.from)}</select></div>
      <div class="field"><label for="editor-to">and</label>
        <select class="input num" id="editor-to" name="to">${options('to', HALF_HOURS, picks.to)}</select></div>
      <button type="button" class="btn btn-block" data-action="fill">Fill in these times</button>
    </fieldset>
    ${errorOf(s, 'times')}
    <p class="editor-note" id="editor-note" role="status">${esc(note)}</p>
    <div class="spread editor-chosen" id="editor-chosen">
      <p class="num"><strong>${times.length === 0 ? 'No reminder times yet' : countTimes(times.length).replace('time', 'reminder time')}</strong>${
  full ? '<span class="muted">: every half hour, the most there can be</span>' : ''}</p>
      ${times.length > 0 ? '<button type="button" class="btn btn-quiet" data-action="clear" id="editor-clear">Clear all</button>' : ''}
    </div>
    ${times.length > 0 ? `<ul class="editor-times" id="editor-times" role="list" aria-label="Reminder times">${chips}</ul>` : ''}
  </section>`;
}

/** The bottom of a sheet: a note when the record is gone, the problem that belongs to no field, and
 *  Cancel and Save, or "Discard changes?" with its two answers.
 *  @param {Draft} s @param {{ save: string, goneText: string }} words the Save button's name; plain text */
export function footView(s, { save, goneText }) {
  return `<div class="editor-foot" id="editor-foot">
      ${s.gone ? `<p class="notice notice-warn" id="editor-gone" role="alert">${esc(goneText)}</p>` : ''}
      ${errorOf(s, 'form')}
      ${s.confirming ? `<div class="sheet-actions editor-confirm" id="editor-confirm" role="group" aria-labelledby="editor-confirm-text">
        <p id="editor-confirm-text">Discard changes?</p>
        <button type="button" class="btn" data-action="keep" id="editor-keep">Keep editing</button>
        <button type="button" class="btn btn-danger" data-action="discard">Discard</button>
      </div>` : `<div class="sheet-actions" id="editor-actions">
        <button type="button" class="btn" data-sheet-close id="editor-cancel">${s.gone ? 'Close' : 'Cancel'}</button>
        ${s.gone ? '' : `<button type="button" class="btn btn-primary" data-action="save">${esc(save)}</button>`}
      </div>`}
    </div>`;
}

/** The "Routine" choice and what follows from it: the name of a new routine, or the sentence that takes
 *  the place of the reminder times. @param {Session} s */
function routineView(s) {
  const { routine, routineName } = s.form;
  const routines = s.ctx.store.getState().routines ?? [];
  const chosen = routines.find((r) => r.id === routine);
  const limit = limitNote(routineName, LIMITS.routineNameMax);
  const times = chosen ? cleanTimes(chosen.times) : [];
  const from = routine === NEW_ROUTINE ? 'Once it is saved, tap its name on Today to choose its reminder times.'
    : !chosen ? '' : times.length === 0 ? `“${chosen.name}” has no reminder times yet. Tap its name on Today to choose them.`
      : `“${chosen.name}” reminds at ${times.length > 4 ? `${times.slice(0, 4).join(', ')} and ${times.length - 4} more` : times.join(', ')}, `
        + 'with one reminder for all of its habits that are still to do.';
  // Saving into a routine drops the habit's own times (contracts section 3): say so before Save, not after.
  const own = cleanTimes(s.opened.routine ? [] : s.form.times).length;
  const lost = own > 0 ? ` This habit’s own ${own === 1 ? 'reminder time is' : `${own} reminder times are`} removed when you save.` : '';
  return `<div class="field">
      <label for="editor-routine">Routine</label>
      <select class="input" id="editor-routine" name="routine"${describe(s, 'routine', ['editor-routine-hint'])}>
        <option value="" data-key="none"${routine === '' ? ' selected' : ''}>None</option>
        ${routines.map((r) => `<option value="${esc(r.id)}" data-key="r-${esc(r.id)}"${r.id === routine ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
        <option value="${NEW_ROUTINE}" data-key="new"${routine === NEW_ROUTINE ? ' selected' : ''}>New routine...</option>
      </select>
      ${errorOf(s, 'routine')}
      <p class="field-hint" id="editor-routine-hint">A routine is a list of habits you do together, like your morning, with one reminder for all of them.</p>
    </div>
    ${routine === NEW_ROUTINE ? `<div class="field" id="editor-new-routine">
      <label for="editor-routine-name">Name of the new routine</label>
      <input class="input" id="editor-routine-name" name="routineName" type="text" value="${esc(routineName)}" placeholder="Morning"
        autocomplete="off" autocapitalize="sentences" enterkeyhint="done"${describe(s, 'routineName', limit.text ? ['editor-routineName-count'] : [])}>
      ${errorOf(s, 'routineName')}${countView('routineName', limit)}
    </div>` : ''}
    ${routine ? `<div class="notice editor-from-routine" id="editor-from-routine"><p><strong>Reminders come from the routine.</strong> ${esc(from + lost)}</p></div>` : ''}`;
}

/** The whole content of the sheet for a session. @param {Session} s @returns {string} HTML */
function view(s) {
  const { form, id } = s;
  const nameLimit = limitNote(form.name, LIMITS.nameMax), unitLimit = limitNote(form.unit, LIMITS.unitMax);
  const count = countView;
  const target = toInput(form).target;
  // The error about the target already names the range, so the hint does not repeat it under it.
  const targetHint = [s.problem?.field === 'target' ? '' : `A whole number from ${LIMITS.targetMin} to ${LIMITS.targetMax}.`,
    form.period === 'week' ? 'Weeks run Monday to Sunday.' : ''].filter(Boolean).join(' ');
  const edge = (/** @type {boolean} */ at) => (at ? ' aria-disabled="true"' : '');
  return `<form class="editor" id="editor-form" novalidate>
    <div class="field">
      <label for="editor-name">Name</label>
      <input class="input" id="editor-name" name="name" type="text" value="${esc(form.name)}" placeholder="Drink water" required
        autocomplete="off" autocapitalize="sentences" enterkeyhint="done"${id ? '' : ' autofocus'}${describe(s, 'name', nameLimit.text ? ['editor-name-count'] : [])}>
      ${errorOf(s, 'name')}${count('name', nameLimit)}
    </div>
    <div class="editor-goal">
      <div class="field">
        <label for="editor-target">Target</label>
        <div class="editor-stepper">
          <button type="button" class="btn-round" data-action="step" data-delta="-1" aria-label="Decrease by 1"${edge(target <= LIMITS.targetMin)}>${icon('minus', 20)}</button>
          <input class="input num" id="editor-target" name="target" type="text" inputmode="numeric" value="${esc(form.target)}"
            autocomplete="off" enterkeyhint="done"${describe(s, 'target', targetHint ? ['editor-target-hint'] : [])}>
          <button type="button" class="btn-round" data-action="step" data-delta="1" aria-label="Increase by 1"${edge(target >= LIMITS.targetMax)}>${icon('plus', 20)}</button>
        </div>
      </div>
      <fieldset class="segmented"${describe(s, 'period')}>
        <legend>How often</legend>
        <label><input type="radio" name="period" value="day"${form.period === 'week' ? '' : ' checked'}><span>Per day</span></label>
        <label><input type="radio" name="period" value="week"${form.period === 'week' ? ' checked' : ''}><span>Per week</span></label>
      </fieldset>
      ${errorOf(s, 'target')}${errorOf(s, 'period')}
      ${targetHint ? `<p class="field-hint" id="editor-target-hint">${targetHint}</p>` : ''}
      <p class="sr-only" role="status">${esc(s.spoken)}</p>
    </div>
    <div class="field">
      <label for="editor-unit">Unit</label>
      <input class="input" id="editor-unit" name="unit" type="text" value="${esc(form.unit)}" placeholder="glasses"
        autocomplete="off" autocapitalize="none" enterkeyhint="done"${describe(s, 'unit', ['editor-unit-hint', ...(unitLimit.text ? ['editor-unit-count'] : [])])}>
      ${errorOf(s, 'unit')}${count('unit', unitLimit)}
      <p class="field-hint" id="editor-unit-hint">${esc(unitHint(form))}</p>
    </div>
    ${routineView(s)}
    ${form.routine ? '' : remindersView({
    times: form.times, picks: s.picks, problem: s.problem, note: s.note, status: s.ctx.push.getStatus(),
    hint: `Reminders arrive at about the chosen time (they can be up to 20 minutes late), stop for the ${
      form.period === 'week' ? 'week' : 'day'} once the target is reached, and need “Turn on reminders” in Settings.`,
  })}
    ${id && !s.gone ? `<div class="editor-danger" id="editor-danger">
      <button type="button" class="btn btn-danger" data-action="delete">Delete habit</button>
      <p class="field-hint">You can undo this straight afterwards.</p></div>` : ''}
    ${footView(s, { save: 'Save habit', goneText: 'This habit has been deleted, perhaps on another device, so changes to it cannot be saved.' })}
  </form>`;
}

/** The reminder selects, read from a sheet's form. @param {FormData} data @param {Picks} picks @returns {Picks} */
export function readPicks(data, picks) {
  const text = (/** @type {keyof Picks} */ name) => {
    const value = data.get(name);
    return typeof value === 'string' ? value : picks[name];
  };
  return { time: text('time'), every: text('every'), from: text('from'), to: text('to') };
}

/** Take what the person typed and chose into the draft (contract rule 2b: the DOM owns live values).
 *  @param {Session} s */
function sync(s) {
  const form = s.body?.querySelector('form');
  if (!form) return;
  const data = new FormData(form);
  const text = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const value = data.get(name);
    return typeof value === 'string' ? value : fallback;
  };
  s.form = {
    ...s.form, name: text('name', s.form.name), period: text('period', s.form.period), target: text('target', s.form.target),
    unit: text('unit', s.form.unit), routine: text('routine', s.form.routine), routineName: text('routineName', s.form.routineName),
  };
  s.picks = readPicks(data, s.picks);
}

/** Bring the sheet up to date with the draft, and keep the keyboard focus inside it when the control
 *  that had it is gone (a removed time, "Clear all"). Focus that is on its way from one control to the
 *  next (a `change` event fires while nothing has it) is left alone.
 *  @param {Draft} s @param {string} [fallback] selector */
export function draw(s, fallback = '#editor-time') {
  if (!s.body) return;
  const inside = s.body.contains(document.activeElement);
  patch(s.body, s.view());
  if (inside && !s.body.contains(document.activeElement)) {
    /** @type {HTMLElement | null} */ (s.body.querySelector(fallback) ?? s.body.querySelector('#editor-name'))?.focus();
  }
}

const FOCUS = {
  name: '#editor-name', period: 'input[name="period"]:checked', target: '#editor-target', unit: '#editor-unit', times: '#editor-time',
  routine: '#editor-routine', routineName: '#editor-routine-name', form: '',
};

/** Show a problem at its field and put the cursor there. @param {Draft} s @param {Problem} problem */
export function fail(s, problem) {
  s.problem = problem;
  draw(s);
  const control = FOCUS[problem.field] ? s.body?.querySelector(FOCUS[problem.field]) : null;
  if (control instanceof HTMLElement) control.focus();
  s.body?.querySelector(`#editor-${problem.field}-error`)?.scrollIntoView({ block: 'nearest' });
}

/** Set the "Routine" choice from code (contract rule 2b: the DOM owns the live value). A routine that is
 *  not in the list (deleted meanwhile) becomes None. @param {Session} s @param {string} routine */
function choose(s, routine) {
  const choice = s.body?.querySelector('#editor-routine');
  if (!(choice instanceof HTMLSelectElement)) return;
  choice.value = [...choice.options].some((o) => o.value === routine) ? routine : '';
  if (s.form.routine !== choice.value) {
    s.form.routine = choice.value;
    draw(s);
  }
}

/** @param {Session} s */
function save(s) {
  sync(s);
  if (s.gone) return;
  const { input, problem } = checkForm(s.form, s.id);
  if (problem) return fail(s, problem);
  let { routine } = input;
  if (s.form.routine === NEW_ROUTINE) {
    const named = checkRoutineName(s.form.routineName);
    if (named.problem) return fail(s, named.problem);
    try {
      routine = s.ctx.store.saveRoutine(named.input);
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
      return fail(s, { field: 'routineName', message: err.message });
    }
    // The routine exists from here on: should the habit be refused, Save must not make a second one.
    s.form = { ...s.form, routine, routineName: '' };
    draw(s);
    choose(s, routine);
  }
  try {
    s.ctx.store.saveHabit({ ...input, routine });
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    return fail(s, { field: err.code === 'invalid' ? fieldOf(err.message) : 'form', message: err.message });
  }
  s.end();
  s.close();
  s.ctx.toast(s.id ? 'Habit saved.' : 'Habit added.');
}

/** Delete without asking: the toast offers Undo instead. @param {Session} s */
function remove(s) {
  const { ctx, id, savedName } = s;
  if (!id) return;
  s.end();
  s.close();
  ctx.store.deleteHabit(id);
  ctx.toast(`Deleted "${savedName}".`, {
    actionLabel: 'Undo',
    onAction: () => {
      try {
        ctx.store.restoreHabit(id);
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        ctx.toast(err.message);
      }
    },
  });
}

/** The answer to openSheet's canClose (Escape, Back, the backdrop, the close button, Cancel): yes when
 *  there is nothing to lose. Otherwise the sheet stays open and asks "Discard changes?" in its foot.
 *  @param {Draft} s @returns {boolean} */
export function mayClose(s) {
  s.sync();
  if (s.gone || !s.changed()) return true;
  if (!s.confirming) {
    s.back = document.activeElement;
    s.confirming = true;
    draw(s);
  }
  /** @type {HTMLElement | null | undefined} */ (s.body?.querySelector('#editor-keep'))?.focus();
  return false;
}

/** "Keep editing": the Cancel and Save row comes back and the focus returns to where it was.
 *  @param {Draft} s */
export function keepEditing(s) {
  s.confirming = false;
  draw(s);
  const sheet = s.body?.closest('dialog');
  const back = s.back instanceof HTMLElement && s.back !== sheet && sheet?.contains(s.back) ? s.back : s.body?.querySelector('#editor-cancel');
  s.back = null;
  if (back instanceof HTMLElement) back.focus();
}

/** A click on one of the editor's own buttons. @param {Session} s @param {HTMLElement} el */
function act(s, el) {
  const { action } = el.dataset;
  if (action === 'keep') return keepEditing(s);
  if (action === 'discard') {
    s.end();
    return s.close();
  }
  s.confirming = false; // carrying on with the form answers the question
  if (action === 'delete') return remove(s);
  if (action === 'save') return save(s);
  sync(s);
  if (action === 'step') {
    s.form.target = stepTarget(s.form.target, Number(el.dataset.delta));
    /** @type {HTMLInputElement} */ (s.body?.querySelector('#editor-target')).value = s.form.target;
    s.spoken = `Target ${s.form.target}`;
    if (s.problem?.field === 'target') s.problem = null;
    return draw(s);
  }
  const change = changeTimes(s.form.times, s.picks, action, { time: el.dataset.time });
  if (!change) return undefined;
  s.form.times = change.times;
  s.note = change.note;
  if (change.refused) { // the focus stays on the button that was pressed; the message is an alert
    s.problem = { field: 'times', message: change.refused };
    draw(s);
    s.body?.querySelector('#editor-times-error')?.scrollIntoView({ block: 'nearest' });
    return undefined;
  }
  if (s.problem?.field === 'times') s.problem = null;
  return draw(s, change.focus);
}

/** Open the editor for one habit, or for a new habit when `habitId` is null.
 *  @param {string | null | undefined} habitId @param {Ctx} ctx */
export function openEditor(habitId, ctx) {
  const habit = habitId ? ctx.store.getState().habits.find((h) => h.id === habitId) : null;
  if (habitId && !habit) {
    ctx.toast('That habit no longer exists.');
    return;
  }
  session?.end();
  let unsubscribe = () => {};
  /** @type {Session} */
  const s = {
    ctx,
    id: habit ? habit.id : null,
    savedName: habit ? habit.name : '',
    form: habit ? formOf(habit, ctx.store.getState().routines) : blankForm(),
    opened: habit ? formOf(habit, ctx.store.getState().routines) : blankForm(),
    confirming: false, back: null,
    picks: firstPicks(),
    problem: null, note: '', spoken: '', gone: false, body: null,
    view: () => view(s), sync: () => sync(s), changed: () => formChanged(s.form, s.opened),
    close: () => {},
    end: () => {
      unsubscribe();
      unsubscribe = () => {};
      if (session === s) session = null;
    },
  };
  session = s;
  const sheet = openSheet({ title: habit ? 'Edit habit' : 'New habit', html: view(s), onClose: s.end, canClose: () => mayClose(s) });
  s.body = sheet.body;
  s.close = sheet.close;

  // Only the "Save habit" button saves. Enter (the Done key of a phone keyboard) in a text field puts
  // the keyboard away instead, and the form itself is never submitted.
  on(sheet.body, 'submit', 'form', (event) => {
    event.preventDefault();
  });
  on(sheet.body, 'keydown', '#editor-name, #editor-target, #editor-unit, #editor-routine-name', (event, el) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    el.blur();
  });
  on(sheet.body, 'click', '[data-action]', (_event, el) => {
    act(s, el);
  });
  // Typing and choosing: refresh what depends on it (counters, the unit example) and drop the message
  // about the field that is being corrected.
  for (const type of ['input', 'change']) {
    on(sheet.body, type, 'input, select', (_event, el) => {
      sync(s);
      const name = el.getAttribute('name');
      if (s.problem && (s.problem.field === name || s.problem.field === 'form')) s.problem = null;
      // Typing or choosing answers "Discard changes?". Not `change` alone: a text field fires it when
      // the focus leaves it for "Keep editing", which must not take the question away again.
      if (type === 'input') s.confirming = false;
      draw(s);
      // "New routine..." asks for the name right here, in the same sheet.
      if (type === 'change' && name === 'routine' && s.form.routine === NEW_ROUTINE) {
        /** @type {HTMLElement | null | undefined} */ (s.body?.querySelector('#editor-routine-name'))?.focus();
      }
    });
  }
  on(sheet.body, 'keydown', '#editor-target', (event, el) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    /** @type {HTMLInputElement} */ (el).value = stepTarget(/** @type {HTMLInputElement} */ (el).value, event.key === 'ArrowUp' ? 1 : -1);
    sync(s);
    if (s.problem?.field === 'target') s.problem = null;
    draw(s);
  });

  // A habit can be deleted on another device while it is open here: say so instead of saving into it.
  // The same goes for the routine that is chosen: the choice falls back to None.
  let routineIds = (ctx.store.getState().routines ?? []).map((r) => r.id).join();
  unsubscribe = ctx.store.subscribe((state) => {
    const ids = (state.routines ?? []).map((r) => r.id).join();
    const habitGone = Boolean(s.id) && !s.gone && !state.habits.some((h) => h.id === s.id);
    if (!habitGone && ids === routineIds) return;
    routineIds = ids;
    sync(s);
    if (habitGone) {
      s.gone = true;
      s.confirming = false;
    }
    draw(s);
    choose(s, s.form.routine); // a routine that is no longer in the list is no longer chosen
  });
}
