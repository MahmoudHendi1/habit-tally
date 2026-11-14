// The Firebase store: the Store contract (docs/contracts.md section 5) on Firebase Auth and Cloud Firestore.
// Loaded only through the dynamic import() in src/store.js, so demo mode never downloads it or the Firebase SDK.
//
// Optimistic changes and Firestore snapshots
// ------------------------------------------
// A change must show before the call returns, but Firestore reports even its own local writes a moment
// later, one snapshot per write. A screen that simply showed the newest snapshot would, after three quick
// taps, show 3 (optimistic), then 1, 2, 3 as the snapshots catch up. So the state is never a snapshot. It is
//
//     view = base + ops
//
// `ops`  : this store's own changes that the server has not answered yet, in the order they were made.
// `base` : what Firestore last told us, plus every op the server has since confirmed.
//
// - A change is pushed onto `ops`, shown, and sent. Nothing is awaited.
// - When the server confirms it, the op moves from `ops` into `base`: the view does not change.
// - When the server refuses it, the op is dropped and `lastError` is set; the view is then Firestore's.
// - Habit and account snapshots replace `base`. They may already contain some of our unanswered ops, but
//   those are plain assignments, so laying `ops` over them again gives the same result.
// - Count snapshots are different: +1 laid over a snapshot that already holds that +1 would count twice,
//   and a snapshot does not say which of our taps it holds. So while an op of ours is waiting in a month,
//   that month's snapshots are not used at all: the server's confirmations move the ops into `base` one by
//   one, and the first snapshot after the last confirmation brings in whatever other devices did meanwhile.
//   That snapshot often differs from the one before only in "pending" having become "confirmed", which is
//   why the logs are watched with includeMetadataChanges.
//
// Consequences: a count never moves except by a tap here, a refusal, or a change from elsewhere. While taps
// made here are waiting in a month (a fraction of a second online; offline, until back online), taps from
// other devices or other tabs for that month wait too. The SDK settles a write's promise before it
// delivers the snapshot holding the confirmation, so nothing is ever counted twice; were a snapshot made
// before a tap delivered only after that tap's confirmation (timers frozen in a hidden tab), the count
// would dip until the next snapshot, which is already queued behind it.
import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth, getAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut as authSignOut,
} from 'firebase/auth';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  memoryLruGarbageCollector, connectFirestoreEmulator, collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, increment,
} from 'firebase/firestore';
import { LIMITS, keyOf, monthId, countOn, recentDays, cleanHabit, validateHabit, sortHabits } from '../shared/logic.js';
import { firebaseConfig, emulatorConfig } from './firebase-config.js';
import { StoreError } from './store.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // the form the rules accept; installation ids are 22 such characters
const ZONE_MAX = 64, UA_MAX = 500; // limits in firestore.rules
const SHARED = ['user', 'habits', 'logs', 'lastError'];
const inBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';

const AUTH_ERRORS = {
  'auth/invalid-email': ['invalid-email', 'Enter a valid email address.'],
  'auth/missing-email': ['invalid-email', 'Enter a valid email address.'],
  // With email-enumeration protection Firebase answers an unknown email and a wrong password alike; without
  // it (older projects, the emulator by default) the two differ. The person is told the same either way.
  'auth/invalid-credential': ['wrong-credentials', 'Wrong email or password.'],
  'auth/invalid-login-credentials': ['wrong-credentials', 'Wrong email or password.'],
  'auth/wrong-password': ['wrong-credentials', 'Wrong email or password.'],
  'auth/user-not-found': ['wrong-credentials', 'Wrong email or password.'],
  'auth/missing-password': ['wrong-credentials', 'Wrong email or password.'],
  'auth/email-already-in-use': ['email-in-use', 'There is already an account with this email. Sign in instead.'],
  'auth/weak-password': ['weak-password', 'Use a password of at least 6 characters.'],
  'auth/too-many-requests': ['too-many-requests', 'Too many attempts. Wait a few minutes and try again.'],
  'auth/network-request-failed': ['offline', 'You seem to be offline. Check the connection and try again.'],
};
const authError = (err) => (err instanceof StoreError ? err
  : new StoreError(...(AUTH_ERRORS[err?.code] ?? ['unknown', 'Something went wrong. Try again in a moment.'])));

/** Why the account's data is not there yet; shown as `lastError` until it is. */
const NOT_SET_UP = { code: 'not-saved', message: 'Your account could not be set up. Try again in a moment.' };

const notSaved = (err) => ({
  code: 'not-saved',
  message: err?.code === 'permission-denied'
    ? 'This change was not saved: this account is not allowed to make it.'
    : 'This change could not be saved. Try again in a moment.',
});

function deviceZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isZone(zone) {
  try {
    return typeof zone === 'string' && zone !== '' && zone.length <= ZONE_MAX && Boolean(new Intl.DateTimeFormat('en', { timeZone: zone }));
  } catch {
    return false;
  }
}

const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Deep equality of plain data, used to keep unchanged parts of the state and to skip empty updates. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keys = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && keys.length === Object.keys(b).length
    && keys.every((k) => k in b && same(a[k], b[k]));
}

/** The days of one month document: { day: { habitId: count } }. The rules cannot look inside `days`, so
 *  anything that is not a number is left out here. A count below 0 is read as 0: two devices that each
 *  undo the same tap leave -1 on the server, because increments are added up there, not compared. */
function readDays(data) {
  const days = Object.entries(isObject(data?.days) ? data.days : {}).filter(([, counts]) => isObject(counts));
  const numbers = (counts) => Object.entries(counts).filter(([, n]) => Number.isFinite(n)).map(([id, n]) => [id, Math.max(0, n)]);
  return Object.fromEntries(days.map(([day, counts]) => [day, Object.fromEntries(numbers(counts))]));
}

/** One change laid over { tz, habits: { id: habit }, logs }. Returns new data; nothing is mutated.
 *  An op is { habit: id, patch, create? } or { month, day, id, delta } or { tz }. */
function applyOp(data, op) {
  if (op.tz) return { ...data, tz: op.tz };
  if (op.patch) {
    const old = data.habits[op.habit];
    if (!old && !op.create) return data;
    return { ...data, habits: { ...data.habits, [op.habit]: { id: op.habit, ...old, ...op.patch } } };
  }
  const days = data.logs[op.month] ?? {};
  const count = (days[op.day]?.[op.id] ?? 0) + op.delta;
  return { ...data, logs: { ...data.logs, [op.month]: { ...days, [op.day]: { ...days[op.day], [op.id]: count } } } };
}

/** Auth and Firestore for one app. Browsers get the offline cache shared between tabs (IndexedDB); if
 *  that cannot be set up (private mode, an old browser) and in Node, data is cached in memory only. */
function connect(emulator, appName) {
  const config = emulator ? emulatorConfig.firebase : firebaseConfig;
  const app = getApps().find((a) => a.name === (appName ?? '[DEFAULT]')) ?? initializeApp(config, appName);
  let auth, db;
  try {
    auth = initializeAuth(app, inBrowser ? { persistence: [indexedDBLocalPersistence, browserLocalPersistence] } : undefined);
  } catch {
    auth = getAuth(app); // already set up on this app (for example after a hot reload)
  }
  // Like the browser cache, the memory cache keeps documents that no listener is watching any more.
  const inMemory = () => memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() });
  try {
    const localCache = inBrowser ? persistentLocalCache({ tabManager: persistentMultipleTabManager() }) : inMemory();
    db = initializeFirestore(app, { localCache });
  } catch {
    try {
      db = initializeFirestore(app, { localCache: inMemory() });
    } catch {
      db = getFirestore(app); // already set up on this app
    }
  }
  if (emulator) {
    connectAuthEmulator(auth, emulatorConfig.authUrl, { disableWarnings: true });
    connectFirestoreEmulator(db, emulatorConfig.firestoreHost, emulatorConfig.firestorePort);
  }
  return { auth, db };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.emulator] talk to the local emulators (project demo-habit-tally) instead of the real project
 * @param {() => Date} [options.now] the clock (default: the device's)
 * @param {string} [options.tz] IANA zone given to a new user record (default: the device's)
 * @param {string} [options.appName] name of the Firebase app to use; tests give each store its own
 */
export function createFirebaseStore({ emulator = false, now = () => new Date(), tz = deviceZone(), appName } = {}) {
  const mode = emulator ? 'emulator' : 'firebase';
  const { auth, db } = connect(emulator, appName);
  const today = () => keyOf(now());
  const listeners = new Set();
  /** The signed-in account and everything that belongs to it; replaced, never reused, when the account
   *  changes, is refused or signs out, so late answers for an old session are easy to ignore.
   *  `denied`: the rules refused it; it shows as waiting until a retry() gets all the way to ready.
   *  `creating`: the user record is being written ('sending') or was refused ('refused').
   *  `trouble`: why the data is not loading, if something is wrong; it is the state's `lastError` meanwhile. */
  let session = null;
  let authKnown = false;
  let lastError = null;
  let sent = 0, sentAtError = 0; // counts writes, so only a write made after a refusal clears lastError
  let state = view();

  const newSession = (uid, email, denied = false) => ({
    uid, email, denied, stops: [], live: false, creating: false, trouble: null,
    has: { user: false, habits: false, logs: false }, base: { tz, habits: {}, logs: {} }, ops: [],
  });
  const current = () => session.ops.reduce(applyOp, session.base);

  function view() {
    const blank = { mode, user: null, habits: [], logs: {}, lastError: session?.trouble ?? lastError };
    if (!session) return { status: authKnown ? 'signedOut' : 'loading', ...blank };
    const { uid, email, has } = session;
    if (!has.user || !has.habits || !has.logs) {
      return session.denied ? { status: 'waiting', ...blank, user: { uid, email, tz } } : { status: 'loading', ...blank };
    }
    const data = current();
    return { status: 'ready', ...blank, user: { uid, email, tz: data.tz }, habits: sortHabits(Object.values(data.habits)), logs: data.logs };
  }

  /** Work the state out again and tell the listeners if it changed (always, after a change made here). */
  function refresh(force = false) {
    const next = view();
    let changed = force || next.status !== state.status;
    for (const key of SHARED) {
      if (same(next[key], state[key])) next[key] = state[key];
      else changed = true;
    }
    if (!changed) return;
    state = next;
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (err) {
        console.error(err); // one broken listener must not stop the others or undo the change
      }
    }
  }

  // ---------- account and live data ----------

  function stop() {
    if (!session) return;
    for (const off of session.stops) off();
    session.stops = [];
    session.live = false;
  }

  /** Auth reported who is signed in (or nobody). */
  function adopt(user) {
    authKnown = true;
    if (!user || session?.uid !== user.uid) {
      stop();
      lastError = null;
      session = user ? newSession(user.uid, user.email ?? '') : null;
      if (session) watch(session);
    }
    refresh();
  }

  /** Read the account record and keep listening to it. A refusal means the account is not invited. */
  function watch(s) {
    const userRef = doc(db, 'users', s.uid);
    const failed = (err) => {
      if (session !== s) return;
      if (err?.code !== 'permission-denied') return console.error(err);
      stop();
      session = newSession(s.uid, s.email, true);
      refresh();
    };
    s.stops.push(onSnapshot(userRef, { includeMetadataChanges: true }, (snap) => {
      if (session !== s) return;
      if (!snap.exists()) {
        s.has.user = false;
        // Allowed, and the server (not just an empty cache) says there is no record yet: create it.
        if (!snap.metadata.fromCache && !s.creating) createRecord(s, userRef);
        return refresh();
      }
      // The record this store is creating counts once the rules have accepted it, not before.
      if (s.creating === 'sending' && snap.metadata.hasPendingWrites) return;
      s.trouble = null;
      const zone = snap.data().tz;
      s.base = { ...s.base, tz: isZone(zone) ? zone : tz };
      s.has.user = true;
      if (!s.live) {
        s.live = true;
        watchData(s, userRef, failed);
      }
      refresh();
    }, failed));
  }

  /** Write the user record of an allowed account. A refusal (the rules do not accept the record, a time
   *  zone for example) would be repeated at once if it were tried again by itself: `creating` stays set
   *  until retry(). */
  function createRecord(s, userRef) {
    s.creating = 'sending';
    const at = now().getTime();
    setDoc(userRef, { tz, createdAt: at, updatedAt: at }).then(() => {
      s.creating = false;
    }, (err) => {
      console.error(err);
      s.creating = 'refused';
      s.trouble = NOT_SET_UP;
      if (session === s) refresh();
    });
  }

  function watchData(s, userRef, failed) {
    s.stops.push(onSnapshot(collection(userRef, 'habits'), (snap) => {
      if (session !== s) return;
      s.base = { ...s.base, habits: Object.fromEntries(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])) };
      s.has.habits = true;
      refresh();
    }, failed));
    s.stops.push(onSnapshot(collection(userRef, 'logs'), { includeMetadataChanges: true }, (snap) => {
      if (session !== s) return;
      // See the top of this file: a month in which a tap of ours is still waiting keeps what `base` has.
      const months = snap.docs.map((d) => [d.id, s.ops.some((op) => op.month === d.id) ? s.base.logs[d.id] : readDays(d.data())]);
      s.base = { ...s.base, logs: Object.fromEntries(months.filter(([, days]) => days)) };
      s.has.logs = true;
      refresh();
    }, failed));
  }

  // ---------- changes ----------

  /** An optimistic change: show it now, send it, and settle it when the server answers.
   *  @param {object} op see applyOp  @param {() => Promise<void>} send starts the Firestore write */
  function change(op, send) {
    const s = session, mine = ++sent;
    let answer;
    try {
      answer = send();
    } catch (err) {
      answer = Promise.reject(err);
    }
    s.ops = [...s.ops, op];
    answer.then(() => {
      if (session !== s) return;
      s.base = applyOp(s.base, op);
      s.ops = s.ops.filter((o) => o !== op);
      if (mine > sentAtError) lastError = null;
      refresh();
    }, (err) => {
      if (session !== s) return;
      s.ops = s.ops.filter((o) => o !== op);
      lastError = notSaved(err);
      sentAtError = sent;
      refresh();
    });
    refresh(true);
  }

  const habitRef = (id) => doc(db, 'users', session.uid, 'habits', id);
  const tooMany = () => new StoreError('too-many', `You can have at most ${LIMITS.habitsMax} habits. Delete one to add another.`);

  function saveHabit(input) {
    if (state.status !== 'ready') throw new StoreError('not-ready', 'Sign in to change habits.');
    const fields = cleanHabit(input);
    const problems = validateHabit(fields);
    if (problems.length > 0) throw new StoreError('invalid', problems[0], problems);
    const all = current().habits; // deleted ones included
    const updatedAt = now().getTime();
    if (input.id) {
      if (!all[input.id]) throw new StoreError('not-found', 'This habit no longer exists.');
      const patch = { ...fields, updatedAt };
      change({ habit: input.id, patch }, () => updateDoc(habitRef(input.id), patch));
      return input.id;
    }
    if (state.habits.length >= LIMITS.habitsMax) throw tooMany();
    // Deleted habits count too, so a restored habit never shares its place with a newer one.
    const order = Math.max(0, ...Object.values(all).map((h) => h.order)) + 1;
    const ref = doc(collection(db, 'users', session.uid, 'habits')); // a new 20-character id
    const habit = { ...fields, created: today(), archived: false, deletedAt: null, order, updatedAt };
    change({ habit: ref.id, patch: habit, create: true }, () => setDoc(ref, habit));
    return ref.id;
  }

  /** Soft delete (a time) or restore (null). Unknown ids and repeats are ignored. */
  function setDeleted(id, deletedAt) {
    if (state.status !== 'ready') return;
    const habit = current().habits[id];
    if (!habit || (habit.deletedAt === null) === (deletedAt === null)) return;
    if (deletedAt === null && state.habits.length >= LIMITS.habitsMax) throw tooMany();
    const patch = { deletedAt, updatedAt: now().getTime() };
    change({ habit: id, patch }, () => updateDoc(habitRef(id), patch));
  }

  function addCount(dayKey, habitId, delta) {
    const habit = state.habits.find((h) => h.id === habitId); // empty unless ready; deleted habits are not in it
    if (!habit || (delta !== 1 && delta !== -1) || !recentDays(today()).includes(dayKey)) return;
    if (countOn(state.logs, habitId, dayKey) + delta < 0) return;
    const month = monthId(dayKey);
    change({ month, day: dayKey, id: habitId, delta }, () => setDoc(doc(db, 'users', session.uid, 'logs', month),
      { days: { [dayKey]: { [habitId]: increment(delta) } } }, { merge: true }));
  }

  function setTimeZone(zone) {
    if (state.status !== 'ready' || !isZone(zone) || zone === state.user.tz) return;
    change({ tz: zone }, () => updateDoc(doc(db, 'users', session.uid), { tz: zone, updatedAt: now().getTime() }));
  }

  // ---------- signing in and out ----------

  function checkedEmail(email) {
    const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(address)) throw new StoreError('invalid-email', 'Enter a valid email address.');
    return address;
  }

  /** Resolves once the status is no longer 'loading'. Rejects when loading has run into trouble instead:
   *  the session stays, and becomes ready by itself (or after retry()) once the trouble is over. */
  const settled = () => new Promise((resolve, reject) => {
    const check = () => {
      if (state.status === 'loading' && !state.lastError) return;
      listeners.delete(check);
      if (state.status !== 'loading') return resolve();
      const { code, message } = state.lastError;
      reject(new StoreError(code === 'offline' ? 'offline' : 'unknown', message));
    };
    listeners.add(check);
    check();
  });

  /** Sign in or sign up, then wait until the account turns out to be ready or waiting.
   *  A password under 6 characters cannot exist in Firebase, so it is answered without asking. */
  async function enter(call, email, password, shortCode, shortMessage) {
    const address = checkedEmail(email);
    if (typeof password !== 'string' || password.length < 6) throw new StoreError(shortCode, shortMessage);
    let user;
    try {
      ({ user } = await call(auth, address, password));
    } catch (err) {
      throw authError(err);
    }
    adopt(user);
    await settled();
  }

  async function resetPassword(email) {
    const address = checkedEmail(email);
    try {
      await sendPasswordResetEmail(auth, address);
    } catch (err) {
      if (err?.code !== 'auth/user-not-found') throw authError(err); // never tell whether the account exists
    }
  }

  async function saveDevice(fid) {
    const uid = auth.currentUser?.uid;
    if (!uid) throw new StoreError('not-ready', 'Sign in to turn on reminders.');
    if (typeof fid !== 'string' || !DEVICE_ID_RE.test(fid)) throw new StoreError('invalid', 'This device cannot be registered for reminders.');
    const ua = String(globalThis.navigator?.userAgent ?? '').slice(0, UA_MAX);
    try {
      await setDoc(doc(db, 'devices', fid), { uid, ua, updatedAt: now().getTime() });
    } catch (err) {
      throw new StoreError('not-saved', 'Reminders could not be turned on for this device. Try again in a moment.');
    }
  }

  /** Resolves when the record is gone, was never there, or now belongs to someone else (the rules answer
   *  all of those with a refusal). */
  async function removeDevice(fid) {
    if (!auth.currentUser || typeof fid !== 'string' || !DEVICE_ID_RE.test(fid)) return;
    try {
      await deleteDoc(doc(db, 'devices', fid));
    } catch (err) {
      if (err?.code !== 'permission-denied') throw new StoreError('not-saved', 'This device could not be removed. Try again in a moment.');
    }
  }

  onAuthStateChanged(auth, adopt, (err) => console.error(err));

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => void listeners.delete(fn);
    },
    signUp: (email, password) => enter(createUserWithEmailAndPassword, email, password, 'weak-password', 'Use a password of at least 6 characters.'),
    signIn: (email, password) => enter(signInWithEmailAndPassword, email, password, 'wrong-credentials', 'Wrong email or password.'),
    resetPassword,
    /** Listeners are detached first: Firestore would otherwise report the sign-out as a refusal. */
    async signOut() {
      adopt(null);
      await authSignOut(auth);
    },
    /** Listen again: for an account that was refused, or whose user record was. */
    retry() {
      const s = session;
      if (!s) return;
      const refused = s.creating === 'refused';
      if (!refused && s.stops.length > 0) return; // listening, and nothing was refused
      if (refused) s.creating = false;
      stop();
      watch(s);
    },
    saveHabit,
    deleteHabit: (id) => setDeleted(id, now().getTime()),
    restoreHabit: (id) => setDeleted(id, null),
    addCount,
    setTimeZone,
    saveDevice,
    removeDevice,
  };
}
