// The Firebase store against the Auth and Firestore emulators (work package B1). Run with `npm run test:emulator`.
// The real firestore.rules are loaded, with the invite list replaced by the ids of the test accounts.
// "check N" in a test name is acceptance check N for B1 in docs/plan.md.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteApp, getApp } from 'firebase/app';
import { FetchProvider } from '@firebase/auth/internal';
import {
  collection, disableNetwork, doc, enableNetwork, getDoc, getDocs, getFirestore, setLogLevel, updateDoc, waitForPendingWrites,
} from 'firebase/firestore';
import { createFirebaseStore } from '../../src/store-firebase.js';
import { emulatorConfig } from '../../src/firebase-config.js';
import { StoreError } from '../../src/store.js';
import { countOn } from '../../shared/logic.js';
import { runStoreContract } from '../store-contract.mjs';

setLogLevel('error'); // refused writes are expected here; do not print a warning for each one

const PROJECT = emulatorConfig.firebase.projectId;
const FIRESTORE = `http://${emulatorConfig.firestoreHost}:${emulatorConfig.firestorePort}`;
const AUTH = emulatorConfig.authUrl;
assert.ok(PROJECT.startsWith('demo-') && FIRESTORE.includes('//127.0.0.1:') && AUTH.includes('//127.0.0.1:'), 'emulators only');

// A Tuesday early in the month, so "7 days back" crosses a week and a month boundary (two log documents).
const TODAY = '2026-11-03';
const NOON = new Date(`${TODAY}T12:00:00`).getTime();
const WATER = { name: 'Water', period: 'day', target: 3, unit: 'glasses', times: ['09:00'] };
const HABIT_FIELDS = ['archived', 'created', 'deletedAt', 'name', 'order', 'period', 'target', 'times', 'unit', 'updatedAt'];
const SENTENCE = /^[A-Z][^/]*\.$/; // a plain sentence, not an error code like auth/wrong-password

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fails = (code) => (err) => err instanceof StoreError && err.code === code && SENTENCE.test(err.message);
const rejects = (promise, code) => assert.rejects(promise, fails(code), `rejects with "${code}"`);
const neverDown = (seen) => assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `counts seen, in order: ${seen}`);

async function call(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: body && JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- rules and accounts ----------

const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
const INVITE_LINE = /^.*\/\/ @invite-list$/m;
const loadRules = (content) => call('PUT', `${FIRESTORE}/emulator/v1/projects/${PROJECT}:securityRules`, { rules: { files: [{ name: 'firestore.rules', content }] } });
const invited = new Set();

/** Load firestore.rules with exactly the accounts in `invited` on the invite list. */
function loadInvited() {
  assert.match(RULES, INVITE_LINE);
  const ids = [...invited].map((uid) => `'${uid}'`).join(', ');
  return loadRules(RULES.replace(INVITE_LINE, `    function invited() { return [${ids}]; } // @invite-list`));
}
const invite = (uid) => (invited.add(uid), loadInvited());
const uninvite = (uid) => (invited.delete(uid), loadInvited());
/** Firebase's email-enumeration protection: on in the real project, off in the emulator unless asked for. */
const emailPrivacy = (on) => call('PATCH', `${AUTH}/emulator/v1/projects/${PROJECT}/config`, { emailPrivacyConfig: { enableImprovedEmailPrivacy: on } });
const deleteAccounts = () => call('DELETE', `${AUTH}/emulator/v1/projects/${PROJECT}/accounts`);

let accounts = 0;
/** A new account in the Auth emulator, on the invite list unless told otherwise. */
async function newAccount({ onList = true } = {}) {
  const email = `person${++accounts}@example.com`, password = `secret-${accounts}`;
  const { localId: uid } = await call('POST', `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { email, password, returnSecureToken: true });
  if (onList) await invite(uid);
  return { uid, email, password };
}

// ---------- stores ----------

let env, apps = 0;
const opened = [];

/** A store on its own Firebase app (so several can be signed in at once), with a clock the test can move. */
function open({ tz = 'Europe/London' } = {}) {
  const appName = `store-${++apps}`;
  let clock = NOON;
  const store = createFirebaseStore({ emulator: true, now: () => new Date(clock), tz, appName });
  const db = getFirestore(getApp(appName));
  opened.push({ appName, store });
  return {
    store, db,
    advance: (ms) => { clock += ms; },
    /** The server has answered every write so far, and the snapshots that follow have been delivered. */
    settle: async () => {
      await waitForPendingWrites(db);
      await sleep(40);
    },
  };
}

/** A store whose Firestore cannot be reached at all, while Auth can: a blocker, or a first visit with the
 *  connection gone. Nothing listens on port 1. */
function openUnreachable(options) {
  const port = emulatorConfig.firestorePort;
  emulatorConfig.firestorePort = 1;
  try {
    return open(options);
  } finally {
    emulatorConfig.firestorePort = port;
  }
}

/** `promise`, or a failure when it has not settled within 3 seconds. */
function soon(promise, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`not settled within 3 s: ${what}`)), 3000); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A store that is signed in and ready on a fresh, invited account. */
async function readyStore(options) {
  const account = await newAccount();
  const it = open(options);
  await it.store.signIn(account.email, account.password);
  assert.equal(it.store.getState().status, 'ready');
  return { ...it, ...account };
}

/** Resolves with the state as soon as it passes the test; fails after `ms` (2 seconds: checks 2 and 3). */
function until(store, passes, what, ms = 2000) {
  return new Promise((resolve, reject) => {
    let stop = () => {}, done = false;
    const finish = (settle, value) => {
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`not within ${ms} ms: ${what}`)), ms);
    stop = store.subscribe((state) => { if (!done && passes(state)) finish(resolve, state); });
  });
}

/** Past the rules: one stored document, or null when it does not exist. */
async function stored(path) {
  let snap;
  await env.withSecurityRulesDisabled(async (ctx) => { snap = await getDoc(doc(ctx.firestore(), path)); });
  return snap.exists() ? snap.data() : null;
}
/** Past the rules: everything stored under one account, { path: data }. */
async function storedUnder(uid) {
  const out = { [`users/${uid}`]: await stored(`users/${uid}`) };
  await env.withSecurityRulesDisabled(async (ctx) => {
    for (const name of ['habits', 'logs']) {
      for (const d of (await getDocs(collection(ctx.firestore(), `users/${uid}/${name}`))).docs) out[d.ref.path] = d.data();
    }
  });
  return out;
}

before(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host: emulatorConfig.firestoreHost, port: emulatorConfig.firestorePort } });
  await env.clearFirestore();
  await deleteAccounts();
  await emailPrivacy(false);
  await loadInvited();
});
afterEach(async () => {
  for (const { appName, store } of opened.splice(0)) {
    await store.signOut(); // detaches the listeners, so shutting Firestore down is not reported to them
    await deleteApp(getApp(appName));
  }
});
after(async () => {
  await env.clearFirestore();
  await deleteAccounts();
  await emailPrivacy(false);
  await loadRules(RULES); // leave the emulator with the rules as they are on disk
  await env.cleanup();
});

// ---------- check 1: the shared contract ----------

runStoreContract({
  test,
  label: 'firebase store',
  makeStore: async () => {
    const { store, settle, advance } = await readyStore();
    return { store, today: TODAY, settle, advance };
  },
});

// ---------- status ----------

test('firebase store: loading until Auth has reported, then signedOut; nothing can be changed while signed out', async () => {
  const { store } = open();
  const seen = [];
  store.subscribe((state) => seen.push(state.status));
  assert.deepEqual(store.getState(), { status: 'loading', mode: 'emulator', user: null, habits: [], logs: {}, lastError: null });
  const before = await until(store, (state) => state.status === 'signedOut', 'Auth reports that nobody is signed in');
  assert.deepEqual(seen, ['loading', 'signedOut']);
  assert.deepEqual(before, { status: 'signedOut', mode: 'emulator', user: null, habits: [], logs: {}, lastError: null });

  assert.throws(() => store.saveHabit(WATER), fails('not-ready'));
  store.addCount(TODAY, 'habit000000000000001', 1);
  store.deleteHabit('habit000000000000001');
  store.restoreHabit('habit000000000000001');
  store.setTimeZone('Africa/Cairo');
  store.retry();
  assert.equal(store.getState(), before);
});

test('check 4: a new account is waiting, not an error; once invited, retry() creates the user record with the zone and is ready', async () => {
  const { store } = open({ tz: 'Asia/Tokyo' });
  const seen = [];
  store.subscribe((state) => seen.push(state.status));
  await store.signUp(' New.Person@Example.com ', 'secret1');
  const { user, ...rest } = store.getState();
  assert.deepEqual(rest, { status: 'waiting', mode: 'emulator', habits: [], logs: {}, lastError: null });
  assert.deepEqual(user, { uid: user.uid, email: 'new.person@example.com', tz: 'Asia/Tokyo' });
  assert.match(user.uid, /^\w{20,}$/);
  assert.equal(await stored(`users/${user.uid}`), null, 'the rules let a stranger create nothing');
  assert.throws(() => store.saveHabit(WATER), fails('not-ready'));

  store.retry(); // still not invited: stays waiting
  await sleep(300);
  assert.equal(store.getState().status, 'waiting');

  await invite(user.uid);
  store.retry();
  store.retry(); // a second tap on "check again" is harmless
  const ready = await until(store, (state) => state.status === 'ready', 'ready after retry()');
  assert.deepEqual(ready, { status: 'ready', mode: 'emulator', user, habits: [], logs: {}, lastError: null });
  assert.deepEqual(seen, ['loading', 'signedOut', 'loading', 'waiting', 'ready']);
  assert.deepEqual(await storedUnder(user.uid), { [`users/${user.uid}`]: { tz: 'Asia/Tokyo', createdAt: NOON, updatedAt: NOON } });
});

test('check 4: signing in to an account that is not invited resolves in waiting; an invited one gets its record on first sign-in', async () => {
  const stranger = await newAccount({ onList: false });
  const first = open();
  await first.store.signIn(stranger.email, stranger.password);
  assert.deepEqual([first.store.getState().status, first.store.getState().user.uid, first.store.getState().lastError], ['waiting', stranger.uid, null]);

  const account = await newAccount();
  assert.equal(await stored(`users/${account.uid}`), null);
  const second = open({ tz: 'Africa/Cairo' });
  await second.store.signIn(account.email, account.password);
  assert.deepEqual(second.store.getState().user, { uid: account.uid, email: account.email, tz: 'Africa/Cairo' });
  await second.settle();
  assert.deepEqual(await stored(`users/${account.uid}`), { tz: 'Africa/Cairo', createdAt: NOON, updatedAt: NOON });
});

test('a user record the rules refuse is tried once, shows as lastError, and is tried again only by retry()', async () => {
  const account = await newAccount();
  const { store } = open();
  const seen = [];
  store.subscribe((state) => { if (seen.at(-1) !== state.status) seen.push(state.status); });
  // The account may read its own data, but nothing may be written.
  await loadRules(`rules_version = '2';
    service cloud.firestore { match /databases/{db}/documents {
      match /users/{uid} { allow read: if request.auth.uid == uid; }
      match /users/{uid}/{rest=**} { allow read: if request.auth.uid == uid; }
    } }`);
  try {
    await rejects(store.signIn(account.email, account.password), 'unknown');
    const { lastError, ...rest } = store.getState();
    assert.deepEqual(rest, { status: 'loading', mode: 'emulator', user: null, habits: [], logs: {} });
    assert.equal(lastError.code, 'not-saved');
    assert.match(lastError.message, SENTENCE);
  } finally {
    await loadInvited();
  }
  // The real rules would accept the record now: a store that kept trying would become ready by itself.
  await sleep(500);
  assert.equal(store.getState().status, 'loading');
  assert.equal(await stored(`users/${account.uid}`), null);
  assert.deepEqual(seen, ['loading', 'signedOut', 'loading'], 'never ready on a record the rules had not accepted');

  store.retry();
  const ready = await until(store, (state) => state.status === 'ready', 'ready after retry()');
  assert.equal(ready.lastError, null);
  assert.deepEqual(await stored(`users/${account.uid}`), { tz: 'Europe/London', createdAt: NOON, updatedAt: NOON });
});

test('check 4: setTimeZone changes only the user record; another device signing in keeps the record', async () => {
  const { store, settle, advance, uid, email, password } = await readyStore({ tz: 'Europe/London' });
  const id = store.saveHabit(WATER);
  store.addCount(TODAY, id, 1);
  await settle();
  const before = await storedUnder(uid);
  assert.deepEqual(Object.keys(before).sort(), [`users/${uid}`, `users/${uid}/habits/${id}`, `users/${uid}/logs/2026-11`]);

  advance(5000);
  store.setTimeZone('Africa/Cairo');
  assert.equal(store.getState().user.tz, 'Africa/Cairo');
  await settle();
  const record = { tz: 'Africa/Cairo', createdAt: NOON, updatedAt: NOON + 5000 };
  assert.deepEqual(await storedUnder(uid), { ...before, [`users/${uid}`]: record });

  const other = open({ tz: 'America/Lima' }); // a device in another zone does not take the record over
  await other.store.signIn(email, password);
  assert.equal(other.store.getState().user.tz, 'Africa/Cairo');
  await other.settle();
  assert.deepEqual(await stored(`users/${uid}`), record);
});

// ---------- sync ----------

test('check 2: two stores signed in as one user see each other\'s changes within 2 seconds', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  a.store.addCount(TODAY, id, 1);
  await a.settle();

  const b = open();
  await b.store.signIn(a.email, a.password);
  assert.deepEqual(b.store.getState().habits, a.store.getState().habits, 'signIn resolves with the data already there');
  assert.equal(countOn(b.store.getState().logs, id, TODAY), 1);

  const second = a.store.saveHabit({ ...WATER, name: 'Gym', period: 'week' });
  await until(b.store, (state) => state.habits.length === 2, 'a new habit reaches the other store');
  assert.deepEqual(b.store.getState().habits, a.store.getState().habits);
  b.store.addCount(TODAY, id, 1);
  await until(a.store, (state) => countOn(state.logs, id, TODAY) === 2, 'a count reaches the other store');
  b.store.saveHabit({ ...WATER, id: second, name: 'Swim' });
  await until(a.store, (state) => state.habits[1]?.name === 'Swim', 'an edit reaches the other store');
  a.store.deleteHabit(id);
  await until(b.store, (state) => state.habits.length === 1, 'a delete reaches the other store');
  b.store.restoreHabit(id);
  await until(a.store, (state) => state.habits.length === 2, 'a restore reaches the other store');
  a.store.setTimeZone('Asia/Tokyo');
  await until(b.store, (state) => state.user.tz === 'Asia/Tokyo', 'the zone reaches the other store');

  await a.settle();
  await b.settle();
  assert.deepEqual(a.store.getState(), b.store.getState());
  // What is stored has the shapes of contracts section 4: no id in the habit, counts under `days`.
  const docs = await storedUnder(a.uid);
  assert.deepEqual(Object.keys(docs[`users/${a.uid}/habits/${id}`]).sort(), HABIT_FIELDS);
  assert.deepEqual(docs[`users/${a.uid}/habits/${id}`], Object.fromEntries(Object.entries(a.store.getState().habits[0]).filter(([key]) => key !== 'id')));
  assert.deepEqual(docs[`users/${a.uid}/logs/2026-11`], { days: { [TODAY]: { [id]: 2 } } });
});

test('check 3: both stores add +1 at the same moment: both end at 2', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);
  const seen = { a: [], b: [] };
  a.store.subscribe((state) => seen.a.push(countOn(state.logs, id, TODAY)));
  b.store.subscribe((state) => seen.b.push(countOn(state.logs, id, TODAY)));

  a.store.addCount(TODAY, id, 1);
  b.store.addCount(TODAY, id, 1);
  assert.deepEqual([seen.a.at(-1), seen.b.at(-1)], [1, 1], 'each shows its own tap at once');
  await Promise.all([a, b].map(({ store }) => until(store, (state) => countOn(state.logs, id, TODAY) === 2, 'both taps counted')));
  await a.settle();
  await b.settle();
  assert.deepEqual([seen.a.at(-1), seen.b.at(-1)], [2, 2]);
  neverDown(seen.a);
  neverDown(seen.b);
  assert.deepEqual(await stored(`users/${a.uid}/logs/2026-11`), { days: { [TODAY]: { [id]: 2 } } });
});

// ---------- optimistic changes against snapshots ----------

test('20 rapid taps: every state shows exactly the taps made so far, never fewer, and it settles at 20', async () => {
  const { store, settle, uid } = await readyStore();
  const id = store.saveHabit(WATER);
  await settle();
  let tapped = 0;
  const seen = [], wrong = [];
  store.subscribe((state) => {
    const shown = countOn(state.logs, id, TODAY);
    seen.push(shown);
    if (shown !== tapped) wrong.push(`${shown} shown after ${tapped} taps`);
  });
  for (let i = 1; i <= 20; i++) {
    tapped = i;
    store.addCount(TODAY, id, 1);
    assert.equal(countOn(store.getState().logs, id, TODAY), i);
    if (i % 4 === 0) await sleep(i % 8 ? 0 : 6); // let snapshots of earlier taps arrive between taps
  }
  await settle();
  await sleep(200);
  assert.deepEqual(wrong, []);
  neverDown(seen);
  assert.deepEqual([seen[0], seen.at(-1), countOn(store.getState().logs, id, TODAY)], [0, 20, 20]);
  assert.deepEqual(await stored(`users/${uid}/logs/2026-11`), { days: { [TODAY]: { [id]: 20 } } });
  assert.equal(store.getState().lastError, null);
});

test('taps up and down across two months, with snapshots arriving in between: the state always equals what was tapped', async () => {
  const { store, settle, uid } = await readyStore();
  const id = store.saveHabit(WATER);
  const lastMonth = '2026-10-29';
  const expected = { [TODAY]: 0, [lastMonth]: 0 };
  const wrong = [];
  store.subscribe((state) => {
    for (const day of [TODAY, lastMonth]) {
      if (countOn(state.logs, id, day) !== expected[day]) wrong.push(`${day}: ${countOn(state.logs, id, day)} shown, ${expected[day]} tapped`);
    }
  });
  const taps = [1, 1, 1, -1, 1, 1, -1, -1, 1, 1, 1, 1, -1, 1, -1, 1, 1, 1, -1, 1];
  for (const [i, delta] of taps.entries()) {
    const day = i % 3 === 2 ? lastMonth : TODAY;
    if (expected[day] + delta >= 0) expected[day] += delta;
    store.addCount(day, id, delta);
    await sleep(i % 5); // 0 to 4 ms: some taps land before, some after the snapshot of the one before
  }
  await settle();
  await sleep(200);
  assert.deepEqual(wrong, []);
  assert.deepEqual(await stored(`users/${uid}/logs/2026-11`), { days: { [TODAY]: { [id]: expected[TODAY] } } });
  assert.deepEqual(await stored(`users/${uid}/logs/2026-10`), { days: { [lastMonth]: { [id]: expected[lastMonth] } } });
});

test('a tap on another device in the middle of a burst of local taps: the count never goes down and ends with all of them', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);
  const seen = [];
  a.store.subscribe((state) => seen.push(countOn(state.logs, id, TODAY)));
  // 30 taps, 2 ms apart, so there is always one waiting for the server; the other device taps once early
  // on, and nothing changes after the burst: its tap must still show once the burst has been confirmed.
  for (let i = 1; i <= 30; i++) {
    a.store.addCount(TODAY, id, 1);
    if (i === 5) b.store.addCount(TODAY, id, 1);
    await sleep(2);
  }
  await Promise.all([a, b].map(({ store }) => until(store, (state) => countOn(state.logs, id, TODAY) === 31, 'all 31 taps counted')));
  await a.settle();
  await b.settle();
  neverDown(seen);
  assert.deepEqual([seen.at(-1), countOn(b.store.getState().logs, id, TODAY)], [31, 31]);
  assert.deepEqual(await stored(`users/${a.uid}/logs/2026-11`), { days: { [TODAY]: { [id]: 31 } } });
});

test('a tap here while a tap from another device is on its way: both are counted, for every habit tried', async () => {
  const a = await readyStore();
  const ids = Array.from({ length: 12 }, (_, i) => a.store.saveHabit({ ...WATER, name: `Habit ${i + 1}` }));
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);
  const seen = Object.fromEntries(ids.map((id) => [id, []]));
  a.store.subscribe((state) => { for (const id of ids) seen[id].push(countOn(state.logs, id, TODAY)); });
  // The other device's tap is saved on the server, and this one taps before, while or just after the news
  // arrives. When it arrives while our tap is waiting, the snapshot is skipped and nothing but the change
  // from "pending" to "confirmed" follows: the store must still end up showing both.
  for (const [i, id] of ids.entries()) {
    b.store.addCount(TODAY, id, 1);
    await waitForPendingWrites(b.db);
    await sleep(i % 3);
    a.store.addCount(TODAY, id, 1);
  }
  await until(a.store, (state) => ids.every((id) => countOn(state.logs, id, TODAY) === 2), 'both taps counted for every habit');
  await a.settle();
  for (const id of ids) neverDown(seen[id]);
  assert.deepEqual(await stored(`users/${a.uid}/logs/2026-11`), { days: { [TODAY]: Object.fromEntries(ids.map((id) => [id, 2])) } });
});

test('two devices undo the same tap: the server ends at -1, every store shows 0', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  a.store.addCount(TODAY, id, 1);
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);
  assert.equal(countOn(b.store.getState().logs, id, TODAY), 1);

  a.store.addCount(TODAY, id, -1);
  b.store.addCount(TODAY, id, -1); // b has not heard of a's undo yet
  await Promise.all([a.settle(), b.settle()]);
  await sleep(300);
  assert.deepEqual(await stored(`users/${a.uid}/logs/2026-11`), { days: { [TODAY]: { [id]: -1 } } }, 'increments add up on the server');
  const late = open();
  await late.store.signIn(a.email, a.password);
  for (const { store } of [a, b, late]) assert.equal(store.getState().logs['2026-11'][TODAY][id], 0);
});

test('offline: changes show at once and stay; with cached data and no connection sign-in still reaches ready; then it all syncs', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  a.store.addCount(TODAY, id, 1);
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);

  await disableNetwork(a.db);
  const seen = [];
  a.store.subscribe((state) => seen.push(countOn(state.logs, id, TODAY)));
  for (let i = 0; i < 3; i++) a.store.addCount(TODAY, id, 1);
  const second = a.store.saveHabit({ ...WATER, name: 'Made offline' });
  await sleep(300);
  assert.deepEqual([seen.at(-1), a.store.getState().habits.map((h) => h.id), a.store.getState().lastError], [4, [id, second], null]);
  neverDown(seen);
  assert.equal(countOn(b.store.getState().logs, id, TODAY), 1, 'nothing has left the offline store yet');

  // Sign-in itself needs the Auth service, but the data must not: it comes from the cache.
  await a.store.signOut();
  await a.store.signIn(a.email, a.password);
  assert.deepEqual([a.store.getState().status, a.store.getState().habits.map((h) => h.id), countOn(a.store.getState().logs, id, TODAY)],
    ['ready', [id, second], 4]);

  await enableNetwork(a.db);
  await until(b.store, (state) => countOn(state.logs, id, TODAY) === 4 && state.habits.length === 2, 'the offline changes reach the other store');
  await a.settle();
  assert.deepEqual([countOn(a.store.getState().logs, id, TODAY), a.store.getState().lastError], [4, null]);
  assert.deepEqual(await stored(`users/${a.uid}/logs/2026-11`), { days: { [TODAY]: { [id]: 4 } } });
});

// ---------- refused writes ----------

test('a write the rules refuse sets lastError "not-saved"; a write made after that and saved clears it', async () => {
  const { store, settle, uid } = await readyStore();
  const id = store.saveHabit(WATER);
  await settle();
  // An eleventh field in the stored habit: now no update from the app can leave it valid, so the rules refuse.
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `users/${uid}/habits/${id}`), { extra: true }));
  await until(store, (state) => state.habits[0]?.extra === true, 'the changed habit arrives');

  store.saveHabit({ ...WATER, id, name: 'Refused' });
  store.addCount(TODAY, id, 1); // made before the refusal is known: its success must not hide the error
  assert.deepEqual([store.getState().habits[0].name, store.getState().lastError], ['Refused', null], 'optimistic first');
  await settle();
  const { lastError, habits, logs } = store.getState();
  assert.equal(lastError.code, 'not-saved');
  assert.match(lastError.message, SENTENCE);
  assert.deepEqual([habits[0].name, countOn(logs, id, TODAY)], ['Water', 1], 'Firestore put the habit back; the count was saved');
  assert.equal((await stored(`users/${uid}/habits/${id}`)).name, 'Water');

  store.addCount(TODAY, id, 1);
  assert.equal(store.getState().lastError, lastError, 'still there until the server has answered');
  await settle();
  assert.deepEqual([store.getState().lastError, countOn(store.getState().logs, id, TODAY)], [null, 2]);
});

test('an account taken off the invite list: its next write is refused, and after signing in again it is waiting', async () => {
  const { store, settle, uid, email, password } = await readyStore();
  const id = store.saveHabit(WATER);
  await settle();
  await uninvite(uid);
  store.addCount(TODAY, id, 1);
  await settle();
  assert.equal(store.getState().lastError?.code, 'not-saved');
  assert.equal(await stored(`users/${uid}/logs/2026-11`), null);
  await store.signOut();
  assert.equal(store.getState().lastError, null, 'sign-out clears the error too');
  // What this device still has in its cache may show for a moment (it cannot tell "refused" from "offline"
  // before the server answers); then the refusal arrives.
  await store.signIn(email, password);
  const waiting = await until(store, (state) => state.status === 'waiting', 'waiting once the server has refused');
  assert.deepEqual([waiting.habits, waiting.logs, waiting.user.uid], [[], {}, uid]);
});

// ---------- signing in and out ----------

test('sign-in errors have the contract codes and a plain sentence, and leave the state alone', async (t) => {
  const { email } = await newAccount();
  const { store } = open();
  const before = await until(store, (state) => state.status === 'signedOut', 'signed out');

  for (const protection of [false, true]) { // the emulator's default, then what the real project does
    await emailPrivacy(protection);
    await rejects(store.signIn('nobody@example.com', 'secret-1'), 'wrong-credentials');
    await rejects(store.signIn(email, 'not-the-password'), 'wrong-credentials');
    await rejects(store.signUp(email, 'another-secret'), 'email-in-use');
    assert.equal(await store.resetPassword('nobody@example.com'), undefined, 'an unknown email is not given away');
    assert.equal(await store.resetPassword(` ${email.toUpperCase()} `), undefined);
  }
  await rejects(store.signIn('not-an-email', 'secret-1'), 'invalid-email');
  await rejects(store.signUp('a@b', 'secret-1'), 'invalid-email');
  await rejects(store.signUp(undefined, 'secret-1'), 'invalid-email');
  await rejects(store.resetPassword('nope'), 'invalid-email');
  await rejects(store.signUp('short@example.com', '12345'), 'weak-password');
  await rejects(store.signIn(email, '12345'), 'wrong-credentials');
  await rejects(store.signIn(email, undefined), 'wrong-credentials');

  // Answers of the Auth service that the emulator never gives, put on the wire for the real SDK to read.
  const answer = (message) => async () => new Response(JSON.stringify({ error: { code: 400, message } }), { status: 400, headers: { 'content-type': 'application/json' } });
  // The Auth SDK keeps the `fetch` it found when it was loaded; FetchProvider is its own switch for another one.
  const wire = t.mock.fn(async () => { throw new TypeError('fetch failed'); });
  FetchProvider.initialize(wire);
  try {
    // When fetch throws, the SDK leaves its 30-second request timer running, which would keep this process
    // alive that long. Nothing below needs a timer, so they are switched off for these three calls.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await rejects(store.signIn(email, 'secret-1'), 'offline');
    await rejects(store.signUp('new@example.com', 'secret-1'), 'offline');
    await rejects(store.resetPassword(email), 'offline');
    t.mock.timers.reset();
    wire.mock.mockImplementation(answer('TOO_MANY_ATTEMPTS_TRY_LATER'));
    await rejects(store.signIn(email, 'secret-1'), 'too-many-requests');
    wire.mock.mockImplementation(answer('WEAK_PASSWORD : Password should be at least 6 characters'));
    await rejects(store.signUp('new@example.com', 'secret-1'), 'weak-password');
    wire.mock.mockImplementation(answer('INVALID_EMAIL'));
    await rejects(store.signIn(email, 'secret-1'), 'invalid-email');
    wire.mock.mockImplementation(answer('OPERATION_NOT_ALLOWED'));
    await rejects(store.signIn(email, 'secret-1'), 'unknown');
    assert.equal(wire.mock.callCount(), 7, 'each of these went through the SDK');
  } finally {
    t.mock.timers.reset();
    FetchProvider.initialize(fetch);
  }

  assert.equal(store.getState(), before);
});

test('signOut clears the state and stops the listeners; signing in again brings the data back', async () => {
  const a = await readyStore();
  const id = a.store.saveHabit(WATER);
  a.store.addCount(TODAY, id, 1);
  await a.settle();
  const b = open();
  await b.store.signIn(a.email, a.password);

  const seen = [];
  a.store.subscribe((state) => seen.push(state));
  await a.store.signOut();
  const signedOut = a.store.getState();
  assert.deepEqual(signedOut, { status: 'signedOut', mode: 'emulator', user: null, habits: [], logs: {}, lastError: null });
  assert.deepEqual(seen.map((state) => state.status), ['ready', 'signedOut']);
  assert.throws(() => a.store.saveHabit(WATER), fails('not-ready'));

  b.store.addCount(TODAY, id, 1);
  b.store.saveHabit({ ...WATER, name: 'While the other was signed out' });
  await b.settle();
  await sleep(300);
  assert.equal(a.store.getState(), signedOut, 'nothing arrives after sign-out');
  assert.equal(seen.length, 2);

  await a.store.signIn(a.email, a.password); // ready at once from this device's cache, then the server catches it up
  assert.equal(a.store.getState().status, 'ready');
  await until(a.store, (state) => state.habits.length === 2 && countOn(state.logs, id, TODAY) === 2, 'what happened meanwhile arrives');
  assert.deepEqual(a.store.getState(), b.store.getState());
});

// ---------- devices ----------

test('devices: saved with exactly uid, ua and updatedAt; taken over by the next account; removeDevice always resolves', async () => {
  const a = await readyStore(), b = await readyStore();
  const fid = 'dGVzdC1pbnN0YWxsLWlk_x'; // 22 characters, like a Firebase installation id
  const path = `devices/${fid}`;

  assert.equal(await a.store.saveDevice(fid), undefined);
  assert.deepEqual(await stored(path), { uid: a.uid, ua: navigator.userAgent, updatedAt: NOON });
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mozilla/5.0 '.repeat(60) }, configurable: true });
  try {
    a.advance(1000);
    await a.store.saveDevice(fid);
  } finally {
    Object.defineProperty(globalThis, 'navigator', realNavigator);
  }
  assert.deepEqual(await stored(path), { uid: a.uid, ua: 'Mozilla/5.0 '.repeat(60).slice(0, 500), updatedAt: NOON + 1000 });

  await b.store.saveDevice(fid); // the next person to sign in on this browser takes the record over
  assert.equal((await stored(path)).uid, b.uid);
  assert.equal(await a.store.removeDevice(fid), undefined, 'not mine any more: resolves and leaves it alone');
  assert.equal((await stored(path)).uid, b.uid);
  assert.equal(await b.store.removeDevice(fid), undefined);
  assert.equal(await stored(path), null);
  assert.equal(await b.store.removeDevice(fid), undefined, 'already gone');
  assert.equal(await b.store.removeDevice('never-saved'), undefined);

  for (const bad of ['', 'a/b', 'x'.repeat(65), 'has space', undefined]) {
    await rejects(a.store.saveDevice(bad), 'invalid');
    assert.equal(await a.store.removeDevice(bad), undefined);
  }
  assert.equal(await a.store.saveDevice('x'.repeat(64)), undefined, 'the longest id the rules accept');
  assert.deepEqual([a.store.getState().lastError, b.store.getState().lastError], [null, null]);

  const stranger = open();
  await stranger.store.signUp('stranger@example.com', 'secret1');
  assert.equal(stranger.store.getState().status, 'waiting');
  await rejects(stranger.store.saveDevice('strangers-device'), 'not-saved');
  assert.equal(await stored('devices/strangers-device'), null);
  assert.equal(await stranger.store.removeDevice('x'.repeat(64)), undefined);
  assert.equal((await stored(`devices/${'x'.repeat(64)}`)).uid, a.uid);

  const nobody = open();
  await until(nobody.store, (state) => state.status === 'signedOut', 'signed out');
  await rejects(nobody.store.saveDevice(fid), 'not-ready');
  assert.equal(await nobody.store.removeDevice(fid), undefined);
});

test('devices are written on the server at once or not at all, never queued for later', async () => {
  const a = await readyStore();
  const fid = 'bm90LXF1ZXVlZC1kZXZpY2', path = `devices/${fid}`;

  // With the cache's network off an ordinary write would wait in the queue. These do not go through it.
  await disableNetwork(a.db);
  await soon(a.store.saveDevice(fid), 'saveDevice');
  assert.equal((await stored(path)).uid, a.uid);
  await soon(a.store.removeDevice(fid), 'removeDevice');
  assert.equal(await stored(path), null);
  await enableNetwork(a.db);

  // Firestore out of reach: both calls fail, and nothing arrives later.
  const cut = openUnreachable();
  await rejects(cut.store.signIn(a.email, a.password), 'offline');
  await rejects(soon(cut.store.saveDevice(fid), 'saveDevice'), 'not-saved');
  await a.store.saveDevice(fid);
  await rejects(soon(cut.store.removeDevice(fid), 'removeDevice'), 'not-saved');
  await sleep(300);
  assert.equal((await stored(path)).uid, a.uid);
  assert.equal(a.store.getState().lastError, null);
});
