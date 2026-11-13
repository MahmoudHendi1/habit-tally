// The demo store: the shared Store contract, then what only the demo store promises (contracts.md, "Demo store").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, STORAGE_KEY } from '../src/store-local.js';
import { StoreError } from '../src/store.js';
import { addDays, countOn, keyOf } from '../shared/logic.js';
import { runStoreContract } from './store-contract.mjs';

// A Tuesday early in the month, so "7 days back" crosses a week and a month boundary.
const TODAY = '2026-11-03';
const noonOn = (day) => () => new Date(`${day}T12:00:00`);
const WATER = { name: 'Water', period: 'day', target: 3, unit: '', times: [] };

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}
const open = (storage = fakeStorage(), options = {}) =>
  createLocalStore({ storage, now: noonOn(TODAY), tz: 'Europe/London', ...options });
const rejects = (promise, code) => assert.rejects(promise, (err) => err instanceof StoreError && err.code === code && err.message.length > 0);

runStoreContract({ test, label: 'demo store', makeStore: async () => ({ store: open(), today: TODAY }) });

test('demo store: starts signed in as the demo user, in the given zone', () => {
  const state = open().getState();
  assert.deepEqual(state, { status: 'ready', mode: 'demo', user: { uid: 'demo', email: 'demo@habit-tally.example', tz: 'Europe/London' },
    habits: [], logs: {}, lastError: null });
  assert.equal(keyOf(noonOn(TODAY)()), TODAY);
});

test('demo store: a new store on the same storage sees the earlier data', () => {
  const storage = fakeStorage();
  const first = open(storage);
  const kept = first.saveHabit(WATER);
  const deleted = first.saveHabit({ ...WATER, name: 'Gym', period: 'week' });
  first.addCount(TODAY, kept, 1);
  first.addCount(addDays(TODAY, -7), kept, 1); // 27 October: another month, and it moves the start date
  first.addCount(TODAY, deleted, 1);
  first.deleteHabit(deleted);
  first.setTimeZone('Africa/Cairo');
  assert.deepEqual([...storage.map.keys()], [STORAGE_KEY]);
  assert.equal(STORAGE_KEY, 'habit-tally:v1');

  const second = open(storage, { tz: 'Asia/Tokyo' });
  assert.deepEqual(second.getState(), first.getState());
  assert.deepEqual(second.getState().habits.map((h) => [h.id, h.created]), [[kept, '2026-10-27']]);
  assert.equal(second.getState().user.tz, 'Africa/Cairo');
  second.restoreHabit(deleted); // deleted habits are kept too, so Undo works after a reload
  assert.deepEqual(second.getState().habits.map((h) => h.id), [kept, deleted]);
  assert.equal(countOn(second.getState().logs, deleted, TODAY), 1);
});

test('demo store: missing or damaged storage starts clean without an error', () => {
  const good = { v: 1, signedIn: true, user: { uid: 'demo', email: 'a@b.co', tz: 'UTC' }, habits: [], logs: {} };
  const habit = { id: 'h1', ...WATER, created: TODAY, archived: false, deletedAt: null, order: 1, updatedAt: 1 };
  assert.equal(open(fakeStorage({ [STORAGE_KEY]: JSON.stringify({ ...good, habits: [habit] }) })).getState().habits.length, 1);
  const damaged = ['', 'not json', '{"v":1,"hab', 'null', '[]', '42', JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, signedIn: 'yes' }), JSON.stringify({ ...good, user: null }), JSON.stringify({ ...good, habits: {} }),
    JSON.stringify({ ...good, habits: [{ ...habit, target: 99 }] }), JSON.stringify({ ...good, habits: [{ ...habit, id: 7 }] }),
    JSON.stringify({ ...good, habits: [{ ...habit, created: undefined }] }), JSON.stringify({ ...good, logs: [] }),
    JSON.stringify({ ...good, logs: { '2026-11': { [TODAY]: { h1: 'two' } } } })];
  const storages = [...damaged.map((text) => fakeStorage({ [STORAGE_KEY]: text })),
    { ...fakeStorage(), getItem: () => { throw new Error('blocked'); } }];
  for (const storage of storages) {
    const store = open(storage);
    assert.deepEqual(store.getState(), open().getState(), storage.map.get(STORAGE_KEY));
    const id = store.saveHabit(WATER); // and it works from there
    assert.deepEqual(store.getState().habits.map((h) => h.id), [id]);
    assert.equal(store.getState().lastError, null);
  }
});

test('demo store: storage that refuses writes sets lastError and keeps working in memory', () => {
  let full = true;
  const storage = fakeStorage();
  const store = open({ ...storage, setItem: (k, v) => { if (full) throw new Error('quota'); storage.setItem(k, v); } });
  const id = store.saveHabit(WATER);
  assert.equal(store.getState().habits.length, 1);
  assert.equal(store.getState().lastError.code, 'not-saved');
  full = false;
  store.addCount(TODAY, id, 1);
  assert.equal(store.getState().lastError, null);
  assert.equal(open(storage).getState().habits.length, 1);
});

test('demo store: sign-out, sign-in and sign-up move between signedOut and ready', async () => {
  const storage = fakeStorage();
  const store = open(storage);
  const id = store.saveHabit(WATER);
  store.addCount(TODAY, id, 1);
  const seen = [];
  store.subscribe((state) => seen.push(state.status));

  await store.signOut();
  assert.deepEqual(store.getState(), { status: 'signedOut', mode: 'demo', user: null, habits: [], logs: {}, lastError: null });
  assert.equal(open(storage).getState().status, 'signedOut', 'a reload does not sign back in');

  await store.signIn(' Me@Example.com ', 'secret');
  assert.deepEqual(store.getState().user, { uid: 'demo', email: 'me@example.com', tz: 'Europe/London' });
  const { status, habits, logs } = store.getState();
  assert.deepEqual([status, habits.map((h) => h.id), countOn(logs, id, TODAY)], ['ready', [id], 1]);

  await store.signOut();
  await store.signUp('new@example.com', '123456');
  assert.deepEqual([store.getState().status, store.getState().user.email, store.getState().habits.length], ['ready', 'new@example.com', 1]);
  assert.deepEqual(seen, ['ready', 'signedOut', 'ready', 'signedOut', 'ready']);
  assert.equal(open(storage).getState().user.email, 'new@example.com');
});

test('demo store: sign-in errors have the contract codes and leave the state alone', async () => {
  const store = open();
  await store.signOut();
  const before = store.getState();
  await rejects(store.signIn('not-an-email', 'secret'), 'invalid-email');
  await rejects(store.signUp('a@b', 'secret'), 'invalid-email');
  await rejects(store.signUp(undefined, 'secret'), 'invalid-email');
  await rejects(store.signUp('a@b.co', '12345'), 'weak-password');
  await rejects(store.signIn('a@b.co', '12345'), 'wrong-credentials');
  await rejects(store.signIn('a@b.co', undefined), 'wrong-credentials');
  await rejects(store.resetPassword('nope'), 'invalid-email');
  assert.equal(await store.resetPassword('a@b.co'), undefined);
  assert.equal(store.getState(), before);
});

test('demo store: while signed out, nothing can be changed', async () => {
  const storage = fakeStorage();
  const store = open(storage);
  const id = store.saveHabit(WATER);
  await store.signOut();
  const [before, stored] = [store.getState(), storage.map.get(STORAGE_KEY)];
  assert.throws(() => store.saveHabit(WATER), (err) => err instanceof StoreError && err.code === 'not-ready');
  store.addCount(TODAY, id, 1);
  store.deleteHabit(id);
  store.setTimeZone('Africa/Cairo');
  assert.equal(store.getState(), before);
  assert.equal(storage.map.get(STORAGE_KEY), stored);
});

test('demo store: calls that must be ignored change nothing and tell nobody', async () => {
  const store = open();
  const id = store.saveHabit(WATER);
  const gone = store.saveHabit({ ...WATER, name: 'Gone' });
  store.deleteHabit(gone);
  let calls = 0;
  store.subscribe(() => calls++);
  const before = store.getState();
  store.addCount(TODAY, id, -1);
  for (const delta of [0, 2, -2, '1', undefined]) store.addCount(TODAY, id, delta);
  for (const day of [addDays(TODAY, 1), addDays(TODAY, -8), '2026-11-3', 'today', '', undefined]) store.addCount(day, id, 1);
  for (const habitId of ['missing', gone, undefined]) store.addCount(TODAY, habitId, 1);
  for (const zone of ['Mars/Olympus', '', undefined, 'Europe/London']) store.setTimeZone(zone);
  store.deleteHabit('missing');
  store.deleteHabit(gone);
  store.restoreHabit(id);
  store.retry();
  await store.saveDevice('fid');
  await store.removeDevice('fid');
  assert.throws(() => store.saveHabit({ ...WATER, id: 'missing' }), (err) => err instanceof StoreError && err.code === 'not-found');
  assert.throws(() => store.saveHabit(null), (err) => err instanceof StoreError && err.code === 'invalid');
  assert.equal(store.getState(), before);
  assert.equal(calls, 1);
});

test('demo store: one failing listener does not stop the change or the other listeners', (t) => {
  t.mock.method(console, 'error', () => {});
  const store = open();
  const seen = [];
  let broken = false;
  store.subscribe(() => { if (broken) throw new Error('listener bug'); });
  store.subscribe((state) => seen.push(state.habits.length));
  broken = true;
  store.saveHabit(WATER);
  assert.deepEqual(seen, [0, 1]);
  assert.equal(console.error.mock.callCount(), 1);
});
