import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, weekStart, weekKeys, countOn, periodCount, isHit, streak, stats,
  snapTime, cleanTimes, everyHours, localParts, planRun, dueTimes, dueHabits, reminderText, SLOT_MS,
  LIMITS, summary, recentDays, calendarWeeks, cleanHabit, validateHabit, sortHabits,
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
  // a day before the habit's start date is flagged but still shows what was logged
  const sunday = cal.at(-3).days.at(6);
  assert.deepEqual(sunday, { key: '2026-11-01', count: 9, level: 3, future: false, before: true });
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
  assert.deepEqual(clean, { name: 'Drink water', period: 'day', target: 8, unit: 'glasses', times: ['09:00', '15:00'] });
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
