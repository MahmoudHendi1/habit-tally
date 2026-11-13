// @ts-check
// Sample data for the demo (?demo=sample) and for tests: 16 weeks of one daily and one weekly habit.
// Nothing is random: the same `today` always gives the same data. The numbers the Progress screen should
// show for one fixed day are written down in test/fixtures/sample-16-weeks.json.
import { addDays, weekStart, monthId } from '../shared/logic.js';

export const SAMPLE_WEEKS = 16;

// One row per week, oldest first; one digit per day, Monday first. The last row is the week in progress,
// of which only the days before today are used.
const GLASSES = [ // target: 6 a day
  '6340600', '6602630', '6666200', '0366640', '6666660', '6666666', '6676663', '0000000',
  '2466060', '6665600', '6666616', '7666650', '6636668', '6066666', '4666666', '6666666',
];
const RUNS = [ // target: 3 a week
  '1000100', '1010100', '0100110', '1000000', '1010010', '1011010', '0101001', '0000000',
  '0010010', '1010100', '1010001', '0100100', '1010100', '1011000', '0110010', '1010100',
];
// Today is still in progress, so the Today screen has something left to tap: some water, no run yet.
const GLASSES_TODAY = 2;

/**
 * Habits and logs for the 16 Monday-to-Sunday weeks that end with the week containing `today`.
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ habits: import('./store-local.js').Habit[], logs: import('./store-local.js').Logs }}
 */
export function sampleData(today) {
  const start = addDays(weekStart(today), -7 * (SAMPLE_WEEKS - 1));
  // Not from the local clock, so the data is the same in every time zone.
  const rest = { created: start, archived: false, deletedAt: null, updatedAt: Date.parse(`${start}T00:00:00Z`) };
  /** @type {import('./store-local.js').Habit} */
  const water = { id: 'sampleWaterHabit0001', name: 'Drink water', period: 'day', target: 6, unit: 'glasses',
    times: ['09:00', '13:00', '17:00'], ...rest, order: 1 };
  /** @type {import('./store-local.js').Habit} */
  const run = { id: 'sampleRunHabit000001', name: 'Go for a run', period: 'week', target: 3, unit: 'runs',
    times: ['18:00'], ...rest, order: 2 };

  /** @type {import('./store-local.js').Logs} */
  const logs = {};
  for (let i = 0, day = start; day <= today; i++, day = addDays(start, i)) {
    const week = Math.floor(i / 7), weekday = i % 7;
    /** @type {[string, number][]} */
    const counts = day === today
      ? [[water.id, GLASSES_TODAY]]
      : [[water.id, Number(GLASSES[week][weekday])], [run.id, Number(RUNS[week][weekday])]];
    for (const [id, count] of counts) {
      if (count > 0) ((logs[monthId(day)] ??= {})[day] ??= {})[id] = count;
    }
  }
  return { habits: [water, run], logs };
}
