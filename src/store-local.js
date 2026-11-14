// @ts-check
// The demo store: the Store contract (docs/contracts.md section 5) kept in browser storage under one key.
// No network and no real accounts: there is one data set per browser, whatever email is typed.
import { LIMITS, keyOf, monthId, countOn, recentDays, cleanHabit, validateHabit, sortHabits,
  cleanRoutine, validateRoutine, sortRoutines } from '../shared/logic.js';
import { StoreError } from './store.js';
import { sampleData } from './sample-data.js';

/** @typedef {{ id: string, name: string, period: 'day' | 'week', target: number, unit: string, times: string[],
 *     created: string, archived: boolean, deletedAt: null | number, order: number, updatedAt: number,
 *     routine: string }} Habit */
/** @typedef {{ id: string, name: string, times: string[], order: number, deletedAt: null | number,
 *     updatedAt: number }} Routine */
/** @typedef {Record<string, Record<string, Record<string, number>>>} Logs month, then day, then habit id */
/** @typedef {{ uid: string, email: string, tz: string }} User */
/** @typedef {{ status: 'loading' | 'signedOut' | 'waiting' | 'ready', mode: string, user: null | User,
 *     habits: Habit[], routines: Routine[], logs: Logs, lastError: null | { code: string, message: string } }} State */
/** @typedef {{ signedIn: boolean, user: User, habits: Habit[], routines: Routine[], logs: Logs }} Saved
 *  What is kept in storage. Unlike State, `habits` and `routines` include the deleted ones, so Undo
 *  survives a reload. */
/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} KeyValue */

export const STORAGE_KEY = 'habit-tally:v1';
const DEMO_USER = { uid: 'demo', email: 'demo@habit-tally.example' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Ids read back from storage become object keys in the logs, so only plain ones are let in, and none
// that every object already has ('constructor', 'toString').
const isSafeId = (/** @type {unknown} */ id) => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id) && !(id in Object.prototype);
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 20 random characters of [A-Za-z0-9], the same form as the ids of the real backend. */
function newId() {
  let id = '';
  while (id.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      // 248 = 4 x 62: skipping the bytes above it keeps every character equally likely.
      if (byte < 248 && id.length < 20) id += ID_CHARS[byte % 62];
    }
  }
  return id;
}

/** The browser's localStorage, or, where there is none or it is blocked, one that lasts as long as the page.
 *  @returns {KeyValue} */
function defaultStorage() {
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch { /* blocked: fall through */ }
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}

function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** @param {unknown} zone */
function isZone(zone) {
  try {
    return typeof zone === 'string' && zone !== '' && Boolean(new Intl.DateTimeFormat('en', { timeZone: zone }));
  } catch {
    return false;
  }
}

/** @param {any} x */
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (/** @type {unknown} */ x) => typeof x === 'string' && x !== '';
/** @param {any} h */
const isHabit = (h) => isObject(h) && isText(h.id) && isText(h.created) && validateHabit(h).length === 0
  && typeof h.archived === 'boolean' && (h.deletedAt === null || Number.isFinite(h.deletedAt))
  && Number.isFinite(h.order) && Number.isFinite(h.updatedAt);
/** @param {any} r */
const isRoutine = (r) => isObject(r) && isText(r.id) && validateRoutine(r).length === 0
  && (r.deletedAt === null || Number.isFinite(r.deletedAt)) && Number.isFinite(r.order) && Number.isFinite(r.updatedAt);
/** @param {any} logs */
const isLogs = (logs) => isObject(logs) && Object.values(logs).every((days) => isObject(days)
  && Object.values(days).every((counts) => isObject(counts) && Object.values(counts).every(Number.isFinite)));
/** @param {any} x */
const isSaved = (x) => isObject(x) && x.v === 1 && typeof x.signedIn === 'boolean'
  && isObject(x.user) && isText(x.user.uid) && isText(x.user.email) && isText(x.user.tz)
  && Array.isArray(x.habits) && x.habits.every(isHabit) && isLogs(x.logs)
  && (x.routines === undefined || (Array.isArray(x.routines) && x.routines.every(isRoutine)));

/** The saved data, or null when there is none or any part of it is damaged. Habits and routines with an
 *  unsafe id are left out. Data saved before routines existed has no `routines` and its habits no `routine`:
 *  it is read as no routines and loose habits. Never throws.
 *  @param {KeyValue} storage @returns {Saved | null} */
function readSaved(storage) {
  try {
    const found = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!isSaved(found)) return null;
    const habits = found.habits.filter((/** @type {Habit} */ h) => isSafeId(h.id))
      .map((/** @type {Habit} */ h) => (typeof h.routine === 'string' ? h : { ...h, routine: '' }));
    const routines = (found.routines ?? []).filter((/** @type {Routine} */ r) => isSafeId(r.id));
    return { signedIn: found.signedIn, user: found.user, habits, routines, logs: found.logs };
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {KeyValue} [options.storage] where the data is kept (default: localStorage)
 * @param {() => Date} [options.now] the clock (default: the device's)
 * @param {string} [options.tz] IANA zone given to a new user record (default: the device's)
 * @param {boolean} [options.sample] load the 16-week sample when nothing is saved yet
 */
export function createLocalStore({ storage = defaultStorage(), now = () => new Date(), tz = deviceZone(), sample = false } = {}) {
  const today = () => keyOf(now());
  const found = readSaved(storage);
  /** @type {Saved} */
  let saved = found ?? { signedIn: true, user: { ...DEMO_USER, tz }, habits: [], routines: [], logs: {} };
  /** @type {State['lastError']} */
  let lastError = null;
  let state = view();
  /** @type {Set<(state: State) => void>} */
  const listeners = new Set();
  if (!found && sample) commit({ ...saved, ...sampleData(today()) });

  /** @returns {State} */
  function view() {
    return saved.signedIn
      ? { status: 'ready', mode: 'demo', user: saved.user, habits: sortHabits(saved.habits),
          routines: sortRoutines(saved.routines), logs: saved.logs, lastError }
      : { status: 'signedOut', mode: 'demo', user: null, habits: [], routines: [], logs: {}, lastError };
  }

  /** Every change goes through here: replace the data, keep it in storage, tell the listeners.
   *  @param {Saved} next */
  function commit(next) {
    saved = next;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...saved }));
      lastError = null;
    } catch {
      lastError = { code: 'not-saved', message: 'This browser could not save the change. It will be gone after a reload.' };
    }
    state = view();
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (err) {
        console.error(err); // one broken listener must not stop the others or undo the change
      }
    }
  }

  /** A copy of a list of habits or routines in which the record `id` has the patch and a new `updatedAt`.
   *  @template {{ id: string }} T @param {T[]} list @param {string} id @param {Partial<T>} patch @returns {T[]} */
  const patched = (list, id, patch) => list.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: now().getTime() } : x));
  /** @param {string} id @param {Partial<Habit>} patch */
  const patchHabit = (id, patch) => patched(saved.habits, id, patch);
  /** @param {string} id @param {Partial<Routine>} patch */
  const patchRoutine = (id, patch) => patched(saved.routines, id, patch);
  /** The place of a new habit or routine. Deleted ones count too, so a restored one never shares its place
   *  with a newer one. A loop and not Math.max(...orders): a very long list would overflow the call stack.
   *  @param {{ order: number }[]} list */
  const nextOrder = (list) => list.reduce((highest, x) => Math.max(highest, x.order), 0) + 1;

  function requireRoom() {
    if (state.habits.length < LIMITS.habitsMax) return;
    throw new StoreError('too-many', `You can have at most ${LIMITS.habitsMax} habits. Delete one to add another.`);
  }

  function requireRoutineRoom() {
    if (state.routines.length < LIMITS.routinesMax) return;
    throw new StoreError('too-many', `You can have at most ${LIMITS.routinesMax} routines. Delete one to add another.`);
  }

  /** @param {any} input @returns {string} */
  function saveHabit(input) {
    if (!saved.signedIn) throw new StoreError('not-ready', 'Sign in to change habits.');
    // Only a live routine can be joined. Any other value (none, unknown, deleted) leaves the habit loose,
    // and it must be dropped before cleaning, because cleanHabit empties the times of a habit with a routine.
    const routine = state.routines.some((r) => r.id === input?.routine) ? input.routine : '';
    const fields = /** @type {Pick<Habit, 'name' | 'period' | 'target' | 'unit' | 'times' | 'routine'>} */ (
      cleanHabit({ ...input, routine }));
    const problems = validateHabit(fields);
    if (problems.length > 0) throw new StoreError('invalid', problems[0], problems);
    if (input.id) {
      if (!saved.habits.some((h) => h.id === input.id)) throw new StoreError('not-found', 'This habit no longer exists.');
      commit({ ...saved, habits: patchHabit(input.id, fields) });
      return input.id;
    }
    requireRoom();
    /** @type {Habit} */
    const habit = { id: newId(), ...fields, created: today(), archived: false, deletedAt: null,
      order: nextOrder(saved.habits), updatedAt: now().getTime() };
    commit({ ...saved, habits: [...saved.habits, habit] });
    return habit.id;
  }

  /** Soft delete. Unknown and already deleted ids are ignored.
   *  @param {string} id */
  function deleteHabit(id) {
    if (!state.habits.some((h) => h.id === id)) return; // empty when signed out; deleted habits are not in it
    commit({ ...saved, habits: patchHabit(id, { deletedAt: now().getTime() }) });
  }

  /** Undo a delete. Unknown ids and habits that are not deleted are ignored.
   *  @param {string} id */
  function restoreHabit(id) {
    if (!saved.signedIn || !saved.habits.some((h) => h.id === id && h.deletedAt)) return;
    requireRoom();
    commit({ ...saved, habits: patchHabit(id, { deletedAt: null }) });
  }

  /** @param {any} input `{ name, times }`, with `id` to edit @returns {string} */
  function saveRoutine(input) {
    if (!saved.signedIn) throw new StoreError('not-ready', 'Sign in to change routines.');
    const fields = cleanRoutine(input);
    const problems = validateRoutine(fields);
    if (problems.length > 0) throw new StoreError('invalid', problems[0], problems);
    if (input.id) {
      if (!saved.routines.some((r) => r.id === input.id)) throw new StoreError('not-found', 'This routine no longer exists.');
      commit({ ...saved, routines: patchRoutine(input.id, fields) });
      return input.id;
    }
    requireRoutineRoom();
    /** @type {Routine} */
    const routine = { id: newId(), ...fields, order: nextOrder(saved.routines), deletedAt: null, updatedAt: now().getTime() };
    commit({ ...saved, routines: [...saved.routines, routine] });
    return routine.id;
  }

  /** Soft delete. Its habits are not touched: they keep naming it, are loose meanwhile (routineOf in
   *  shared/logic.js) and are its members again after a restore. Unknown and already deleted ids are ignored.
   *  @param {string} id */
  function deleteRoutine(id) {
    if (!state.routines.some((r) => r.id === id)) return; // empty when signed out; deleted routines are not in it
    commit({ ...saved, routines: patchRoutine(id, { deletedAt: now().getTime() }) });
  }

  /** Undo a delete. Unknown ids and routines that are not deleted are ignored.
   *  @param {string} id */
  function restoreRoutine(id) {
    if (!saved.signedIn || !saved.routines.some((r) => r.id === id && r.deletedAt)) return;
    requireRoutineRoom();
    commit({ ...saved, routines: patchRoutine(id, { deletedAt: null }) });
  }

  /** The list with the live records named in `ids` numbered 1, 2, 3... in that sequence, or null when that
   *  changes nothing. Ids that name no live record, and an id's second mention, are dropped; records not
   *  named keep their order; only a record whose order changes is written (new `updatedAt`).
   *  @template {{ id: string, order: number, updatedAt: number }} T
   *  @param {T[]} all every stored record @param {T[]} live the ones in the state @param {unknown} ids
   *  @returns {T[] | null} */
  function reordered(all, live, ids) {
    if (!Array.isArray(ids)) return null;
    const liveIds = new Set(live.map((x) => x.id));
    /** @type {Map<string, number>} */
    const place = new Map();
    for (const id of ids) if (liveIds.has(id) && !place.has(id)) place.set(id, place.size + 1);
    const moved = (/** @type {T} */ x) => place.has(x.id) && place.get(x.id) !== x.order;
    if (!all.some(moved)) return null;
    const updatedAt = now().getTime();
    return all.map((x) => (moved(x) ? { ...x, order: /** @type {number} */ (place.get(x.id)), updatedAt } : x));
  }

  /** One change of state and one call to the listeners, however many habits move.
   *  @param {string[]} ids */
  function reorderHabits(ids) {
    const habits = reordered(saved.habits, state.habits, ids); // state.habits is empty when signed out
    if (habits) commit({ ...saved, habits });
  }

  /** @param {string[]} ids */
  function reorderRoutines(ids) {
    const routines = reordered(saved.routines, state.routines, ids);
    if (routines) commit({ ...saved, routines });
  }

  /** Never touches the habit: a count before its start date is found by startDay() in shared/logic.js.
   *  @param {string} dayKey @param {string} habitId @param {number} delta */
  function addCount(dayKey, habitId, delta) {
    const known = state.habits.some((h) => h.id === habitId);
    if (!known || (delta !== 1 && delta !== -1) || !recentDays(today()).includes(dayKey)) return;
    const count = countOn(saved.logs, habitId, dayKey) + delta;
    if (count < 0) return;
    const days = saved.logs[monthId(dayKey)] ?? {};
    const logs = { ...saved.logs, [monthId(dayKey)]: { ...days, [dayKey]: { ...days[dayKey], [habitId]: count } } };
    commit({ ...saved, logs });
  }

  /** @param {string} zone */
  function setTimeZone(zone) {
    if (!saved.signedIn || !isZone(zone) || zone === saved.user.tz) return;
    commit({ ...saved, user: { ...saved.user, tz: zone } });
  }

  /** @param {unknown} email @returns {string} */
  function checkedEmail(email) {
    const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(address)) throw new StoreError('invalid-email', 'Enter a valid email address.');
    return address;
  }

  /** Sign-in and sign-up are the same here; only the complaint about a short password differs.
   *  @param {unknown} email @param {unknown} password @param {string} shortCode @param {string} shortMessage */
  function enter(email, password, shortCode, shortMessage) {
    const address = checkedEmail(email);
    if (typeof password !== 'string' || password.length < 6) throw new StoreError(shortCode, shortMessage);
    commit({ ...saved, signedIn: true, user: { ...saved.user, email: address } });
  }

  return {
    getState: () => state,
    /** @param {(state: State) => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => void listeners.delete(fn);
    },
    /** @param {string} email @param {string} password */
    signUp: async (email, password) => enter(email, password, 'weak-password', 'Use a password of at least 6 characters.'),
    /** @param {string} email @param {string} password */
    signIn: async (email, password) => enter(email, password, 'wrong-credentials', 'Wrong email or password.'),
    /** @param {string} email */
    resetPassword: async (email) => void checkedEmail(email),
    async signOut() {
      if (saved.signedIn) commit({ ...saved, signedIn: false });
    },
    retry() {},
    saveHabit,
    deleteHabit,
    restoreHabit,
    saveRoutine,
    deleteRoutine,
    restoreRoutine,
    reorderHabits,
    reorderRoutines,
    addCount,
    setTimeZone,
    /** @param {string} _fid */
    saveDevice: async (_fid) => {},
    /** @param {string} _fid */
    removeDevice: async (_fid) => {},
  };
}
