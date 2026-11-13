// @ts-check
// The demo store: the Store contract (docs/contracts.md section 5) kept in browser storage under one key.
// No network and no real accounts: there is one data set per browser, whatever email is typed.
import { LIMITS, keyOf, monthId, countOn, recentDays, cleanHabit, validateHabit, sortHabits } from '../shared/logic.js';
import { StoreError } from './store.js';
import { sampleData } from './sample-data.js';

/** @typedef {{ id: string, name: string, period: 'day' | 'week', target: number, unit: string, times: string[],
 *     created: string, archived: boolean, deletedAt: null | number, order: number, updatedAt: number }} Habit */
/** @typedef {Record<string, Record<string, Record<string, number>>>} Logs month, then day, then habit id */
/** @typedef {{ uid: string, email: string, tz: string }} User */
/** @typedef {{ status: 'loading' | 'signedOut' | 'waiting' | 'ready', mode: string, user: null | User,
 *     habits: Habit[], logs: Logs, lastError: null | { code: string, message: string } }} State */
/** @typedef {{ signedIn: boolean, user: User, habits: Habit[], logs: Logs }} Saved
 *  What is kept in storage. Unlike State, `habits` includes the deleted ones, so Undo survives a reload. */
/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} KeyValue */

export const STORAGE_KEY = 'habit-tally:v1';
const DEMO_USER = { uid: 'demo', email: 'demo@habit-tally.example' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
/** @param {any} logs */
const isLogs = (logs) => isObject(logs) && Object.values(logs).every((days) => isObject(days)
  && Object.values(days).every((counts) => isObject(counts) && Object.values(counts).every(Number.isFinite)));
/** @param {any} x */
const isSaved = (x) => isObject(x) && x.v === 1 && typeof x.signedIn === 'boolean'
  && isObject(x.user) && isText(x.user.uid) && isText(x.user.email) && isText(x.user.tz)
  && Array.isArray(x.habits) && x.habits.every(isHabit) && isLogs(x.logs);

/** The saved data, or null when there is none or any part of it is damaged. Never throws.
 *  @param {KeyValue} storage @returns {Saved | null} */
function readSaved(storage) {
  try {
    const found = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!isSaved(found)) return null;
    return { signedIn: found.signedIn, user: found.user, habits: found.habits, logs: found.logs };
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
  let saved = found ?? { signedIn: true, user: { ...DEMO_USER, tz }, habits: [], logs: {} };
  /** @type {State['lastError']} */
  let lastError = null;
  let state = view();
  /** @type {Set<(state: State) => void>} */
  const listeners = new Set();
  if (!found && sample) commit({ ...saved, ...sampleData(today()) });

  /** @returns {State} */
  function view() {
    return saved.signedIn
      ? { status: 'ready', mode: 'demo', user: saved.user, habits: sortHabits(saved.habits), logs: saved.logs, lastError }
      : { status: 'signedOut', mode: 'demo', user: null, habits: [], logs: {}, lastError };
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

  /** @param {string} id @param {Partial<Habit>} patch */
  const patchHabit = (id, patch) => saved.habits.map((h) => (h.id === id ? { ...h, ...patch, updatedAt: now().getTime() } : h));

  /** @param {any} input @returns {string} */
  function saveHabit(input) {
    if (!saved.signedIn) throw new StoreError('not-ready', 'Sign in to change habits.');
    const fields = /** @type {Pick<Habit, 'name' | 'period' | 'target' | 'unit' | 'times'>} */ (cleanHabit(input));
    const problems = validateHabit(fields);
    if (problems.length > 0) throw new StoreError('invalid', problems[0], problems);
    if (input.id) {
      if (!saved.habits.some((h) => h.id === input.id)) throw new StoreError('not-found', 'This habit no longer exists.');
      commit({ ...saved, habits: patchHabit(input.id, fields) });
      return input.id;
    }
    if (state.habits.length >= LIMITS.habitsMax) {
      throw new StoreError('too-many', `You can have at most ${LIMITS.habitsMax} habits. Delete one to add another.`);
    }
    // Deleted habits count too, so a restored habit never shares its place with a newer one.
    const order = Math.max(0, ...saved.habits.map((h) => h.order)) + 1;
    /** @type {Habit} */
    const habit = { id: newId(), ...fields, created: today(), archived: false, deletedAt: null, order, updatedAt: now().getTime() };
    commit({ ...saved, habits: [...saved.habits, habit] });
    return habit.id;
  }

  /** Soft delete (a time) or restore (null). Unknown ids and repeats are ignored.
   *  @param {string} id @param {number | null} deletedAt */
  function setDeleted(id, deletedAt) {
    const habit = saved.habits.find((h) => h.id === id);
    if (!saved.signedIn || !habit || (habit.deletedAt === null) === (deletedAt === null)) return;
    commit({ ...saved, habits: patchHabit(id, { deletedAt }) });
  }

  /** @param {string} dayKey @param {string} habitId @param {number} delta */
  function addCount(dayKey, habitId, delta) {
    const habit = state.habits.find((h) => h.id === habitId); // empty when signed out; deleted habits are not in it
    if (!habit || (delta !== 1 && delta !== -1) || !recentDays(today()).includes(dayKey)) return;
    const count = countOn(saved.logs, habitId, dayKey) + delta;
    if (count < 0) return;
    const days = saved.logs[monthId(dayKey)] ?? {};
    const logs = { ...saved.logs, [monthId(dayKey)]: { ...days, [dayKey]: { ...days[dayKey], [habitId]: count } } };
    const habits = dayKey < habit.created ? patchHabit(habitId, { created: dayKey }) : saved.habits;
    commit({ ...saved, habits, logs });
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
    /** @param {string} id */
    deleteHabit: (id) => setDeleted(id, now().getTime()),
    /** @param {string} id */
    restoreHabit: (id) => setDeleted(id, null),
    addCount,
    setTimeZone,
    /** @param {string} _fid */
    saveDevice: async (_fid) => {},
    /** @param {string} _fid */
    removeDevice: async (_fid) => {},
  };
}
