// Pure habit logic shared by the app and the reminder job. No DOM, no Firebase.
//
// Data shapes
//   habit: { id, name, period: 'day' | 'week', target, unit, times: ['09:00'], created: 'YYYY-MM-DD', archived }
//   logs:  { 'YYYY-MM': { 'YYYY-MM-DD': { [habitId]: count } } }

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;

export const pad = (n) => String(n).padStart(2, '0');
export const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (k, n) => {
  const d = parseKey(k);
  d.setDate(d.getDate() + n);
  return keyOf(d);
};
export const monthId = (k) => k.slice(0, 7);

/** Monday of the week that contains day k. */
export const weekStart = (k) => {
  const dow = (parseKey(k).getDay() + 6) % 7; // Mon = 0
  return addDays(k, -dow);
};
export const weekKeys = (k) => {
  const s = weekStart(k);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i));
};

export const isWeekly = (h) => h.period === 'week';

/** Taps logged for one habit on one day. Never negative. */
export function countOn(logs, habitId, k) {
  const n = logs?.[monthId(k)]?.[k]?.[habitId] || 0;
  return n > 0 ? n : 0;
}

/** Progress in the habit's own period (the day, or the Monday-to-Sunday week) that contains k. */
export function periodCount(h, logs, k) {
  if (!isWeekly(h)) return countOn(logs, h.id, k);
  return weekKeys(k).reduce((sum, d) => sum + countOn(logs, h.id, d), 0);
}
export const isHit = (h, logs, k) => periodCount(h, logs, k) >= h.target;

/** Current streak, in days for daily habits and weeks for weekly ones.
 *  The period still in progress does not break a streak; it only extends it once hit. */
export function streak(h, logs, today) {
  const step = isWeekly(h) ? 7 : 1;
  const norm = (k) => (isWeekly(h) ? weekStart(k) : k);
  const first = norm(h.created);
  let k = norm(today);
  if (!isHit(h, logs, k)) k = addDays(k, -step);
  let n = 0;
  while (k >= first && isHit(h, logs, k)) {
    n++;
    k = addDays(k, -step);
  }
  return n;
}

export function stats(h, logs, today) {
  const step = isWeekly(h) ? 7 : 1;
  const norm = (k) => (isWeekly(h) ? weekStart(k) : k);
  const cur = norm(today);
  let periods = 0, hitPeriods = 0, best = 0, run = 0;
  for (let k = norm(h.created); k <= cur; k = addDays(k, step)) {
    periods++;
    if (isHit(h, logs, k)) {
      hitPeriods++;
      run++;
      if (run > best) best = run;
    } else if (k !== cur) run = 0;
  }
  let total = 0;
  for (const m in logs) for (const k in logs[m]) total += Math.max(0, logs[m][k]?.[h.id] || 0);
  return { total, periods, hitPeriods, best, streak: streak(h, logs, today) };
}

// ---------- reminder times ----------

/** Snap 'HH:MM' to the half-hour step the reminder job runs on. */
export function snapTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return null;
  let total = Math.round((+m[1] * 60 + +m[2]) / SLOT_MINUTES) * SLOT_MINUTES;
  if (total >= 24 * 60) total = 24 * 60 - SLOT_MINUTES;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
export function cleanTimes(times) {
  return [...new Set((times || []).map(snapTime).filter(Boolean))].sort();
}
/** 'Every N hours between start and end', as a list of times. */
export function everyHours(start, end, hours) {
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const s = toMin(snapTime(start)), e = toMin(snapTime(end));
  const step = Math.max(SLOT_MINUTES, Math.round(hours * 60));
  const out = [];
  for (let m = s; m <= e; m += step) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return cleanTimes(out);
}

/** Local calendar day and half-hour slot of an instant in an IANA time zone. */
export function localParts(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms));
  } catch {
    return localParts(ms, 'UTC');
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Which half-hour slots a run of the job should handle.
 *  lastSlot is the newest slot already handled (ms since epoch, or 0). The job is scheduled a few
 *  minutes before each slot, so `lookahead` lets an on-time run send that slot's reminders, and
 *  `maxBack` stops a long outage from replaying a day of reminders. */
export function slotsToProcess(lastSlot, now, lookahead = 5 * 60 * 1000, maxBack = 90 * 60 * 1000) {
  const latest = Math.floor((now + lookahead) / SLOT_MS) * SLOT_MS;
  let first = Math.max((lastSlot || 0) + SLOT_MS, latest - Math.floor(maxBack / SLOT_MS) * SLOT_MS);
  const out = [];
  for (let s = first; s <= latest; s += SLOT_MS) out.push(s);
  return out;
}

/** Habits that should send a reminder for local day `day` at slot `time`. */
export function dueHabits(habits, logs, day, time) {
  return habits.filter((h) => {
    if (h.archived || !(h.times || []).includes(time)) return false;
    if (isHit(h, logs, day)) return false;
    // A weekly habit already logged today has had its turn for the day.
    if (isWeekly(h) && countOn(logs, h.id, day) > 0) return false;
    return true;
  });
}

export function reminderText(h, logs, day) {
  const done = periodCount(h, logs, day);
  const unit = h.unit ? ` ${h.unit}` : '';
  const span = isWeekly(h) ? 'this week' : 'today';
  return {
    title: h.name,
    body: done === 0 ? `Not started ${span}. Target: ${h.target}${unit}.` : `${done} of ${h.target}${unit} done ${span}.`,
  };
}
