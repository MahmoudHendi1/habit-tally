// Pure habit logic shared by the app and the reminder job. No DOM, no Firebase.
//
// Data shapes
//   habit: { id, name, period: 'day' | 'week', target, unit, times: ['09:00'], created: 'YYYY-MM-DD',
//            archived, deletedAt, order, updatedAt, routine: '' | routineId }   (full contract: docs/contracts.md)
//   routine: { id, name, times: ['07:00'], order, deletedAt, updatedAt }   a named, ordered list of habits done
//            together. A habit is "in" a routine only while that routine exists and is not deleted; otherwise
//            it is loose, like a habit with routine ''.
//   logs:  { 'YYYY-MM': { 'YYYY-MM-DD': { [habitId]: count } } }

export const SLOT_MINUTES = 30;
export const SLOT_MS = SLOT_MINUTES * 60 * 1000;

/** Limits shared by the editor, both stores and (where expressible) the security rules. */
export const LIMITS = Object.freeze({
  nameMax: 60, unitMax: 20, targetMin: 1, targetMax: 50, timesMax: 48, habitsMax: 50, backDays: 7,
  routineNameMax: 40, routinesMax: 20,
});

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
  const n = Number(logs?.[monthId(k)]?.[k]?.[habitId]);
  return n > 0 && Number.isFinite(n) ? n : 0;
}

/** The first day that counts for a habit: its start date, or the earliest day with a logged count if
 *  that is earlier (a back-filled day). Derived, never stored, so undoing a mistaken tap on an old
 *  day leaves no trace. */
export function startDay(h, logs) {
  let first = h.created;
  for (const m in logs || {}) {
    if (m > monthId(first)) continue;
    for (const k in logs[m] || {}) if (k < first && countOn(logs, h.id, k) > 0) first = k;
  }
  return first;
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
  const first = norm(startDay(h, logs));
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
  for (let k = norm(startDay(h, logs)); k <= cur; k = addDays(k, step)) {
    periods++;
    if (isHit(h, logs, k)) {
      hitPeriods++;
      run++;
      if (run > best) best = run;
    } else if (k !== cur) run = 0;
  }
  let total = 0;
  for (const m in logs) for (const k in logs[m]) total += countOn(logs, h.id, k);
  return { total, periods, hitPeriods, best, streak: streak(h, logs, today) };
}

/** "N of M habits done" for the Today screen on day k. */
export function summary(habits, logs, k) {
  const live = habits.filter((h) => !h.archived && !h.deletedAt);
  return { done: live.filter((h) => isHit(h, logs, k)).length, total: live.length };
}

/** The days that can be logged: today first, then the previous `back` days (R6). */
export function recentDays(today, back = LIMITS.backDays) {
  return Array.from({ length: back + 1 }, (_, i) => addDays(today, -i));
}

/** Calendar for the Progress screen: `weeks` Monday-first columns, the last one being this week.
 *  Each day: { key, count, level, future, before }.
 *    level 0 = nothing logged, 1 = some, 2 = at least half the daily target, 3 = target hit.
 *    For weekly habits a logged day is level 2, or 3 when that week's target was hit.
 *    future = after today (level 0); before = before the habit's first day, see startDay().
 *  Each week: { start, hit, days[7] }. */
export function calendarWeeks(h, logs, today, weeks = 15) {
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  const began = startDay(h, logs);
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, 7 * w);
    const hit = isWeekly(h) ? isHit(h, logs, start) : false;
    const days = weekKeys(start).map((key) => {
      const future = key > today, before = key < began;
      const count = future ? 0 : countOn(logs, h.id, key);
      let level = 0;
      if (count > 0) {
        if (isWeekly(h)) level = hit ? 3 : 2;
        else level = count >= h.target ? 3 : count * 2 >= h.target ? 2 : 1;
      }
      return { key, count, level, future, before };
    });
    out.push({ start, hit: isWeekly(h) ? hit : days.every((d) => d.future || d.level === 3), days });
  }
  return out;
}

// ---------- habits: cleaning and validation ----------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):(00|30)$/;
const ID_RE = /^[A-Za-z0-9]{20}$/;

const cleanName = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const objects = (list) => (Array.isArray(list) ? list : []).filter((x) => x && typeof x === 'object');
const finite = (n) => (Number.isFinite(n) ? n : 0);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order: the same on every device

function timesProblems(times) {
  if (!Array.isArray(times) || times.some((t) => !TIME_RE.test(t))) return ['Reminder times must be on the hour or half hour.'];
  if (times.length > LIMITS.timesMax) return [`At most ${LIMITS.timesMax} reminder times.`];
  if (new Set(times).size !== times.length) return ['A reminder time is listed twice.'];
  return [];
}

/** Tidy what the editor collected: trims text, whole-number target, snapped unique sorted times.
 *  `routine` is '' or a routine id; a habit in a routine has no reminder times of its own, so they are emptied.
 *  Returns only the fields a person edits; ids, dates and order are set by the store. */
export function cleanHabit(input) {
  const routine = typeof input?.routine === 'string' ? input.routine.trim() : '';
  return {
    name: cleanName(input?.name),
    period: input?.period === 'week' ? 'week' : 'day',
    target: Math.round(Number(input?.target)),
    unit: String(input?.unit ?? '').trim(),
    times: routine ? [] : cleanTimes(input?.times),
    routine,
  };
}

/** Problems with a habit, as short sentences for the editor. Empty list = valid. Run on cleanHabit output.
 *  A missing `routine` counts as ''. */
export function validateHabit(h) {
  const out = [];
  if (!h || typeof h !== 'object') return ['Habit is missing.'];
  if (typeof h.name !== 'string' || h.name.length === 0) out.push('Give the habit a name.');
  else if (h.name.length > LIMITS.nameMax) out.push(`Keep the name to ${LIMITS.nameMax} characters.`);
  if (h.period !== 'day' && h.period !== 'week') out.push('Choose per day or per week.');
  if (!Number.isInteger(h.target) || h.target < LIMITS.targetMin || h.target > LIMITS.targetMax) {
    out.push(`Target must be a whole number from ${LIMITS.targetMin} to ${LIMITS.targetMax}.`);
  }
  if (typeof h.unit !== 'string' || h.unit.length > LIMITS.unitMax) out.push(`Keep the unit to ${LIMITS.unitMax} characters.`);
  out.push(...timesProblems(h.times));
  const routine = h.routine ?? ''; // a habit stored before routines existed has no such field
  if (routine !== '' && !(typeof routine === 'string' && ID_RE.test(routine))) out.push('Choose a routine from the list.');
  else if (routine !== '' && Array.isArray(h.times) && h.times.length > 0) out.push('A habit in a routine takes its reminder times from the routine.');
  if ('created' in h && !DAY_RE.test(h.created || '')) out.push('Start date is not a valid day.');
  return out;
}

/** Display order: by `order`, then by id so ties are stable. Deleted habits are left out. */
export function sortHabits(habits) {
  return habits.filter((h) => !h.deletedAt)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
}

// ---------- routines ----------

/** Tidy what the routine editor collected. Returns only the fields a person edits. */
export function cleanRoutine(input) {
  return { name: cleanName(input?.name), times: cleanTimes(input?.times) };
}

/** Problems with a routine, as short sentences for the editor. Empty list = valid. Run on cleanRoutine output. */
export function validateRoutine(r) {
  if (!r || typeof r !== 'object') return ['Routine is missing.'];
  const out = [];
  if (typeof r.name !== 'string' || r.name.trim().length === 0) out.push('Give the routine a name.');
  else if (r.name.length > LIMITS.routineNameMax) out.push(`Keep the name to ${LIMITS.routineNameMax} characters.`);
  out.push(...timesProblems(r.times));
  return out;
}

/** Display order: by `order`, then by name, then by id. Deleted routines are left out. */
export function sortRoutines(routines) {
  return objects(routines).filter((r) => !r.deletedAt)
    .sort((a, b) => finite(a.order) - finite(b.order) || byText(String(a.name ?? ''), String(b.name ?? ''))
      || byText(String(a.id), String(b.id)));
}

/** The live routine a habit belongs to, or null when the habit is loose: `routine` is '' or missing, or it
 *  names a routine that does not exist or is deleted. The one test of membership for the app and the job. */
export function routineOf(habit, routines) {
  const id = habit?.routine;
  if (typeof id !== 'string' || id === '') return null;
  return objects(routines).find((r) => r.id === id && !r.deletedAt) ?? null;
}

/** The sections of Today and Progress: one { routine, habits } per live routine in sortRoutines order (also
 *  when it has no habits), then { routine: null, habits } with the loose habits. The last entry is present
 *  when there are loose habits or no live routine at all. Habits inside an entry are in sortHabits order. */
export function groupHabits(habits, routines) {
  const live = sortRoutines(routines);
  const sorted = sortHabits(objects(habits));
  const out = live.map((routine) => ({ routine, habits: sorted.filter((h) => routineOf(h, live) === routine) }));
  const loose = sorted.filter((h) => !routineOf(h, live));
  if (loose.length || !live.length) out.push({ routine: null, habits: loose });
  return out;
}

// ---------- reminder times ----------

/** Snap 'HH:MM' to the half-hour step the reminder job runs on. */
export function snapTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof t === 'string' ? t : '');
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  let total = Math.round((+m[1] * 60 + +m[2]) / SLOT_MINUTES) * SLOT_MINUTES;
  if (total >= 24 * 60) total = 24 * 60 - SLOT_MINUTES;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
export function cleanTimes(times) {
  return [...new Set((Array.isArray(times) ? times : []).map(snapTime).filter(Boolean))].sort();
}
/** 'Every N hours between start and end', as a sorted list of times. An end before the start
 *  runs past midnight: everyHours('22:00', '06:00', 4) -> ['02:00', '06:00', '22:00']. */
export function everyHours(start, end, hours) {
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const a = snapTime(start), b = snapTime(end);
  if (!a || !b || !(hours > 0)) return [];
  const s = toMin(a);
  let e = toMin(b);
  if (e < s) e += 24 * 60;
  const step = Math.max(SLOT_MINUTES, Math.round((hours * 60) / SLOT_MINUTES) * SLOT_MINUTES);
  const out = [];
  for (let m = s; m <= e; m += step) out.push(`${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`);
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

const minutesOf = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

/** Plan one run of the reminder job.
 *  lastSlot: newest slot already claimed (ms since epoch), or null/0 when the job has never run.
 *  The job is scheduled a few minutes before each half hour, so `lookahead` lets an on-time run
 *  take that half hour's slot.
 *  Returns null when the slot is already claimed, else { slot, from }: send the reminders whose
 *  time falls in (from, slot]. `from` is the previous slot, or one slot earlier when a run was
 *  missed. Nothing older than two slots is ever sent; the first ever run covers one slot. */
export function planRun(lastSlot, now, lookahead = 5 * 60 * 1000) {
  const slot = Math.floor((now + lookahead) / SLOT_MS) * SLOT_MS;
  if (!(lastSlot > 0)) lastSlot = 0; // junk in the bookmark counts as "never run"
  if (lastSlot && lastSlot >= slot) return null;
  const from = lastSlot ? Math.max(lastSlot, slot - 2 * SLOT_MS) : slot - SLOT_MS;
  return { slot, from };
}

/** The local day and the half-hour reminder times that fall in the window (from, slot] in zone tz.
 *  Matching a window instead of one exact time makes zones with 45-minute offsets work and sends
 *  times skipped by a spring-forward change at the next slot. When the clocks go back the local
 *  window is empty or negative for one slot, so at most one time a year is sent twice. */
export function dueTimes(from, slot, tz) {
  const end = localParts(slot, tz);
  const m0 = minutesOf(localParts(from, tz).time), m1 = minutesOf(end.time);
  const width = (m1 - m0 + 1440) % 1440;
  const times = [];
  if (width > 0 && width <= 720) {
    for (let t = 0; t < 1440; t += SLOT_MINUTES) {
      const d = (t - m0 + 1440) % 1440;
      if (d > 0 && d <= width) times.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    }
  }
  return { day: end.day, times };
}

/** Everything a run must consider for one user: dueTimes for each half hour in (from, slot], merged
 *  by local day, oldest first. Usually one entry with one time. A catch-up window that crosses the
 *  user's midnight gives two entries, so "target already hit" is judged on the right day for each. */
export function dueWindows(from, slot, tz) {
  const out = [];
  for (let s = from + SLOT_MS; s <= slot; s += SLOT_MS) {
    const { day, times } = dueTimes(s - SLOT_MS, s, tz);
    if (!times.length) continue;
    const last = out.at(-1);
    if (last && last.day === day) last.times = [...new Set([...last.times, ...times])].sort();
    else out.push({ day, times });
  }
  return out;
}

/** Whether a live habit still has something to do on `day`: the one test behind habit and routine reminders. */
function stillToDo(h, logs, day) {
  if (h.archived || h.deletedAt) return false;
  if (isHit(h, logs, day)) return false;
  // A weekly habit already logged today has had its turn for the day.
  if (isWeekly(h) && countOn(logs, h.id, day) > 0) return false;
  return true;
}
const hasTime = (x, want) => Array.isArray(x.times) && x.times.some((t) => want.has(t));

/** Habits that should send a reminder of their own for local day `day`; `times` is one 'HH:MM' or a list
 *  (dueTimes). Habits in a live routine are left out (the routine reminds for them, see dueRoutines), so a
 *  caller that has routines must pass them; without `routines` every habit counts as loose. */
export function dueHabits(habits, logs, day, times, routines) {
  const want = new Set([].concat(times || []));
  const live = sortRoutines(routines);
  return habits.filter((h) => !routineOf(h, live) && hasTime(h, want) && stillToDo(h, logs, day));
}

/** The habits of a live routine that still have something to do on `day`, in routine (sortHabits) order:
 *  not archived or deleted, target not hit in the habit's own period (the day, or the Monday-to-Sunday week),
 *  and for a weekly habit nothing logged on `day` yet. [] for a deleted or missing routine. */
export function routineLeft(routine, habits, logs, day) {
  if (!routine || typeof routine !== 'object' || routine.deletedAt) return [];
  return sortHabits(objects(habits).filter((h) => routineOf(h, [routine]))).filter((h) => stillToDo(h, logs, day));
}

/** Routines that should send a reminder for local day `day`: live, with one of `times` ('HH:MM' or a list)
 *  among their reminder times and at least one habit left. Returns [{ routine, left }] in sortRoutines order. */
export function dueRoutines(routines, habits, logs, day, times) {
  const want = new Set([].concat(times || []));
  return sortRoutines(routines).filter((r) => hasTime(r, want))
    .map((routine) => ({ routine, left: routineLeft(routine, habits, logs, day) }))
    .filter((d) => d.left.length > 0);
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

export const REMINDER_BODY_MAX = 120;

/** Text of a routine's reminder; `left` is routineLeft(). Body: "2 left: Take pills, Brush teeth". The body is
 *  never longer than REMINDER_BODY_MAX: names that do not fit are dropped whole and the list ends with ", ...". */
export function routineReminderText(routine, left) {
  const title = String(routine?.name ?? '');
  const names = objects(left).map((h) => String(h.name ?? ''));
  if (!names.length) return { title, body: 'All done.' };
  const head = `${names.length} left: `;
  let body = head + names.join(', ');
  if (body.length > REMINDER_BODY_MAX) {
    let kept = names.length - 1;
    const cut = () => `${head}${names.slice(0, kept).join(', ')}, ...`;
    while (kept > 0 && cut().length > REMINDER_BODY_MAX) kept--;
    body = kept > 0 ? cut() : `${(head + names[0]).slice(0, REMINDER_BODY_MAX - 3)}...`;
  }
  return { title, body };
}
