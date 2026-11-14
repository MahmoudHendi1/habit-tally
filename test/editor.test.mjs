// The habit editor's pure parts: form to habit, the messages, and the reminder-time helpers (R1, R4).
// The module is loaded without a DOM here, which is itself part of the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalStore } from '../src/store-local.js';
import { LIMITS, cleanHabit, validateHabit } from '../shared/logic.js';
import {
  HALF_HOURS, EVERY_CHOICES, blankForm, formOf, toInput, fieldOf, checkForm, limitNote, unitHint, stepTarget,
  addTimes, overLimitMessage, quickFill, quickFillSummary, pushNote, openEditor, formChanged, NEW_ROUTINE, checkRoutineName,
} from '../src/ui/editor.js';
import { openRoutine, blankRoutine, routineFormOf, checkRoutine, routineChanged, membersText } from '../src/ui/routine.js';
import { movedHabits, movedRoutines, canReorder } from '../src/ui/today.js';
import { groupHabits } from '../shared/logic.js';

const form = (changes = {}) => ({ ...blankForm(), name: 'Drink water', ...changes });
const hours = (from, to, step = 1) => {
  const out = [];
  for (let h = from; h <= to; h += step) out.push(`${String(h).padStart(2, '0')}:00`);
  return out;
};

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}
const openStore = () => createLocalStore({ storage: fakeStorage(), now: () => new Date('2026-11-03T12:00:00'), tz: 'Europe/London' });

test('the module loads without a DOM and does not import CSS', () => {
  assert.equal(typeof openEditor, 'function');
  const source = readFileSync(new URL('../src/ui/editor.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import[^;]*\.css['"]/);
});

test('HALF_HOURS is every :00 and :30 of the day, and nothing else', () => {
  assert.equal(HALF_HOURS.length, 48);
  assert.equal(HALF_HOURS[0], '00:00');
  assert.equal(HALF_HOURS[1], '00:30');
  assert.equal(HALF_HOURS.at(-1), '23:30');
  assert.ok(HALF_HOURS.every((t) => /^([01]\d|2[0-3]):(00|30)$/.test(t)));
  assert.deepEqual([...HALF_HOURS].sort(), HALF_HOURS);
  assert.ok(EVERY_CHOICES.includes(1) && EVERY_CHOICES.includes(2) && EVERY_CHOICES.includes(4));
});

test('a blank form needs only a name to be a valid habit', () => {
  assert.equal(checkForm(blankForm()).problem?.field, 'name');
  const { input, problem } = checkForm(form());
  assert.equal(problem, null);
  assert.deepEqual(input, { name: 'Drink water', period: 'day', target: 1, unit: '', times: [], routine: '' });
  assert.deepEqual(validateHabit(input), []);
});

test('a checked form passes the shared validation and is already clean', () => {
  const { input, problem } = checkForm(form({
    name: '  Drink   water ', period: 'week', target: ' 8 ', unit: ' glasses ', times: ['21:00', '09:00', '09:00', '13:30'],
  }), 'abc123');
  assert.equal(problem, null);
  assert.deepEqual(input, { id: 'abc123', name: 'Drink water', period: 'week', target: 8, unit: 'glasses', times: ['09:00', '13:30', '21:00'], routine: '' });
  assert.deepEqual(validateHabit(input), []);
  const { id, ...fields } = input;
  assert.deepEqual(cleanHabit(input), fields, 'the store finds nothing left to tidy');
});

test('toInput: id only when editing, target as typed', () => {
  assert.equal('id' in toInput(form()), false);
  assert.equal(toInput(form(), 'h1').id, 'h1');
  assert.equal(toInput(form({ target: '12' })).target, 12);
  assert.ok(Number.isNaN(toInput(form({ target: '' })).target));
  assert.ok(Number.isNaN(toInput(form({ target: 'abc' })).target));
});

test('formOf and checkForm round-trip a stored habit', () => {
  const habit = { id: 'h1', name: 'Gym', period: 'week', target: 3, unit: 'visits', times: ['18:00', '07:30'], created: '2026-11-01',
    archived: false, deletedAt: null, order: 1, updatedAt: 1 };
  const values = formOf(habit);
  assert.deepEqual(values, { name: 'Gym', period: 'week', target: '3', unit: 'visits', times: ['07:30', '18:00'], routine: '', routineName: '' });
  assert.deepEqual(checkForm(values, habit.id), {
    input: { id: 'h1', name: 'Gym', period: 'week', target: 3, unit: 'visits', times: ['07:30', '18:00'], routine: '' }, problem: null,
  });
});

test('an empty name cannot be saved, and the message says why', () => {
  for (const name of ['', '   ', '\n\t']) {
    const { problem } = checkForm(form({ name }));
    assert.deepEqual(problem, { field: 'name', message: 'Give the habit a name.' });
  }
  const long = checkForm(form({ name: 'x'.repeat(LIMITS.nameMax + 1) })).problem;
  assert.equal(long?.field, 'name');
  assert.match(long?.message ?? '', /60 characters/);
  assert.equal(checkForm(form({ name: 'x'.repeat(LIMITS.nameMax) })).problem, null);
});

test('a target outside 1 to 50 cannot be saved, and the message says why', () => {
  for (const target of ['0', '51', '-3', '', 'abc', '2.5', '1e3', 'Infinity']) {
    const { problem } = checkForm(form({ target }));
    assert.equal(problem?.field, 'target', `target "${target}"`);
    assert.equal(problem?.message, 'Target must be a whole number from 1 to 50.');
  }
  for (const target of ['1', '50', ' 7 ', '07']) assert.equal(checkForm(form({ target })).problem, null, `target "${target}"`);
  assert.equal(checkForm(form({ target: '07' })).input.target, 7);
});

test('the unit is optional and limited to 20 characters', () => {
  assert.equal(checkForm(form({ unit: '' })).problem, null);
  assert.equal(checkForm(form({ unit: 'x'.repeat(LIMITS.unitMax) })).problem, null);
  assert.equal(checkForm(form({ unit: 'x'.repeat(LIMITS.unitMax + 1) })).problem?.field, 'unit');
});

test('the first problem is reported, at its own field', () => {
  assert.equal(checkForm(form({ name: '', target: '99' })).problem?.field, 'name');
  assert.equal(checkForm(form({ target: '99', unit: 'x'.repeat(30) })).problem?.field, 'target');
});

test('fieldOf places every sentence of validateHabit', () => {
  const sentences = {
    name: validateHabit({ name: '', period: 'day', target: 1, unit: '', times: [] }),
    period: validateHabit({ name: 'a', period: 'month', target: 1, unit: '', times: [] }),
    target: validateHabit({ name: 'a', period: 'day', target: 0, unit: '', times: [] }),
    unit: validateHabit({ name: 'a', period: 'day', target: 1, unit: 'x'.repeat(21), times: [] }),
    times: [
      ...validateHabit({ name: 'a', period: 'day', target: 1, unit: '', times: ['09:10'] }),
      ...validateHabit({ name: 'a', period: 'day', target: 1, unit: '', times: ['09:00', '09:00'] }),
      ...validateHabit({ name: 'a', period: 'day', target: 1, unit: '', times: [...HALF_HOURS, '09:00'] }),
    ],
  };
  for (const [field, list] of Object.entries(sentences)) {
    assert.ok(list.length > 0, field);
    for (const message of list) assert.equal(fieldOf(message), field, message);
  }
  assert.equal(fieldOf('Something else went wrong.'), 'form');
});

test('checkForm never hands over invalid reminder times', () => {
  const { input, problem } = checkForm(form({ times: ['09:10', '9:00', 'soon', '25:00', '09:00', '23:59'] }));
  assert.equal(problem, null);
  assert.deepEqual(input.times, ['09:00', '23:30']);
  assert.deepEqual(validateHabit(input), []);
  const all = checkForm(form({ times: [...HALF_HOURS, ...HALF_HOURS] }));
  assert.equal(all.problem, null);
  assert.equal(all.input.times.length, LIMITS.timesMax);
});

test('addTimes: several times can be added, each once, kept sorted', () => {
  let list = addTimes([], ['09:00']);
  assert.deepEqual(list, { times: ['09:00'], added: ['09:00'], over: 0 });
  list = addTimes(list.times, ['07:30']);
  assert.deepEqual(list, { times: ['07:30', '09:00'], added: ['07:30'], over: 0 });
  list = addTimes(list.times, ['09:00']);
  assert.deepEqual(list, { times: ['07:30', '09:00'], added: [], over: 0 });
  assert.deepEqual(addTimes(['09:00'], ['12:10']).times, ['09:00', '12:00'], 'snapped to the half hour');
});

test('addTimes: going over the limit adds nothing and reports how many there would be', () => {
  assert.deepEqual(addTimes(['09:00', '10:00'], ['11:00', '12:00'], 3), { times: ['09:00', '10:00'], added: [], over: 4 });
  assert.deepEqual(addTimes(['09:00', '10:00'], ['11:00'], 3), { times: ['09:00', '10:00', '11:00'], added: ['11:00'], over: 0 });
  assert.equal(addTimes(['09:00', '10:00', '11:00'], ['10:00'], 3).over, 0, 'a time already in a full list is not "over"');
  const message = overLimitMessage(4, 3);
  assert.match(message, /4 reminder times/);
  assert.match(message, /at most 3/);
  assert.match(message, /Nothing was added/);
  assert.match(overLimitMessage(60), /at most 48/);
  // With the real limit every half hour of the day fits, so the full day is accepted.
  assert.deepEqual(addTimes(['09:00'], HALF_HOURS), { times: HALF_HOURS, added: HALF_HOURS.filter((t) => t !== '09:00'), over: 0 });
});

test('quick fill: every 2 hours between 09:00 and 21:00 gives 7 times', () => {
  const { times, summary, problem } = quickFill([], '09:00', '21:00', 2);
  assert.deepEqual(times, ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00']);
  assert.equal(summary, 'Added 7 times: every 2 hours from 09:00 to 21:00.');
  assert.equal(problem, '');
});

test('quick fill: every hour between 07:00 and 22:00 gives 16 times and is accepted', () => {
  const { times, summary, problem } = quickFill([], '07:00', '22:00', 1);
  assert.deepEqual(times, hours(7, 22));
  assert.equal(times.length, 16);
  assert.equal(summary, 'Added 16 times: every hour from 07:00 to 22:00.');
  assert.equal(problem, '');
  assert.equal(checkForm(form({ times })).problem, null);
});

test('quick fill: a range that ends before it starts runs past midnight', () => {
  const { times, summary } = quickFill([], '22:00', '06:00', 4);
  assert.deepEqual(times, ['02:00', '06:00', '22:00']);
  assert.equal(summary, 'Added 3 times: every 4 hours from 22:00 to 06:00 (past midnight).');
});

test('quick fill: merges with the times already there and says what was new', () => {
  const some = quickFill(['08:30', '11:00'], '09:00', '13:00', 2);
  assert.deepEqual(some.times, ['08:30', '09:00', '11:00', '13:00']);
  assert.equal(some.summary, 'Added 2 times: every 2 hours from 09:00 to 13:00. The other 1 was already in the list.');
  const none = quickFill(some.times, '09:00', '13:00', 2);
  assert.deepEqual(none.times, some.times);
  assert.match(none.summary, /^Nothing added: all 3 times/);
  const one = quickFill([], '09:00', '09:00', 2);
  assert.deepEqual(one.times, ['09:00']);
  assert.equal(one.summary, 'Added 1 time: at 09:00.');
  assert.equal(quickFillSummary({ start: '', hours: 2, filled: [], added: 0 }), 'Nothing to add for that choice.');
});

test('quick fill: every 30 minutes round the clock is the 48 there can be; a fill never goes over the limit', () => {
  const day = quickFill(['09:00'], '00:00', '23:30', 0.5);
  assert.deepEqual(day.times, HALF_HOURS);
  assert.equal(day.problem, '');
  assert.equal(checkForm(form({ times: day.times })).problem, null);
  // Every choice, from every start, on top of a full list: the result is always a list the store accepts.
  for (const every of EVERY_CHOICES) {
    for (const start of ['00:00', '09:00', '22:30']) {
      const result = quickFill(HALF_HOURS, start, '06:00', every);
      assert.ok(result.times.length <= LIMITS.timesMax);
      assert.deepEqual(validateHabit(checkForm(form({ times: result.times })).input), []);
    }
  }
  // A lower limit shows the refusal: the list is untouched and the message says why.
  const refused = quickFill(['08:00'], '09:00', '21:00', 2, 6);
  assert.deepEqual(refused.times, ['08:00']);
  assert.equal(refused.summary, '');
  assert.equal(refused.problem, overLimitMessage(8, 6));
});

test('stepTarget moves by one and stays within 1 to 50', () => {
  assert.equal(stepTarget('1', 1), '2');
  assert.equal(stepTarget('2', -1), '1');
  assert.equal(stepTarget('1', -1), '1');
  assert.equal(stepTarget('50', 1), '50');
  assert.equal(stepTarget('99', -1), '50');
  assert.equal(stepTarget('-4', 1), '1');
  assert.equal(stepTarget('2.5', 1), '3');
  assert.equal(stepTarget('2.5', -1), '2');
  assert.equal(stepTarget('', 1), '1');
  assert.equal(stepTarget('abc', -1), '1');
});

test('limitNote counts what will be saved and appears near the limit', () => {
  assert.deepEqual(limitNote('Water', 60), { text: '', over: false });
  assert.deepEqual(limitNote('x'.repeat(45), 60), { text: '45 of 60 characters', over: false });
  assert.deepEqual(limitNote(`  ${'x'.repeat(60)}  `, 60), { text: '60 of 60 characters', over: false });
  assert.deepEqual(limitNote('x'.repeat(61), 60), { text: '61 of 60 characters', over: true });
});

test('unitHint shows how progress will read', () => {
  assert.match(unitHint(form({ target: '8', unit: 'glasses' })), /3 of 8 glasses today/);
  assert.match(unitHint(form({ target: '3', unit: 'runs', period: 'week' })), /2 of 3 runs this week/);
  assert.match(unitHint(form({ target: '1', unit: '' })), /Optional.*0 of 1 today/);
  assert.match(unitHint(form({ target: 'abc', unit: '' })), /3 of 8 today/);
});

test('pushNote says why reminders will not arrive on this device', () => {
  assert.equal(pushNote('on'), '');
  for (const status of ['demo', 'unsupported', 'blocked', 'off']) assert.ok(pushNote(status).length > 0, status);
  assert.notEqual(pushNote('blocked'), pushNote('off'));
});

test('formChanged: a draft differs from the opened form only in what would be saved', () => {
  const opened = form({ name: 'Drink water', target: '8', unit: 'glasses', times: ['09:00', '11:00'] });
  assert.equal(formChanged({ ...opened, times: [...opened.times] }, opened), false);
  assert.equal(formChanged({ ...opened, name: ' Drink water ', target: '8 ', times: ['11:00', '09:00'] }, opened), false);
  assert.equal(formChanged(blankForm(), blankForm()), false);
  for (const change of [{ name: 'Drink tea' }, { period: 'week' }, { target: '9' }, { unit: '' }, { times: ['09:00'] }, { times: [...opened.times, '13:00'] }]) {
    assert.equal(formChanged({ ...opened, ...change }, opened), true, JSON.stringify(change));
  }
});

test('what the editor hands over is saved unchanged by the store; what it refuses, the store refuses too', () => {
  const store = openStore();
  const { times } = quickFill(['07:30'], '09:00', '21:00', 2);
  const { input, problem } = checkForm(form({ name: ' Drink  water ', target: '8', unit: 'glasses', times }));
  assert.equal(problem, null);
  const id = store.saveHabit(input);
  const saved = store.getState().habits.find((h) => h.id === id);
  assert.ok(saved);
  assert.deepEqual(validateHabit(saved), []);
  assert.deepEqual(
    { name: saved.name, period: saved.period, target: saved.target, unit: saved.unit, times: saved.times },
    { name: 'Drink water', period: 'day', target: 8, unit: 'glasses', times: ['07:30', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00'] },
  );

  // Edit: the form of the saved habit, changed, goes back in under the same id.
  const edit = checkForm({ ...formOf(saved), period: 'week', target: '3', times: [] }, id);
  assert.equal(edit.problem, null);
  assert.equal(store.saveHabit(edit.input), id);
  const after = store.getState().habits.find((h) => h.id === id);
  assert.deepEqual([after?.period, after?.target, after?.times, after?.created, after?.order], ['week', 3, [], saved.created, saved.order]);
  assert.equal(store.getState().habits.length, 1);

  for (const bad of [form({ name: '' }), form({ target: '0' }), form({ target: '51' })]) {
    const checked = checkForm(bad);
    assert.ok(checked.problem);
    assert.throws(() => store.saveHabit(toInput(bad)), (err) => err.code === 'invalid' && err.message === checked.problem.message);
  }
  assert.equal(store.getState().habits.length, 1);
});

// ---------- routines (v1.3) ----------

const RID = 'R'.repeat(20), GONE = 'G'.repeat(20);

test('formOf shows the live routine of a habit, and None for a deleted or unknown one', () => {
  const habit = { name: 'Take pills', period: 'day', target: 1, unit: '', times: [], routine: RID };
  assert.equal(formOf(habit, [{ id: RID, name: 'Morning', deletedAt: null }]).routine, RID);
  assert.equal(formOf(habit, [{ id: RID, name: 'Morning', deletedAt: 5 }]).routine, '');
  assert.equal(formOf({ ...habit, routine: GONE }, [{ id: RID, name: 'Morning', deletedAt: null }]).routine, '');
  assert.equal(formOf(habit).routine, '');
  const { routine, ...old } = habit;
  assert.equal(formOf(old, [{ id: RID, name: 'Morning', deletedAt: null }]).routine, '', 'a habit from before routines');
});

test('a habit in a routine is saved with that routine and without reminder times of its own', () => {
  const { input, problem } = checkForm(form({ routine: RID, times: ['09:00', '21:00'] }));
  assert.equal(problem, null);
  assert.equal(input.routine, RID);
  assert.deepEqual(input.times, []);
  assert.deepEqual(validateHabit(input), []);
  // "New routine...": the routine does not exist yet, so the input names none and carries no times.
  const fresh = checkForm(form({ routine: NEW_ROUTINE, routineName: 'Morning', times: ['09:00'] }));
  assert.equal(fresh.problem, null);
  assert.equal(fresh.input.routine, '');
  assert.deepEqual(fresh.input.times, []);
  // None again: the times the habit had are back.
  assert.deepEqual(checkForm(form({ routine: '', times: ['09:00'] })).input.times, ['09:00']);
});

test('a routine that is not an id is refused at the Routine choice', () => {
  const { problem } = checkForm(form({ routine: 'nonsense' }));
  assert.equal(problem?.field, 'routine');
  assert.equal(fieldOf('Choose a routine from the list.'), 'routine');
  assert.equal(fieldOf('A habit in a routine takes its reminder times from the routine.'), 'routine');
});

test('checkRoutineName: the name of a new routine follows the shared rules', () => {
  assert.deepEqual(checkRoutineName('  Morning   pills '), { input: { name: 'Morning pills', times: [] }, problem: null });
  assert.equal(checkRoutineName('   ').problem?.field, 'routineName');
  assert.equal(checkRoutineName('x'.repeat(LIMITS.routineNameMax)).problem, null);
  assert.match(checkRoutineName('x'.repeat(LIMITS.routineNameMax + 1)).problem?.message ?? '', /40/);
});

test('formChanged sees a change of routine, but not hidden reminder times', () => {
  const opened = { ...blankForm(), name: 'Take pills', routine: RID };
  assert.equal(formChanged({ ...opened, times: ['09:00'] }, opened), false, 'times are not saved while a routine is chosen');
  assert.equal(formChanged({ ...opened, routine: '' }, opened), true);
  assert.equal(formChanged({ ...opened, routine: NEW_ROUTINE }, opened), true);
  const fresh = { ...opened, routine: NEW_ROUTINE, routineName: 'Evening' };
  assert.equal(formChanged({ ...fresh, routineName: ' Evening ' }, fresh), false);
  assert.equal(formChanged({ ...fresh, routineName: 'Night' }, fresh), true);
});

test('the editor input creates a routine and a habit in it through the store', () => {
  const store = openStore();
  const routineId = store.saveRoutine(checkRoutineName('Morning').input);
  const { input } = checkForm(form({ name: 'Take pills', routine: NEW_ROUTINE, routineName: 'Morning', times: ['08:00'] }));
  const id = store.saveHabit({ ...input, routine: routineId });
  const saved = store.getState().habits.find((h) => h.id === id);
  assert.equal(saved.routine, routineId);
  assert.deepEqual(saved.times, []);
  assert.equal(formOf(saved, store.getState().routines).routine, routineId);
  store.deleteRoutine(routineId);
  assert.equal(formOf(saved, store.getState().routines).routine, '');
});

// ---------- Reorder mode on Today (v1.3) ----------

test('Move up and Move down: every live id in the new order, moves stay inside a section', () => {
  const A = 'A'.repeat(20), B = 'B'.repeat(20);
  const routines = [{ id: A, name: 'Morning', order: 1, deletedAt: null }, { id: B, name: 'Evening', order: 2, deletedAt: null }];
  const habit = (id, order, routine = '') => ({ id, name: id, order, routine, archived: false, deletedAt: null });
  const habits = [habit('loose1', 1), habit('a1', 2, A), habit('loose2', 3), habit('a2', 4, A), habit('b1', 5, B)];
  // Display order: Morning (a1, a2), Evening (b1), Other habits (loose1, loose2).
  assert.deepEqual(movedHabits(habits, routines, 'a2', -1), ['a2', 'a1', 'b1', 'loose1', 'loose2']);
  assert.deepEqual(movedHabits(habits, routines, 'loose1', 1), ['a1', 'a2', 'b1', 'loose2', 'loose1']);
  assert.equal(movedHabits(habits, routines, 'a1', -1), null, 'the first of its section');
  assert.equal(movedHabits(habits, routines, 'a2', 1), null, 'the last of its section, not into the next one');
  assert.equal(movedHabits(habits, routines, 'b1', 1), null);
  assert.equal(movedHabits(habits, routines, 'nobody', 1), null);
  assert.deepEqual(movedRoutines(routines, B, -1), [B, A]);
  assert.equal(movedRoutines(routines, A, -1), null);
  assert.equal(movedRoutines(routines, B, 1), null);
  assert.equal(canReorder(groupHabits(habits, routines), routines), true);
  assert.equal(canReorder(groupHabits([habit('x', 1)], []), []), false);
  assert.equal(canReorder(groupHabits([habit('x', 1), habit('y', 2)], []), []), true);
});

test('a move through the store keeps the order after the swap', () => {
  const store = openStore();
  const r = store.saveRoutine({ name: 'Morning', times: [] });
  const ids = ['Pills', 'Teeth', 'Water'].map((name, i) => store.saveHabit({ name, period: 'day', target: 1, unit: '', times: [], routine: i < 2 ? r : '' }));
  const { habits, routines } = store.getState();
  store.reorderHabits(movedHabits(habits, routines, ids[1], -1));
  const after = store.getState();
  assert.deepEqual(groupHabits(after.habits, after.routines).map((g) => g.habits.map((h) => h.name)), [['Teeth', 'Pills'], ['Water']]);
});

// ---------- the routine editor (v1.3) ----------

test('routine.js loads without a DOM and does not import CSS', () => {
  assert.equal(typeof openRoutine, 'function');
  for (const file of ['routine.js', 'today.js', 'progress.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8'), /import[^;]*\.css['"]/, file);
  }
});

test('checkRoutine: a name is needed, times are tidied, and the store takes the input as it is', () => {
  assert.equal(checkRoutine(blankRoutine()).problem?.field, 'name');
  assert.equal(checkRoutine({ name: 'x'.repeat(LIMITS.routineNameMax + 1), times: [] }).problem?.field, 'name');
  const { input, problem } = checkRoutine({ name: '  Morning   pills ', times: ['07:30', '07:00', '07:00'] });
  assert.equal(problem, null);
  assert.deepEqual(input, { name: 'Morning pills', times: ['07:00', '07:30'] });
  const store = openStore();
  const id = store.saveRoutine(input);
  const saved = store.getState().routines.find((r) => r.id === id);
  assert.deepEqual(routineFormOf(saved), { name: 'Morning pills', times: ['07:00', '07:30'] });
  const edit = checkRoutine({ ...routineFormOf(saved), name: 'Morning' }, id);
  assert.equal(edit.input.id, id);
  assert.equal(store.saveRoutine(edit.input), id);
  assert.equal(store.getState().routines.find((r) => r.id === id).name, 'Morning');
  assert.equal(routineChanged({ name: ' Morning ', times: ['07:30', '07:00'] }, routineFormOf(store.getState().routines[0])), false);
  assert.equal(routineChanged({ name: 'Morning', times: ['07:00'] }, routineFormOf(store.getState().routines[0])), true);
});

test('the quick fill and the limit message speak of a routine in the routine editor', () => {
  const { problem } = quickFill(HALF_HOURS.slice(0, 47), '00:00', '23:30', 0.5, 40, 'a routine');
  assert.match(problem, /a routine can have at most 40/);
  assert.match(overLimitMessage(49), /a habit can have at most 48/);
  assert.match(membersText([]), /No habits in this routine yet/);
  assert.match(membersText(['Take pills']), /^1 habit: Take pills\./);
  assert.match(membersText(['Take pills', 'Brush teeth']), /^2 habits: Take pills, Brush teeth\./);
});
