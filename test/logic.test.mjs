import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, weekStart, weekKeys, countOn, periodCount, isHit, streak, stats,
  snapTime, cleanTimes, everyHours, localParts, slotsToProcess, dueHabits, reminderText, SLOT_MS,
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

test('slotsToProcess: on time, late, repeated and after an outage', () => {
  const nine = Date.UTC(2026, 10, 13, 9, 0);
  const min = 60 * 1000;
  // scheduled at 08:56, runs on time: handles the 09:00 slot
  assert.deepEqual(slotsToProcess(nine - SLOT_MS, nine - 4 * min), [nine]);
  // runs 12 minutes late: still the 09:00 slot
  assert.deepEqual(slotsToProcess(nine - SLOT_MS, nine + 12 * min), [nine]);
  // a second run in the same half hour sends nothing
  assert.deepEqual(slotsToProcess(nine, nine + 15 * min), []);
  // one run was skipped: catches up the missed slot too
  assert.deepEqual(slotsToProcess(nine - 2 * SLOT_MS, nine + 2 * min), [nine - SLOT_MS, nine]);
  // first ever run, or a long outage: only the last 90 minutes
  assert.deepEqual(slotsToProcess(0, nine), [nine - 3 * SLOT_MS, nine - 2 * SLOT_MS, nine - SLOT_MS, nine]);
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
});

test('reminderText', () => {
  assert.deepEqual(reminderText({ ...water, unit: 'glasses' }, {}, '2026-11-13'), { title: 'Water', body: 'Not started today. Target: 3 glasses.' });
  assert.deepEqual(reminderText(gym, logsOf([['2026-11-10', 'g', 1]]), '2026-11-13'), { title: 'Gym', body: '1 of 3 done this week.' });
});
