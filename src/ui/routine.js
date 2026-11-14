// @ts-check
// The routine editor: a bottom sheet to add, rename or delete a routine and to choose its reminder times.
// A routine is a named, ordered list of habits done together; which habits are in it is chosen in the
// habit editor. Not a screen: Today opens it with ctx.openRoutine(). The reminder times, the quick fill
// and the sheet's behaviour are the habit editor's own pieces (editor.js); styles: editor.css.
// Contract: src/ui/common.js rules 1 to 6 and docs/contracts.md section 10.
import { LIMITS, cleanRoutine, validateRoutine, cleanTimes, groupHabits } from '../../shared/logic.js';
import { StoreError } from '../store.js';
import { esc, on, openSheet } from './common.js';
import {
  limitNote, firstPicks, readPicks, changeTimes, remindersView, footView, countView, describe, errorOf, draw, fail, mayClose, keepEditing,
} from './editor.js';

/** @typedef {import('./common.js').Ctx} Ctx */
/** @typedef {import('./editor.js').Problem} Problem */
/** @typedef {{ name: string, times: string[] }} RoutineForm */

// ================================ pure parts ================================

/** @returns {RoutineForm} */
export const blankRoutine = () => ({ name: '', times: [] });

/** @param {{ name: string, times: string[] }} routine @returns {RoutineForm} */
export const routineFormOf = (routine) => ({ name: routine.name, times: cleanTimes(routine.times) });

/** Check a form with the shared rules. `input` is what to hand to `store.saveRoutine()` when `problem` is null.
 *  @param {RoutineForm} form @param {string | null} [id]
 *  @returns {{ input: { id?: string, name: string, times: string[] }, problem: Problem | null }} */
export function checkRoutine(form, id = null) {
  const input = { ...(id ? { id } : {}), ...cleanRoutine(form) };
  const [message] = validateRoutine(input);
  return { input, problem: message ? { field: routineFieldOf(message), message } : null };
}

/** Which field a sentence from `validateRoutine` is about. @param {string} message @returns {'name' | 'times' | 'form'} */
export function routineFieldOf(message) {
  if (/\bname\b/i.test(message)) return 'name';
  if (/\btimes?\b/i.test(message)) return 'times';
  return 'form';
}

/** @param {RoutineForm} form @param {RoutineForm} opened @returns {boolean} whether Save would change anything */
export function routineChanged(form, opened) {
  const key = (/** @type {RoutineForm} */ f) => JSON.stringify([f.name.trim(), cleanTimes(f.times)]);
  return key(form) !== key(opened);
}

/** Who is in the routine, in one sentence. @param {string[]} names habit names, in order @returns {string} plain text */
export function membersText(names) {
  if (names.length === 0) return 'No habits in this routine yet. To put one in, open the habit and choose this routine in it.';
  return `${names.length === 1 ? '1 habit' : `${names.length} habits`}: ${names.join(', ')}. To add or take out a habit, open it and change its routine.`;
}

// ================================ the sheet ================================

/** @typedef {import('./editor.js').Draft & RoutineOnly} RoutineSession */
/** @typedef {object} RoutineOnly
 *  @property {Ctx} ctx
 *  @property {string | null} id the routine being changed, null for a new one
 *  @property {string} savedName its name in the store, for the "Deleted" message
 *  @property {RoutineForm} form the draft
 *  @property {RoutineForm} opened the form as it was when the sheet opened
 *  @property {import('./editor.js').Picks} picks
 *  @property {string} note what the last change to the reminder times did
 *  @property {() => void} close
 *  @property {() => void} end stop following the store; safe to call twice */

/** @type {RoutineSession | null} */
let session = null;

/** @param {RoutineSession} s @returns {string} HTML */
function view(s) {
  const { form, id } = s;
  const limit = limitNote(form.name, LIMITS.routineNameMax);
  const { habits, routines = [] } = s.ctx.store.getState();
  const members = id ? groupHabits(habits, routines).find((/** @type {{ routine: { id: string } | null }} */ g) => g.routine?.id === id)?.habits ?? [] : [];
  return `<form class="editor" id="editor-form" novalidate>
    <div class="field">
      <label for="editor-name">Name</label>
      <input class="input" id="editor-name" name="name" type="text" value="${esc(form.name)}" placeholder="Morning" required
        autocomplete="off" autocapitalize="sentences" enterkeyhint="done"${id ? '' : ' autofocus'}${describe(s, 'name', ['editor-name-hint', ...(limit.text ? ['editor-name-count'] : [])])}>
      ${errorOf(s, 'name')}${countView('name', limit)}
      <p class="field-hint" id="editor-name-hint">${esc(id ? membersText(members.map((/** @type {{ name: string }} */ h) => h.name))
    : 'A routine is a list of habits you do together. After saving, open a habit and choose this routine in it.')}</p>
    </div>
    ${remindersView({
    times: form.times, picks: s.picks, problem: s.problem, note: s.note, status: s.ctx.push.getStatus(),
    hint: 'One reminder for the whole routine. It arrives at about the chosen time (it can be up to 20 minutes late), lists the habits '
      + 'that are still to do, stops once they are all done, and needs “Turn on reminders” in Settings.',
  })}
    ${id && !s.gone ? `<div class="editor-danger" id="editor-danger">
      <button type="button" class="btn btn-danger" data-action="delete">Delete routine</button>
      <p class="field-hint">Its habits stay, under “Other habits”. You can undo this straight afterwards.</p></div>` : ''}
    ${footView(s, { save: 'Save routine', goneText: 'This routine has been deleted, perhaps on another device, so changes to it cannot be saved.' })}
  </form>`;
}

/** @param {RoutineSession} s */
function sync(s) {
  const form = s.body?.querySelector('form');
  if (!form) return;
  const data = new FormData(form);
  const name = data.get('name');
  s.form = { ...s.form, name: typeof name === 'string' ? name : s.form.name };
  s.picks = readPicks(data, s.picks);
}

/** @param {RoutineSession} s */
function save(s) {
  sync(s);
  if (s.gone) return;
  const { input, problem } = checkRoutine(s.form, s.id);
  if (problem) return fail(s, problem);
  try {
    s.ctx.store.saveRoutine(input);
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    return fail(s, { field: err.code === 'invalid' ? routineFieldOf(err.message) : 'form', message: err.message });
  }
  s.end();
  s.close();
  s.ctx.toast(s.id ? 'Routine saved.' : 'Routine added.');
}

/** Delete without asking: the toast offers Undo instead. @param {RoutineSession} s */
function remove(s) {
  const { ctx, id, savedName } = s;
  if (!id) return;
  s.end();
  s.close();
  ctx.store.deleteRoutine(id);
  ctx.toast(`Deleted the routine "${savedName}".`, {
    actionLabel: 'Undo',
    onAction: () => {
      try {
        ctx.store.restoreRoutine(id);
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        ctx.toast(err.message);
      }
    },
  });
}

/** @param {RoutineSession} s @param {HTMLElement} el */
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
  const change = changeTimes(s.form.times, s.picks, action, { time: el.dataset.time, what: 'a routine' });
  if (!change) return undefined;
  s.form.times = change.times;
  s.note = change.note;
  if (change.refused) {
    s.problem = { field: 'times', message: change.refused };
    draw(s);
    s.body?.querySelector('#editor-times-error')?.scrollIntoView({ block: 'nearest' });
    return undefined;
  }
  if (s.problem?.field === 'times') s.problem = null;
  return draw(s, change.focus);
}

/** Open the editor for one routine, or for a new routine when `routineId` is null.
 *  @param {string | null | undefined} routineId @param {Ctx} ctx */
export function openRoutine(routineId, ctx) {
  const routine = routineId ? (ctx.store.getState().routines ?? []).find((r) => r.id === routineId) : null;
  if (routineId && !routine) {
    ctx.toast('That routine no longer exists.');
    return;
  }
  session?.end();
  let unsubscribe = () => {};
  /** @type {RoutineSession} */
  const s = {
    ctx,
    id: routine ? routine.id : null,
    savedName: routine ? routine.name : '',
    form: routine ? routineFormOf(routine) : blankRoutine(),
    opened: routine ? routineFormOf(routine) : blankRoutine(),
    confirming: false, back: null, picks: firstPicks(), problem: null, note: '', gone: false, body: null,
    view: () => view(s), sync: () => sync(s), changed: () => routineChanged(s.form, s.opened),
    close: () => {},
    end: () => {
      unsubscribe();
      unsubscribe = () => {};
      if (session === s) session = null;
    },
  };
  session = s;
  const sheet = openSheet({ title: routine ? 'Edit routine' : 'New routine', html: view(s), onClose: s.end, canClose: () => mayClose(s) });
  s.body = sheet.body;
  s.close = sheet.close;

  // Only "Save routine" saves; Enter in the name puts the keyboard away.
  on(sheet.body, 'submit', 'form', (event) => {
    event.preventDefault();
  });
  on(sheet.body, 'keydown', '#editor-name', (event, el) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    el.blur();
  });
  on(sheet.body, 'click', '[data-action]', (_event, el) => {
    act(s, el);
  });
  for (const type of ['input', 'change']) {
    on(sheet.body, type, 'input, select', (_event, el) => {
      sync(s);
      if (s.problem && (s.problem.field === el.getAttribute('name') || s.problem.field === 'form')) s.problem = null;
      if (type === 'input') s.confirming = false;
      draw(s);
    });
  }
  // A routine can be deleted on another device while it is open here; its habits can change too.
  unsubscribe = ctx.store.subscribe((state) => {
    sync(s);
    if (s.id && !s.gone && !(state.routines ?? []).some((r) => r.id === s.id)) {
      s.gone = true;
      s.confirming = false;
    }
    draw(s);
  });
}
