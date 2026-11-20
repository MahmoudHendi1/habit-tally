import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, weekStart, weekKeys, countOn, periodCount, isHit, streak, stats,
  snapTime, cleanTimes, everyHours, localParts, planRun, dueTimes, dueWindows, dueHabits, reminderText, SLOT_MS,
  startDay,
  LIMITS, summary, recentDays, calendarWeeks, cleanHabit, validateHabit, sortHabits,
  cleanRoutine, validateRoutine, sortRoutines, routineOf, groupHabits, routineLeft, dueRoutines, routineReminderText,
  REMINDER_BODY_MAX, routineIdsOf, routinesOf, doneIn, routineProgress, moveHabitIds,
} from '../shared/logic.js';

const logsOf = (entries) => {
  const logs = {};
  for (const [k, id, n] of entries) ((logs[k.slice(0, 7)] ??= {})[k] ??= {})[id] = n;
  return logs;
};
const water = { id: 'w', name: 'Water', period: 'day', target: 3, times: ['09:00', '15:00'], created: '2026-11-02' };
const gym = { id: 'g', name: 'Gym', period: 'week', target: 3, times: ['18:00'], created: '2026-11-04' };

test('dates: add days across months and find the Monday', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekStart('2026-11-13'), '2026-11-09'); // Friday -> Monday
  assert.equal(weekStart('2026-11-15'), '2026-11-09'); // Sunday belongs to the same week
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.deepEqual(weekKeys('2026-11-01').at(0), '2026-10-26'); // week spans two months
});

test('counts: daily and weekly progress', () => {
  const logs = logsOf([['2026-10-30', 'g', 1], ['2026-11-01', 'g', 1], ['2026-11-02', 'g', 1], ['2026-11-13', 'w', 2], ['2026-11-12', 'w', -1]]);
  assert.equal(countOn(logs, 'w', '2026-11-13'), 2);
  assert.equal(countOn(logs, 'w', '2026-11-12'), 0); // a negative count never shows
  assert.equal(periodCount(gym, logs, '2026-10-28'), 2); // Oct 26 - Nov 1, across the month boundary
  assert.equal(periodCount(gym, logs, '2026-11-03'), 1);
  assert.equal(isHit(water, logs, '2026-11-13'), false);
});

test('streak: daily, with today still in progress', () => {
  const logs = logsOf([['2026-11-10', 'w', 3], ['2026-11-11', 'w', 4], ['2026-11-12', 'w', 3], ['2026-11-13', 'w', 1]]);
  assert.equal(streak(water, logs, '2026-11-13'), 3);
  logs['2026-11']['2026-11-13'].w = 3;
  assert.equal(streak(water, logs, '2026-11-13'), 4);
  assert.equal(streak(water, logs, '2026-11-15'), 0); // missed the 14th
});

test('streak and stats: weekly habit counted by week', () => {
  const logs = logsOf([
    ['2026-11-04', 'g', 1], ['2026-11-06', 'g', 1], ['2026-11-08', 'g', 1], // week of Nov 2: hit
    ['2026-11-09', 'g', 2], ['2026-11-11', 'g', 1],                          // week of Nov 9: hit
    ['2026-11-16', 'g', 1],                                                  // week of Nov 16: in progress
  ]);
  assert.equal(streak(gym, logs, '2026-11-17'), 2);
  const s = stats(gym, logs, '2026-11-17');
  assert.deepEqual(s, { total: 7, periods: 3, hitPeriods: 2, best: 2, streak: 2 });
});

test('stats: daily totals and best streak', () => {
  const logs = logsOf([['2026-11-02', 'w', 3], ['2026-11-03', 'w', 3], ['2026-11-04', 'w', 1], ['2026-11-05', 'w', 3]]);
  const s = stats(water, logs, '2026-11-06');
  assert.deepEqual(s, { total: 10, periods: 5, hitPeriods: 3, best: 2, streak: 1 });
});

test('reminder times snap to half hours', () => {
  assert.equal(snapTime('09:10'), '09:00');
  assert.equal(snapTime('09:20'), '09:30');
  assert.equal(snapTime('23:55'), '23:30');
  assert.equal(snapTime('nope'), null);
  assert.deepEqual(cleanTimes(['15:00', '09:10', '09:00', '']), ['09:00', '15:00']);
  assert.deepEqual(everyHours('09:00', '21:00', 4), ['09:00', '13:00', '17:00', '21:00']);
  assert.deepEqual(everyHours('09:00', '10:00', 0.5), ['09:00', '09:30', '10:00']);
});

test('localParts: converts an instant to the user\'s day and slot', () => {
  const ms = Date.UTC(2026, 10, 13, 23, 30); // 13 Nov 2026 23:30 UTC
  assert.deepEqual(localParts(ms, 'Europe/London'), { day: '2026-11-13', time: '23:30' });
  assert.deepEqual(localParts(ms, 'Africa/Cairo'), { day: '2026-11-14', time: '01:30' });
  assert.deepEqual(localParts(ms, 'Asia/Kolkata'), { day: '2026-11-14', time: '05:00' });
  assert.deepEqual(localParts(Date.UTC(2026, 6, 1, 0, 0), 'Europe/London'), { day: '2026-07-01', time: '01:00' }); // summer time
  assert.deepEqual(localParts(ms, 'Not/AZone'), { day: '2026-11-13', time: '23:30' }); // bad zone falls back to UTC
});

test('everyHours: hourly quick-fill, overnight ranges and bad input', () => {
  assert.equal(everyHours('07:00', '22:00', 1).length, 16);
  assert.deepEqual(everyHours('22:00', '06:00', 4), ['02:00', '06:00', '22:00']);
  assert.deepEqual(everyHours('09:00', '09:00', 2), ['09:00']);
  assert.deepEqual(everyHours('09:00', '21:00', 0), []);
  assert.deepEqual(everyHours('x', '21:00', 2), []);
  assert.equal(everyHours('00:00', '23:30', 0.5).length, LIMITS.timesMax);
});

test('planRun: on time, late, repeated, missed and first run', () => {
  const nine = Date.UTC(2026, 10, 13, 9, 0);
  const min = 60 * 1000;
  // scheduled at 08:56, runs on time: takes the 09:00 slot, window is the last half hour
  assert.deepEqual(planRun(nine - SLOT_MS, nine - 4 * min), { slot: nine, from: nine - SLOT_MS });
  // runs 12 minutes late: still the 09:00 slot
  assert.deepEqual(planRun(nine - SLOT_MS, nine + 12 * min), { slot: nine, from: nine - SLOT_MS });
  // a second run in the same half hour does nothing
  assert.equal(planRun(nine, nine + 15 * min), null);
  // one run was skipped: the window grows to an hour
  assert.deepEqual(planRun(nine - 2 * SLOT_MS, nine + 2 * min), { slot: nine, from: nine - 2 * SLOT_MS });
  // a long outage: still only one extra half hour
  assert.deepEqual(planRun(nine - 20 * SLOT_MS, nine), { slot: nine, from: nine - 2 * SLOT_MS });
  // first ever run: the current half hour only
  assert.deepEqual(planRun(null, nine), { slot: nine, from: nine - SLOT_MS });
  assert.deepEqual(planRun(0, nine), { slot: nine, from: nine - SLOT_MS });
});

test('dueTimes: local window for whole-hour, half-hour and 45-minute zones', () => {
  const at = (h, m) => Date.UTC(2026, 10, 13, h, m);
  assert.deepEqual(dueTimes(at(8, 30), at(9, 0), 'Europe/London'), { day: '2026-11-13', times: ['09:00'] });
  assert.deepEqual(dueTimes(at(8, 0), at(9, 0), 'Europe/London'), { day: '2026-11-13', times: ['08:30', '09:00'] });
  assert.deepEqual(dueTimes(at(3, 0), at(3, 30), 'Asia/Kolkata'), { day: '2026-11-13', times: ['09:00'] });
  // Kathmandu is UTC+5:45: 03:30 UTC is 09:15 local, so the window (08:45, 09:15] holds 09:00
  assert.deepEqual(dueTimes(at(3, 0), at(3, 30), 'Asia/Kathmandu'), { day: '2026-11-13', times: ['09:00'] });
  assert.deepEqual(dueTimes(at(3, 30), at(4, 0), 'Asia/Kathmandu'), { day: '2026-11-13', times: ['09:30'] });
  // midnight: 00:00 belongs to the new day
  assert.deepEqual(dueTimes(at(23, 30), at(24, 0), 'Europe/London'), { day: '2026-11-14', times: ['00:00'] });
  assert.deepEqual(dueTimes(at(18, 0), at(18, 30), 'Asia/Kathmandu'), { day: '2026-11-14', times: ['00:00'] });
  // every half-hour time of a normal day is sent exactly once
  for (const tz of ['Europe/London', 'Asia/Kathmandu', 'Australia/Eucla', 'Pacific/Chatham', 'America/St_Johns']) {
    const seen = [];
    for (let s = at(0, 0); s < at(24, 0); s += SLOT_MS) seen.push(...dueTimes(s - SLOT_MS, s, tz).times);
    assert.equal(seen.length, 48, tz);
    assert.equal(new Set(seen).size, 48, tz);
  }
});

test('dueTimes: daylight-saving changes', () => {
  const count = (from, to, tz) => {
    const n = {};
    for (let s = from; s <= to; s += SLOT_MS) for (const t of dueTimes(s - SLOT_MS, s, tz).times) n[t] = (n[t] || 0) + 1;
    return n;
  };
  // London, 29 March 2026: 01:00 GMT becomes 02:00 BST. The skipped 01:00 and 01:30 are sent at 02:00.
  assert.deepEqual(dueTimes(Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 0), 'Europe/London'),
    { day: '2026-03-29', times: ['01:00', '01:30', '02:00'] });
  const spring = count(Date.UTC(2026, 2, 29, 0, 0), Date.UTC(2026, 2, 29, 23, 30) - 3600e3, 'Europe/London');
  assert.equal(Object.keys(spring).length, 48);
  assert.ok(Object.values(spring).every((v) => v === 1));
  // London, 25 October 2026: 02:00 BST becomes 01:00 GMT. Only 01:30 is sent twice.
  const autumn = count(Date.UTC(2026, 9, 24, 23, 0), Date.UTC(2026, 9, 25, 23, 30), 'Europe/London');
  assert.equal(Object.keys(autumn).length, 48);
  assert.deepEqual(Object.entries(autumn).filter(([, v]) => v !== 1), [['01:30', 2]]);
});

test('dueHabits: skips habits that are done, archived or not scheduled', () => {
  const habits = [water, gym, { ...water, id: 'a', archived: true }];
  let logs = {};
  assert.deepEqual(dueHabits(habits, logs, '2026-11-13', '09:00').map((h) => h.id), ['w']);
  assert.deepEqual(dueHabits(habits, logs, '2026-11-13', '18:00').map((h) => h.id), ['g']);
  assert.deepEqual(dueHabits(habits, logs, '2026-11-13', '12:00'), []);
  logs = logsOf([['2026-11-13', 'w', 3], ['2026-11-13', 'g', 1]]);
  assert.deepEqual(dueHabits(habits, logs, '2026-11-13', '09:00'), []); // daily target hit
  assert.deepEqual(dueHabits(habits, logs, '2026-11-13', '18:00'), []); // gym already logged today
  assert.deepEqual(dueHabits(habits, logs, '2026-11-14', '18:00').map((h) => h.id), ['g']); // 1 of 3 this week
  logs = logsOf([['2026-11-09', 'g', 3]]);
  assert.deepEqual(dueHabits(habits, logs, '2026-11-14', '18:00'), []); // weekly target hit
  // a list of times (a catch-up window), deleted habits, and junk in `times`
  assert.deepEqual(dueHabits(habits, {}, '2026-11-13', ['08:30', '09:00']).map((h) => h.id), ['w']);
  assert.deepEqual(dueHabits([{ ...water, deletedAt: 1 }], {}, '2026-11-13', '09:00'), []);
  assert.deepEqual(dueHabits([{ ...water, times: 'nope' }, { ...water, times: undefined }], {}, '2026-11-13', '09:00'), []);
  assert.deepEqual(dueHabits(habits, {}, '2026-11-13', []), []);
});

test('reminderText', () => {
  assert.deepEqual(reminderText({ ...water, unit: 'glasses' }, {}, '2026-11-13'), { title: 'Water', body: 'Not started today. Target: 3 glasses.' });
  assert.deepEqual(reminderText(gym, logsOf([['2026-11-10', 'g', 1]]), '2026-11-13'), { title: 'Gym', body: '1 of 3 done this week.' });
});

test('summary and recentDays', () => {
  const logs = logsOf([['2026-11-13', 'w', 3], ['2026-11-11', 'g', 3]]);
  const habits = [water, gym, { ...water, id: 'a', archived: true }, { ...water, id: 'd', deletedAt: 5 }];
  assert.deepEqual(summary(habits, logs, '2026-11-13'), { done: 2, total: 2 });
  assert.deepEqual(summary(habits, logs, '2026-11-12'), { done: 1, total: 2 });
  assert.deepEqual(recentDays('2026-11-03'), ['2026-11-03', '2026-11-02', '2026-11-01', '2026-10-31', '2026-10-30', '2026-10-29', '2026-10-28', '2026-10-27']);
});

test('calendarWeeks: 15 Monday-first columns ending this week', () => {
  const logs = logsOf([['2026-11-10', 'w', 3], ['2026-11-11', 'w', 2], ['2026-11-12', 'w', 1], ['2026-11-01', 'w', 9]]);
  const cal = calendarWeeks(water, logs, '2026-11-13');
  assert.equal(cal.length, 15);
  assert.equal(cal.at(-1).start, '2026-11-09');
  assert.equal(cal.at(0).start, '2026-08-03');
  const week = cal.at(-1).days;
  assert.deepEqual(week.map((d) => d.level), [0, 3, 2, 1, 0, 0, 0]);
  assert.deepEqual(week.map((d) => d.future), [false, false, false, false, false, true, true]);
  // a back-filled day before the start date counts: it becomes the habit's first day
  const sunday = cal.at(-3).days.at(6);
  assert.deepEqual(sunday, { key: '2026-11-01', count: 9, level: 3, future: false, before: false });
  assert.equal(cal.at(-3).days.at(5).before, true);
  // weekly habit: logged days are level 2, or 3 in a week that hit the target
  const wlogs = logsOf([['2026-11-02', 'g', 1], ['2026-11-04', 'g', 2], ['2026-11-10', 'g', 1]]);
  const wcal = calendarWeeks(gym, wlogs, '2026-11-13');
  assert.equal(wcal.at(-2).hit, true);
  assert.deepEqual(wcal.at(-2).days.map((d) => d.level), [3, 0, 3, 0, 0, 0, 0]);
  assert.equal(wcal.at(-1).hit, false);
  assert.deepEqual(wcal.at(-1).days.map((d) => d.level), [0, 2, 0, 0, 0, 0, 0]);
});

test('cleanHabit and validateHabit', () => {
  const clean = cleanHabit({ name: '  Drink   water ', period: 'day', target: '8', unit: ' glasses ', times: ['09:10', '09:00', '15:00'], junk: 1 });
  assert.deepEqual(clean, { name: 'Drink water', period: 'day', target: 8, unit: 'glasses', times: ['09:00', '15:00'], routines: [] });
  assert.deepEqual(validateHabit(clean), []);
  assert.deepEqual(validateHabit({ ...clean, created: '2026-11-13' }), []);
  assert.equal(validateHabit(cleanHabit({ name: '', target: 3 })).length, 1);
  assert.equal(validateHabit(cleanHabit({ name: 'x'.repeat(61), target: 3 })).length, 1);
  for (const target of [0, 51, 'abc', 2.4 + 100]) assert.equal(validateHabit(cleanHabit({ name: 'A', target })).length, 1, String(target));
  assert.equal(validateHabit({ ...clean, times: ['09:10'] }).length, 1);
  assert.equal(validateHabit({ ...clean, times: everyHours('00:00', '23:30', 0.5) }).length, 0);
  assert.equal(validateHabit({ ...clean, times: [...everyHours('00:00', '23:30', 0.5), '00:00'] }).length, 1);
  assert.equal(validateHabit({ ...clean, period: 'month' }).length, 1);
  assert.equal(validateHabit({ ...clean, unit: 'x'.repeat(21) }).length, 1);
  assert.equal(validateHabit({ ...clean, created: '13/11/2026' }).length, 1);
  assert.equal(validateHabit(null).length, 1);
});

test('sortHabits: by order, deleted left out', () => {
  const hs = [{ id: 'b', order: 2 }, { id: 'c', order: 1, deletedAt: 9 }, { id: 'a', order: 2 }, { id: 'z', order: 0 }];
  assert.deepEqual(sortHabits(hs).map((h) => h.id), ['z', 'a', 'b']);
});

test('sortHabits: equal order falls back to the name by code units, then the id, whatever the locale', () => {
  const ids = (list) => sortHabits(list).map((h) => h.id);
  // Code units put 'Z' before 'a' and 'z' before 'ä'; a locale comparison would give a, ä, Z, z.
  const hs = [{ id: '1', name: 'ä' }, { id: '2', name: 'a' }, { id: '3', name: 'z' }, { id: '4', name: 'Z' }];
  assert.deepEqual(ids(hs), ['4', '2', '3', '1']);
  assert.deepEqual(ids([{ id: 'b', name: 'Same', order: 1 }, { id: 'a', name: 'Same', order: 1 }]), ['a', 'b']);
  assert.deepEqual(ids([{ id: 'a', name: 'Aaa', order: 2 }, { id: 'b', name: 'Zzz', order: 1 }]), ['b', 'a']); // order still wins
  assert.deepEqual(ids([{ id: 'B' }, { id: 'a' }]), ['B', 'a']); // ids by code units too
});

test('startDay: a back-filled day moves the first day, an undone one does not', () => {
  assert.equal(startDay(water, {}), '2026-11-02');
  const logs = logsOf([['2026-10-30', 'w', 3], ['2026-10-31', 'w', 3], ['2026-11-01', 'w', 3], ['2026-11-02', 'w', 3], ['2026-10-20', 'g', 1]]);
  assert.equal(startDay(water, logs), '2026-10-30');
  assert.equal(streak(water, logs, '2026-11-02'), 4);
  assert.deepEqual(stats(water, logs, '2026-11-02'), { total: 12, periods: 4, hitPeriods: 4, best: 4, streak: 4 });
  // a mistaken tap seven days back that was undone (count back to 0) leaves no trace
  const undone = logsOf([['2026-10-27', 'w', 0], ['2026-11-02', 'w', 3]]);
  assert.equal(startDay(water, undone), '2026-11-02');
  assert.deepEqual(stats(water, undone, '2026-11-02'), { total: 3, periods: 1, hitPeriods: 1, best: 1, streak: 1 });
  // counts stored as text or junk never corrupt totals
  const junk = { '2026-11': { '2026-11-03': { w: '5' }, '2026-11-04': { w: 'x' }, '2026-11-05': { w: {} } } };
  assert.equal(countOn(junk, 'w', '2026-11-03'), 5);
  assert.equal(countOn(junk, 'w', '2026-11-04'), 0);
  assert.equal(stats(water, junk, '2026-11-05').total, 5);
});

test('dueWindows: a catch-up window across midnight judges each time on its own day', () => {
  const at = (h, m) => Date.UTC(2026, 10, 13, h, m);
  assert.deepEqual(dueWindows(at(8, 30), at(9, 0), 'Europe/London'), [{ day: '2026-11-13', times: ['09:00'] }]);
  assert.deepEqual(dueWindows(at(8, 0), at(9, 0), 'Europe/London'), [{ day: '2026-11-13', times: ['08:30', '09:00'] }]);
  assert.deepEqual(dueWindows(at(23, 0), at(24, 0), 'Europe/London'), [
    { day: '2026-11-13', times: ['23:30'] }, { day: '2026-11-14', times: ['00:00'] },
  ]);
  // a habit finished on the 13th with a 23:30 reminder is not sent by the midnight catch-up run
  const late = { ...water, times: ['23:30'] };
  const logs = logsOf([['2026-11-13', 'w', 3]]);
  const due = dueWindows(at(23, 0), at(24, 0), 'Europe/London').flatMap((w) => dueHabits([late], logs, w.day, w.times));
  assert.deepEqual(due, []);
  assert.deepEqual(dueWindows(at(9, 0), at(9, 0), 'Europe/London'), []);
});

test('input hardening: snapTime, cleanTimes, planRun', () => {
  assert.equal(snapTime('25:00'), null);
  assert.equal(snapTime('09:75'), null);
  assert.equal(snapTime(900), null);
  assert.deepEqual(cleanTimes('09:00'), []);
  assert.deepEqual(cleanHabit({ name: 'A', target: 1, times: '09:00' }).times, []);
  const nine = Date.UTC(2026, 10, 13, 9, 0);
  for (const junk of ['x', NaN, -5, {}, undefined]) assert.deepEqual(planRun(junk, nine), { slot: nine, from: nine - SLOT_MS });
});

// ---------- routines (contract v1.3) ----------

const RID = 'morningRoutine000001'; // 20 letters or digits, like every id
const morning = { id: RID, name: 'Morning', times: ['07:00', '07:30'], order: 1, deletedAt: null, updatedAt: 1 };
const evening = { id: 'eveningRoutine000001', name: 'Evening', times: ['21:00'], order: 2, deletedAt: null, updatedAt: 1 };
const pills = { id: 'p', name: 'Take pills', period: 'day', target: 1, unit: '', times: [], routines: [RID], order: 1, created: '2026-11-02' };
const teeth = { id: 't', name: 'Brush teeth', period: 'day', target: 2, unit: '', times: [], routines: [RID], order: 2, created: '2026-11-02' };
const run = { id: 'r', name: 'Run', period: 'week', target: 3, unit: '', times: [], routines: [RID], order: 3, created: '2026-11-02' };
const ids = (list) => list.map((x) => x.id);

test('LIMITS: routine limits', () => {
  assert.equal(LIMITS.routineNameMax, 40);
  assert.equal(LIMITS.routinesMax, 20);
  assert.equal(LIMITS.routinesPerHabitMax, 5);
  assert.equal(LIMITS.habitsMax, 50);
});

test('cleanHabit and validateHabit: a habit in a routine has no reminder times of its own', () => {
  const clean = cleanHabit({ name: 'Take pills', target: 1, times: ['07:00'], routines: [` ${RID} `] });
  assert.deepEqual(clean, { name: 'Take pills', period: 'day', target: 1, unit: '', times: [], routines: [RID] });
  assert.equal('routine' in clean, false);
  assert.deepEqual(validateHabit(clean), []);
  assert.deepEqual(cleanHabit({ name: 'A', target: 1, times: ['07:00'], routines: [] }).times, ['07:00']);
  for (const junk of [undefined, null, 5, {}, 'x', [5, null, '', '  ']]) {
    assert.deepEqual(cleanHabit({ name: 'A', target: 1, routines: junk }).routines, [], String(junk));
  }
  // both a routine and times, or a routine that is not an id, is refused; a missing field counts as []
  assert.deepEqual(validateHabit({ ...clean, times: ['07:00'] }), ['A habit in a routine takes its reminder times from the routine.']);
  for (const bad of ['morning', `${RID}x`, 'morning-routine-0001', 7, {}, null]) {
    assert.deepEqual(validateHabit({ ...clean, routines: [RID, bad] }), ['Choose a routine from the list.'], String(bad));
  }
  for (const bad of [RID, 7, {}]) assert.deepEqual(validateHabit({ ...clean, routines: bad }), ['Choose a routine from the list.'], String(bad));
  const { routines, ...none } = cleanHabit({ name: 'A', target: 1, times: ['07:00'] });
  assert.deepEqual(routines, []);
  assert.deepEqual(validateHabit(none), []);
  assert.deepEqual(validateHabit({ ...none, routines: null }), []);
});

test('cleanHabit and validateHabit: several routines, at most five, none twice (v1.4)', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(20));
  const clean = cleanHabit({ name: 'Brush teeth', target: 2, times: ['07:00'], routines: [five[1], five[0], ` ${five[1]}`] });
  assert.deepEqual(clean.routines, [five[1], five[0]]); // repeats dropped, first place kept, no sorting
  assert.deepEqual(clean.times, []);
  assert.deepEqual(validateHabit({ ...clean, routines: five }), []);
  assert.deepEqual(validateHabit({ ...clean, routines: [...five, 'f'.repeat(20)] }), ['A habit can be in at most 5 routines.']);
  assert.deepEqual(validateHabit({ ...clean, routines: [five[0], five[0]] }), ['A routine is chosen twice.']);
  // cleaning never drops ids to meet the limit: six stay six, and validateHabit refuses them
  assert.equal(cleanHabit({ name: 'A', target: 1, routines: [...five, 'f'.repeat(20)] }).routines.length, 6);
});

test('old data: a habit with the v1.3 field `routine` is read as routines (v1.4)', () => {
  assert.deepEqual(routineIdsOf({ routine: RID }), [RID]);
  assert.deepEqual(routineIdsOf({ routine: ` ${RID} ` }), [RID]);
  for (const none of [{ routine: '' }, { routine: '  ' }, {}, { routine: 5 }, { routine: null }, null, undefined, 'x']) {
    assert.deepEqual(routineIdsOf(none), [], JSON.stringify(none));
  }
  // `routines`, when it is an array, wins over `routine`
  assert.deepEqual(routineIdsOf({ routines: [], routine: RID }), []);
  assert.deepEqual(routineIdsOf({ routines: ['x', 'x', 7, ''], routine: RID }), ['x']);
  assert.deepEqual(routineIdsOf({ routines: 'nope', routine: RID }), [RID]);
  // the editor input and the stored habit of v1.3 still clean, validate and group
  const old = { ...pills, routines: undefined, routine: RID };
  assert.deepEqual(cleanHabit(old).routines, [RID]);
  assert.deepEqual(validateHabit({ name: 'A', period: 'day', target: 1, unit: '', times: [], routine: RID }), []);
  assert.deepEqual(validateHabit({ name: 'A', period: 'day', target: 1, unit: '', times: ['07:00'], routine: RID }),
    ['A habit in a routine takes its reminder times from the routine.']);
  assert.deepEqual(validateHabit({ name: 'A', period: 'day', target: 1, unit: '', times: [], routine: 'morning' }), ['Choose a routine from the list.']);
  assert.deepEqual(validateHabit({ name: 'A', period: 'day', target: 1, unit: '', times: ['07:00'], routine: '' }), []);
  assert.deepEqual(routinesOf(old, [morning]), [morning]);
  assert.deepEqual(groupHabits([old], [morning]).map((g) => [g.routine?.id ?? null, ids(g.habits)]), [[RID, ['p']]]);
});

test('cleanRoutine and validateRoutine', () => {
  const clean = cleanRoutine({ name: '  Morning   things ', times: ['07:10', '07:00', '06:30'], order: 9, id: 'x' });
  assert.deepEqual(clean, { name: 'Morning things', times: ['06:30', '07:00'] });
  assert.deepEqual(validateRoutine(clean), []);
  assert.deepEqual(validateRoutine({ ...morning }), []);
  for (const junk of [undefined, null, 'x', 5, {}, []]) {
    assert.deepEqual(cleanRoutine(junk), { name: '', times: [] });
    assert.ok(validateRoutine(junk).length >= 1);
  }
  assert.deepEqual(validateRoutine(cleanRoutine({ name: '   ' })), ['Give the routine a name.']);
  assert.equal(validateRoutine({ name: '   ', times: [] }).length, 1); // blank, even when not cleaned
  assert.equal(validateRoutine({ name: 'x'.repeat(40), times: [] }).length, 0);
  assert.equal(validateRoutine({ name: 'x'.repeat(41), times: [] }).length, 1);
  assert.equal(validateRoutine({ name: 7, times: [] }).length, 1);
  assert.equal(validateRoutine({ name: 'A', times: ['07:10'] }).length, 1);
  assert.equal(validateRoutine({ name: 'A', times: 'nope' }).length, 1);
  assert.equal(validateRoutine({ name: 'A', times: ['07:00', '07:00'] }).length, 1);
  assert.equal(validateRoutine({ name: 'A', times: everyHours('00:00', '23:30', 0.5) }).length, 0);
  assert.equal(validateRoutine({ name: 'A', times: [...everyHours('00:00', '23:30', 0.5), '00:00'] }).length, 1);
  assert.equal(validateRoutine({ name: '', times: ['x'] }).length, 2);
});

test('sortRoutines: by order, then name, deleted left out', () => {
  const rs = [{ id: 'c', name: 'Zed', order: 2 }, { id: 'd', name: 'Gone', order: 0, deletedAt: 9 }, { id: 'b', name: 'Alpha', order: 2 },
    { id: 'a', name: 'Last', order: 3 }, { id: 'e', name: 'First', order: 1 }];
  assert.deepEqual(ids(sortRoutines(rs)), ['e', 'b', 'c', 'a']);
  assert.equal(rs[0].id, 'c'); // the input is not reordered
  assert.deepEqual(ids(sortRoutines([{ id: 'b', name: 'Same' }, { id: 'a', name: 'Same' }])), ['a', 'b']); // same order and name: by id
  for (const junk of [undefined, null, 'x', {}, [null, 5, 'x']]) assert.deepEqual(sortRoutines(junk), []);
});

test('routinesOf: the live routines a habit is in, in routine order (v1.4)', () => {
  const both = { ...teeth, routines: [evening.id, RID] };
  assert.deepEqual(routinesOf(both, [evening, morning]), [morning, evening]); // display order, not stored order
  assert.deepEqual(routinesOf(both, [{ ...evening, order: 0 }, morning]).map((r) => r.name), ['Evening', 'Morning']);
  assert.deepEqual(routinesOf(both, [evening]), [evening]); // Morning missing: ignored
  assert.deepEqual(routinesOf(both, [{ ...morning, deletedAt: 5 }, evening]), [evening]); // Morning deleted: ignored
  assert.deepEqual(routinesOf(both, [{ ...morning, deletedAt: 5 }]), []); // no live routine: loose
  assert.deepEqual(routinesOf(water, [morning]), []); // no routine field at all
  assert.deepEqual(routinesOf({ ...pills, routines: [] }, [{ ...morning, id: '' }]), []);
  assert.deepEqual(routinesOf(pills, [morning, { ...morning }]).length, 1); // a repeated routine record counts once
  for (const junk of [undefined, null, 'x', {}, [null, 4]]) assert.deepEqual(routinesOf(pills, junk), []);
  for (const junk of [undefined, null, 'x', {}]) assert.deepEqual(routinesOf(junk, [morning]), []);
  // routineOf (deprecated) is the first of them
  assert.equal(routineOf(both, [evening, morning]), morning);
  assert.equal(routineOf(both, [evening]), evening);
  assert.equal(routineOf(water, [morning]), null);
  for (const junk of [undefined, null, 'x', {}]) assert.equal(routineOf(pills, junk), null);
  assert.equal(routineOf(null, [morning]), null);
});

test('groupHabits: one section per live routine in order, then the loose habits', () => {
  const loose = { ...water, order: 1 };
  const late = { ...gym, order: 9, routines: [evening.id] };
  const groups = groupHabits([teeth, loose, late, pills, { ...run, deletedAt: 4 }], [evening, morning]);
  assert.deepEqual(groups.map((g) => [g.routine?.id ?? null, ids(g.habits)]), [[RID, ['p', 't']], [evening.id, ['g']], [null, ['w']]]);
  // an empty routine keeps its section; no loose section when every habit is in a routine
  assert.deepEqual(groupHabits([pills], [morning, evening]).map((g) => [g.routine.name, ids(g.habits)]), [['Morning', ['p']], ['Evening', []]]);
  // no routines: one loose section, also when there are no habits
  assert.deepEqual(groupHabits([gym, { ...water, order: -1 }], []), [{ routine: null, habits: [{ ...water, order: -1 }, gym] }]);
  assert.deepEqual(groupHabits([], []), [{ routine: null, habits: [] }]);
  // a habit of a deleted or missing routine is loose
  const gone = groupHabits([pills, teeth], [{ ...morning, deletedAt: 5 }, evening]);
  assert.deepEqual(gone.map((g) => [g.routine?.id ?? null, ids(g.habits)]), [[evening.id, []], [null, ['p', 't']]]);
  assert.deepEqual(groupHabits([pills], undefined), [{ routine: null, habits: [pills] }]);
  for (const junk of [undefined, null, 'x', {}, [null, 3]]) assert.deepEqual(groupHabits(junk, junk), [{ routine: null, habits: [] }]);
});

test('groupHabits: a habit in several routines is in the section of each, and never loose (v1.4)', () => {
  const both = { ...teeth, routines: [evening.id, RID] };
  const floss = { ...pills, id: 'f', name: 'Floss', order: 0, routines: [evening.id] };
  const groups = groupHabits([water, both, pills, floss], [evening, morning]);
  assert.deepEqual(groups.map((g) => [g.routine?.id ?? null, ids(g.habits)]), [[RID, ['p', 't']], [evening.id, ['f', 't']], [null, ['w']]]);
  assert.equal(groups[0].habits[1], groups[1].habits[1]); // the same habit object, one count
  // one of its routines deleted: still in the other, not loose
  const gone = groupHabits([water, both, pills], [{ ...evening, deletedAt: 1 }, morning]);
  assert.deepEqual(gone.map((g) => [g.routine?.id ?? null, ids(g.habits)]), [[RID, ['p', 't']], [null, ['w']]]);
  // both deleted: loose
  assert.deepEqual(groupHabits([both], [{ ...morning, deletedAt: 1 }]), [{ routine: null, habits: [both] }]);
});

test('routineLeft: member habits not yet done, in routine order', () => {
  const habits = [run, teeth, pills, water, { ...pills, id: 'd', deletedAt: 3 }, { ...pills, id: 'a', archived: true }];
  const day = '2026-11-13'; // a Friday
  assert.deepEqual(ids(routineLeft(morning, habits, [morning], {}, day)), ['p', 't', 'r']);
  let logs = logsOf([[day, 'p', 1], [day, 't', 1]]);
  assert.deepEqual(ids(routineLeft(morning, habits, [morning], logs, day)), ['t', 'r']); // teeth: 1 of 2 (its only routine is its last: the full target)
  // a weekly habit inside a routine: left until its week's target is hit, but not again on a day it was logged
  logs = logsOf([['2026-11-10', 'r', 1], ['2026-11-11', 'r', 1]]);
  assert.deepEqual(ids(routineLeft(morning, [run], [morning], logs, day)), ['r']); // 2 of 3 this week, nothing today
  logs = logsOf([['2026-11-10', 'r', 1], [day, 'r', 1]]);
  assert.deepEqual(routineLeft(morning, [run], [morning], logs, day), []); // had its turn today
  assert.deepEqual(ids(routineLeft(morning, [run], [morning], logs, '2026-11-14')), ['r']); // due again the next day
  logs = logsOf([['2026-11-09', 'r', 2], ['2026-11-10', 'r', 1]]);
  assert.deepEqual(routineLeft(morning, [run], [morning], logs, '2026-11-15'), []); // week's target hit (Sunday, same week)
  assert.deepEqual(ids(routineLeft(morning, [run], [morning], logs, '2026-11-16')), ['r']); // a new week
  // a deleted routine, another routine, and junk
  assert.deepEqual(routineLeft({ ...morning, deletedAt: 8 }, habits, [morning], {}, day), []);
  assert.deepEqual(routineLeft(evening, habits, [morning, evening], {}, day), []);
  assert.deepEqual(routineLeft(morning, habits, [evening], {}, day), []); // `routines` must hold the routine
  for (const junk of [undefined, null, 'x', {}]) {
    assert.deepEqual(routineLeft(junk, habits, [morning], {}, day), []);
    assert.deepEqual(routineLeft(morning, junk, [morning], junk, day), []);
    assert.deepEqual(routineLeft(morning, habits, junk, {}, day), []);
  }
});

test('dueRoutines: live routines with a matching time and something left', () => {
  const habits = [pills, teeth, { ...gym, routines: [evening.id], times: [] }];
  const day = '2026-11-13';
  let due = dueRoutines([evening, morning], habits, {}, day, '07:00');
  assert.deepEqual(due.map((d) => [d.routine.id, ids(d.left)]), [[RID, ['p', 't']]]);
  assert.equal(due[0].routine, morning);
  assert.deepEqual(dueRoutines([evening, morning], habits, {}, day, '12:00'), []);
  // a list of times (a catch-up window) can make two routines due, in routine order
  due = dueRoutines([evening, morning], habits, {}, day, ['21:00', '07:30', '03:00']);
  assert.deepEqual(due.map((d) => d.routine.name), ['Morning', 'Evening']);
  // nothing left, an empty routine, a deleted routine: no reminder
  const logs = logsOf([[day, 'p', 1], [day, 't', 2]]);
  assert.deepEqual(dueRoutines([morning], habits, logs, day, '07:00'), []);
  assert.deepEqual(ids(dueRoutines([morning], habits, logs, '2026-11-14', '07:00')[0].left), ['p', 't']); // a new day
  assert.deepEqual(dueRoutines([{ ...morning, id: 'emptyRoutine00000001' }], habits, {}, day, '07:00'), []);
  assert.deepEqual(dueRoutines([{ ...morning, deletedAt: 2 }], habits, {}, day, '07:00'), []);
  // junk
  assert.deepEqual(dueRoutines([{ ...morning, times: 'nope' }, { ...morning, times: undefined }, null], habits, {}, day, '07:00'), []);
  assert.deepEqual(dueRoutines([morning], habits, {}, day, []), []);
  assert.deepEqual(dueRoutines([morning], habits, {}, day, undefined), []);
  for (const junk of [undefined, null, 'x', {}]) assert.deepEqual(dueRoutines(junk, junk, junk, day, '07:00'), []);
});

test('dueHabits with routines: a habit in a live routine sends no reminder of its own', () => {
  const day = '2026-11-13';
  const both = { ...water, id: 'b', routines: [RID] }; // a stored habit with a routine and times (the rules refuse it)
  const habits = [water, both];
  assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00', [morning])), ['w']);
  // a deleted or missing routine, or no routines passed: the habit is loose
  assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00', [{ ...morning, deletedAt: 1 }])), ['w', 'b']);
  assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00', [evening])), ['w', 'b']);
  assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00', [])), ['w', 'b']);
  assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00')), ['w', 'b']);
  for (const junk of [null, 'x', {}, [null, 4]]) assert.deepEqual(ids(dueHabits(habits, {}, day, '09:00', junk)), ['w', 'b']);
  // the usual member (no times of its own) is never due by itself, with or without routines
  assert.deepEqual(dueHabits([pills, teeth], {}, day, ['07:00', '09:00'], [morning]), []);
  assert.deepEqual(dueHabits([pills, teeth], {}, day, ['07:00', '09:00']), []);
  // each habit is reminded exactly one way
  const all = [water, pills, teeth];
  const viaRoutine = dueRoutines([morning], all, {}, day, ['07:00', '09:00']).flatMap((d) => ids(d.left));
  assert.deepEqual([...ids(dueHabits(all, {}, day, ['07:00', '09:00'], [morning])), ...viaRoutine].sort(), ['p', 't', 'w']);
});

// ---------- habits in several routines (contract v1.4) ----------

const night = { id: 'nightRoutine00000001', name: 'Night', times: ['23:00'], order: 3, deletedAt: null, updatedAt: 1 };
const shared = { ...teeth, id: 's', routines: [evening.id, RID] }; // Brush teeth, target 2, in Morning and Evening
const all3 = [morning, evening, night];

test('doneIn: the k-th routine of a daily habit needs min(k, target) taps, the last one the whole target', () => {
  const day = '2026-11-13';
  const at = (n) => logsOf([[day, 's', n]]);
  const done = (habit, r, n, rs = all3) => doneIn(habit, r, rs, at(n), day);
  // target 2 in Morning and Evening: Morning after the first tap, Evening after the second
  assert.deepEqual([0, 1, 2, 3].map((n) => [done(shared, morning, n), done(shared, evening, n)]),
    [[false, false], [true, false], [true, true], [true, true]]);
  // target 1: one tap does both
  const once = { ...shared, target: 1 };
  assert.deepEqual([0, 1].map((n) => [done(once, morning, n), done(once, evening, n)]), [[false, false], [true, true]]);
  // in one routine only: the whole target, as in v1.3
  assert.deepEqual([1, 2].map((n) => done({ ...teeth, id: 's' }, morning, n)), [false, true]);
  // three routines, target 2: 1, 2, 2; target 5: 1, 2, 5 (the last routine carries the rest)
  const three = { ...shared, routines: [night.id, evening.id, RID] };
  assert.deepEqual([1, 2].map((n) => [morning, evening, night].map((r) => done(three, r, n))), [[true, false, false], [true, true, true]]);
  const five = { ...three, target: 5 };
  assert.deepEqual([2, 4, 5].map((n) => [morning, evening, night].map((r) => done(five, r, n))),
    [[true, true, false], [true, true, false], [true, true, true]]);
  // the order is the routines' display order, not the stored order: Evening first when it is shown first
  const flipped = [{ ...evening, order: 0 }, morning];
  assert.deepEqual([done(shared, flipped[0], 1, flipped), done(shared, morning, 1, flipped)], [true, false]);
  // a deleted routine is not counted: Evening becomes the first (and last) routine
  const noMorning = [{ ...morning, deletedAt: 1 }, evening];
  assert.deepEqual([done(shared, evening, 1, noMorning), done(shared, evening, 2, noMorning)], [false, true]);
  assert.equal(done(shared, { ...morning, deletedAt: 1 }, 2, noMorning), false);
  // a weekly habit is done in every routine once the week's target is hit
  const weekly = { ...run, id: 's', routines: [RID, evening.id] };
  const week = logsOf([['2026-11-10', 's', 2], [day, 's', 1]]);
  assert.deepEqual([doneIn(weekly, morning, all3, week, day), doneIn(weekly, evening, all3, week, day)], [true, true]);
  assert.deepEqual([doneIn(weekly, morning, all3, at(1), day), doneIn(weekly, evening, all3, at(1), day)], [false, false]);
  // not a member, not in `routines`, junk
  assert.equal(done(shared, night, 2), false);
  assert.equal(done(shared, morning, 2, [evening]), false);
  for (const junk of [undefined, null, 'x', {}]) {
    assert.equal(doneIn(junk, morning, all3, at(2), day), false);
    assert.equal(doneIn(shared, junk, all3, at(2), day), false);
    assert.equal(doneIn(shared, morning, junk, at(2), day), false);
    assert.equal(doneIn(shared, morning, all3, junk, day), false);
  }
});

test('routineLeft and routineProgress: a shared habit is left, and done, in each routine on its own (v1.4)', () => {
  const day = '2026-11-13';
  const habits = [pills, shared, { ...pills, id: 'f', name: 'Floss', order: 5, routines: [evening.id] }, water];
  const rs = [evening, morning];
  const both = (logs) => [morning, evening].map((r) => [ids(routineLeft(r, habits, rs, logs, day)), routineProgress(r, habits, rs, logs, day)]);
  assert.deepEqual(both({}), [[['p', 's'], { done: 0, total: 2 }], [['s', 'f'], { done: 0, total: 2 }]]);
  // one tap of Brush teeth (in either section: one count) is its Morning share
  assert.deepEqual(both(logsOf([[day, 'p', 1], [day, 's', 1]])), [[[], { done: 2, total: 2 }], [['s', 'f'], { done: 0, total: 2 }]]);
  assert.deepEqual(both(logsOf([[day, 's', 2], [day, 'f', 1]])), [[['p'], { done: 1, total: 2 }], [[], { done: 2, total: 2 }]]);
  // a weekly habit in two routines: left in both until its turn today, done in both at the week's target
  const weekly = { ...run, id: 'k', routines: [RID, evening.id] };
  const w = (logs) => [morning, evening].map((r) => [ids(routineLeft(r, [weekly], rs, logs, day)), routineProgress(r, [weekly], rs, logs, day).done]);
  assert.deepEqual(w({}), [[['k'], 0], [['k'], 0]]);
  assert.deepEqual(w(logsOf([[day, 'k', 1]])), [[[], 0], [[], 0]]); // had its turn today, not done yet
  assert.deepEqual(w(logsOf([['2026-11-10', 'k', 2], [day, 'k', 1]])), [[[], 1], [[], 1]]);
  // archived and deleted habits are not counted; deleted, missing and junk routines give nothing
  const extra = [...habits, { ...pills, id: 'a', archived: true }, { ...pills, id: 'd', deletedAt: 2 }];
  assert.deepEqual(routineProgress(morning, extra, rs, {}, day), { done: 0, total: 2 });
  assert.deepEqual(routineProgress({ ...morning, deletedAt: 1 }, habits, rs, {}, day), { done: 0, total: 0 });
  assert.deepEqual(routineProgress(night, habits, all3, {}, day), { done: 0, total: 0 });
  assert.deepEqual(routineProgress(morning, habits, [evening], {}, day), { done: 0, total: 0 });
  for (const junk of [undefined, null, 'x', {}]) {
    assert.deepEqual(routineProgress(junk, habits, rs, {}, day), { done: 0, total: 0 });
    assert.deepEqual(routineProgress(morning, junk, junk, junk, day), { done: 0, total: 0 });
  }
  // the top line still counts each habit once
  assert.deepEqual(summary(habits, logsOf([[day, 's', 1]]), day), { done: 0, total: 4 });
  assert.deepEqual(summary(habits, logsOf([[day, 's', 2]]), day), { done: 1, total: 4 });
});

test('dueRoutines and dueHabits with a shared habit: each routine reminds for its own share (v1.4)', () => {
  const day = '2026-11-13';
  const habits = [pills, shared, { ...water, order: 9, routines: [evening.id], times: [] }];
  const due = (logs, times) => dueRoutines([evening, morning], habits, logs, day, times).map((d) => [d.routine.name, ids(d.left)]);
  assert.deepEqual(due({}, ['07:00', '21:00']), [['Morning', ['p', 's']], ['Evening', ['s', 'w']]]);
  // brushed once in the morning: the Evening reminder still asks for it, Morning has only the pills left
  const once = logsOf([[day, 's', 1]]);
  assert.deepEqual(due(once, ['07:00', '21:00']), [['Morning', ['p']], ['Evening', ['s', 'w']]]);
  assert.deepEqual(routineReminderText(evening, dueRoutines([evening], habits, once, day, '21:00')[0].left),
    { title: 'Evening', body: '2 left: Brush teeth, Water' });
  assert.deepEqual(due(logsOf([[day, 's', 2], [day, 'p', 1], [day, 'w', 3]]), ['07:00', '21:00']), []);
  // a habit in any live routine sends no reminder of its own; with all of its routines deleted it is loose
  const timed = { ...water, id: 'x', routines: [evening.id, RID] }; // times and routines (the rules refuse it)
  assert.deepEqual(dueHabits([timed], {}, day, '09:00', [{ ...morning, deletedAt: 1 }, evening]), []);
  assert.deepEqual(ids(dueHabits([timed], {}, day, '09:00', [{ ...morning, deletedAt: 1 }])), ['x']);
  // the same routine reminder for old data (field `routine`)
  const old = { ...pills, routines: undefined, routine: RID };
  assert.deepEqual(ids(dueRoutines([morning], [old], {}, day, '07:00')[0].left), ['p']);
});

test('moveHabitIds: a move inside one section, with every live id for reorderHabits (v1.4)', () => {
  // orders: Water 1 (loose), Pills 2 (Morning), Teeth 3 (Morning and Evening), Floss 4 (Evening), Gym 5 (loose)
  const hs = [{ ...water, order: 1 }, { ...pills, order: 2 }, { ...shared, order: 3 }, { ...pills, id: 'f', name: 'Floss', order: 4, routines: [evening.id] },
    { ...gym, order: 5 }, { ...pills, id: 'd', order: 6, deletedAt: 1 }];
  const rs = [morning, evening];
  const view = (list) => groupHabits(list.map((id) => ({ ...hs.find((h) => h.id === id), order: list.indexOf(id) })), rs)
    .map((g) => [g.routine?.name ?? null, ids(g.habits)]);
  assert.deepEqual(view(['w', 'p', 's', 'f', 'g']), [['Morning', ['p', 's']], ['Evening', ['s', 'f']], [null, ['w', 'g']]]);
  // Floss up in Evening: Teeth and Floss swap there; Morning is unchanged
  let moved = moveHabitIds(hs, rs, evening.id, 'f', -1);
  assert.deepEqual(moved, ['w', 'p', 'f', 's', 'g']);
  assert.deepEqual(view(moved), [['Morning', ['p', 's']], ['Evening', ['f', 's']], [null, ['w', 'g']]]);
  // Teeth up in Morning: only Teeth moves, so it also goes before Floss in Evening (one order per habit, accepted)
  moved = moveHabitIds(hs, rs, RID, 's', -1);
  assert.deepEqual(view(moved), [['Morning', ['s', 'p']], ['Evening', ['s', 'f']], [null, ['w', 'g']]]);
  // a loose habit jumps over the routine habits between it and its neighbour; nothing else changes place
  moved = moveHabitIds(hs, rs, null, 'w', 1);
  assert.deepEqual(moved, ['p', 's', 'f', 'g', 'w']);
  assert.deepEqual(moveHabitIds(hs, rs, '', 'g', -1), ['g', 'w', 'p', 's', 'f']);
  // first, last, not in that section, bad delta, junk: null
  assert.equal(moveHabitIds(hs, rs, RID, 'p', -1), null);
  assert.equal(moveHabitIds(hs, rs, evening.id, 'f', 1), null);
  assert.equal(moveHabitIds(hs, rs, evening.id, 'p', 1), null);
  assert.equal(moveHabitIds(hs, rs, RID, 'd', 1), null);
  for (const delta of [0, 2, '1', undefined]) assert.equal(moveHabitIds(hs, rs, RID, 'p', delta), null);
  for (const junk of [undefined, null, 'x', {}]) assert.equal(moveHabitIds(junk, junk, RID, 'p', 1), null);
});

test('routineReminderText: how many are left and which, never longer than 120 characters', () => {
  assert.equal(REMINDER_BODY_MAX, 120);
  assert.deepEqual(routineReminderText(morning, [pills, teeth]), { title: 'Morning', body: '2 left: Take pills, Brush teeth' });
  assert.deepEqual(routineReminderText(morning, [teeth]), { title: 'Morning', body: '1 left: Brush teeth' });
  // the 120-character cut: whole names only, ending with ", ..."
  const named = (n, len) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, name: `${i}`.padEnd(len, 'x') }));
  const five = routineReminderText(morning, named(5, 30)); // '5 left: ' + 5 * 30 + 4 * 2 = 166
  assert.equal(five.body, `5 left: ${named(3, 30).map((h) => h.name).join(', ')}, ...`);
  assert.equal(five.body.length, 8 + 3 * 30 + 2 * 2 + 5);
  assert.ok(five.body.length <= 120);
  // exactly 120 is not cut; one more character is
  const fits = [{ name: 'a'.repeat(55) }, { name: 'b'.repeat(55) }]; // 8 + 55 + 2 + 55 = 120
  assert.equal(routineReminderText(morning, fits).body.length, 120);
  assert.equal(routineReminderText(morning, fits).body.endsWith('...'), false);
  assert.equal(routineReminderText(morning, [fits[0], { name: 'b'.repeat(56) }]).body, `2 left: ${'a'.repeat(55)}, ...`);
  // the worst valid case (50 habits with 60-character names) and every count in between
  for (let n = 1; n <= 50; n++) {
    const { body } = routineReminderText(morning, named(n, 60));
    assert.ok(body.length <= 120, `${n}: ${body.length}`);
    assert.ok(body.startsWith(`${n} left: 0xxx`), body);
    assert.equal(body.endsWith(', ...'), n > 1, String(n));
  }
  // junk: a name longer than any valid one is cut hard; nothing left; missing routine
  const long = routineReminderText(morning, [{ name: 'y'.repeat(300) }]);
  assert.deepEqual([long.body.length, long.body.slice(0, 10), long.body.slice(-4)], [120, '1 left: yy', 'y...']);
  assert.deepEqual(routineReminderText(morning, []), { title: 'Morning', body: 'All done.' });
  assert.deepEqual(routineReminderText(null, [null, { name: 5 }, {}]), { title: '', body: '2 left: 5, ' });
  for (const junk of [undefined, null, 'x', {}]) assert.deepEqual(routineReminderText(junk, junk), { title: '', body: 'All done.' });
});
