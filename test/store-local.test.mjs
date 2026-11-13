// The demo store: the shared Store contract, then what only the demo store promises (contracts.md, "Demo store").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalStore, STORAGE_KEY } from '../src/store-local.js';
import { sampleData, SAMPLE_WEEKS } from '../src/sample-data.js';
import { StoreError } from '../src/store.js';
import { addDays, countOn, keyOf, startDay, stats, streak, validateHabit, weekStart } from '../shared/logic.js';
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

runStoreContract({
  test,
  label: 'demo store',
  makeStore: async () => {
    let clock = noonOn(TODAY)().getTime();
    return { store: open(fakeStorage(), { now: () => new Date(clock) }), today: TODAY, advance: (ms) => { clock += ms; } };
  },
});

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
  first.addCount(addDays(TODAY, -7), kept, 1); // 27 October: another month, and before the start date
  first.addCount(TODAY, deleted, 1);
  first.deleteHabit(deleted);
  first.setTimeZone('Africa/Cairo');
  assert.deepEqual([...storage.map.keys()], [STORAGE_KEY]);
  assert.equal(STORAGE_KEY, 'habit-tally:v1');

  const second = open(storage, { tz: 'Asia/Tokyo', sample: true });
  assert.deepEqual(second.getState(), first.getState());
  const { habits, logs } = second.getState();
  assert.deepEqual(habits.map((h) => [h.id, h.created, startDay(h, logs)]), [[kept, TODAY, '2026-10-27']]);
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

test('demo store: stored habits with an unsafe id are left out, the rest is kept', () => {
  const ids = ['constructor', '__proto__', 'toString', 'a.b', 'two words', 'good1', 'good2'];
  const habits = ids.map((id, i) => ({ id, ...WATER, created: TODAY, archived: false, deletedAt: null, order: i, updatedAt: 1 }));
  const saved = { v: 1, signedIn: true, user: { uid: 'demo', email: 'a@b.co', tz: 'UTC' }, habits, logs: { '2026-11': { [TODAY]: { good1: 2 } } } };
  const store = open(fakeStorage({ [STORAGE_KEY]: JSON.stringify(saved) }));
  assert.deepEqual(store.getState().habits.map((h) => h.id), ['good1', 'good2']);
  assert.deepEqual([countOn(store.getState().logs, 'good1', TODAY), store.getState().user.email], [2, 'a@b.co']);
});

test('demo store: a very long stored list of deleted habits does not break adding one', () => {
  const habits = Array.from({ length: 150_000 }, (_, i) => (
    { id: `old${i}`, ...WATER, created: TODAY, archived: false, deletedAt: 5, order: i + 1, updatedAt: 1 }));
  const text = JSON.stringify({ v: 1, signedIn: true, user: { uid: 'demo', email: 'a@b.co', tz: 'UTC' }, habits, logs: {} });
  const store = open({ getItem: () => text, setItem: () => {}, removeItem: () => {} });
  store.saveHabit(WATER); // spreading 150 000 orders into Math.max would throw a RangeError here
  assert.deepEqual(store.getState().habits.map((h) => h.order), [150_001]);
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

test('demo store: while signed out, saveHabit throws "not-ready" and the other changes are ignored', async () => {
  const storage = fakeStorage();
  const store = open(storage);
  const id = store.saveHabit(WATER);
  const gone = store.saveHabit({ ...WATER, name: 'Gone' });
  store.deleteHabit(gone);
  await store.signOut();
  const [before, stored] = [store.getState(), storage.map.get(STORAGE_KEY)];
  for (const input of [WATER, { ...WATER, id }, { ...WATER, name: '' }]) {
    assert.throws(() => store.saveHabit(input), (err) => err instanceof StoreError && err.code === 'not-ready' && err.message.length > 0);
  }
  store.addCount(TODAY, id, 1);
  store.deleteHabit(id);
  store.restoreHabit(gone);
  store.setTimeZone('Africa/Cairo');
  assert.equal(store.getState(), before);
  assert.equal(storage.map.get(STORAGE_KEY), stored);
  await store.signIn('a@b.co', 'secret');
  assert.deepEqual(store.getState().habits.map((h) => h.id), [id], 'nothing happened behind the sign-in screen');
});

test('demo store: more calls that are ignored, beyond those in the shared contract', async () => {
  const store = open();
  const id = store.saveHabit(WATER);
  const gone = store.saveHabit({ ...WATER, name: 'Gone' });
  store.deleteHabit(gone);
  let calls = 0;
  store.subscribe(() => calls++);
  const before = store.getState();
  for (const delta of ['1', -2, undefined]) store.addCount(TODAY, id, delta);
  for (const day of [addDays(TODAY, -8), '2026-11-3', '', undefined]) store.addCount(day, id, 1);
  for (const zone of ['Mars/Olympus', '', undefined, 'Europe/London']) store.setTimeZone(zone);
  store.deleteHabit(gone); // already deleted
  store.restoreHabit(id); // not deleted
  store.retry();
  await store.saveDevice('fid');
  await store.removeDevice('fid');
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

const fixture = JSON.parse(readFileSync(new URL('./fixtures/sample-16-weeks.json', import.meta.url), 'utf8'));

test('sample data: 16 weeks for one daily and one weekly habit, with the totals and streaks of the fixture', () => {
  const { habits, logs } = sampleData(fixture.today);
  assert.deepEqual(sampleData(fixture.today), { habits, logs }, 'the same day gives the same data');
  assert.deepEqual(habits.map((h) => [h.id, h.name, h.period, h.target]), fixture.habits.map((h) => [h.id, h.name, h.period, h.target]));
  assert.deepEqual(habits.map((h) => h.period), ['day', 'week']);
  for (const [i, habit] of habits.entries()) {
    assert.deepEqual(validateHabit(habit), []);
    assert.match(habit.id, /^[A-Za-z0-9]{20}$/);
    assert.equal(habit.created, fixture.firstDay);
    assert.deepEqual(stats(habit, logs, fixture.today), fixture.habits[i].expected, habit.name);
    assert.equal(streak(habit, logs, fixture.today), fixture.habits[i].expected.streak, habit.name);
  }
  assert.equal(fixture.firstDay, addDays(weekStart(fixture.today), -7 * (SAMPLE_WEEKS - 1)));
  for (const [day, id, count] of fixture.counts) assert.equal(countOn(logs, id, day), count, `${id} on ${day}`);
  const days = Object.values(logs).flatMap((month) => Object.keys(month));
  assert.ok(days.every((day) => day >= fixture.firstDay && day <= fixture.today), 'nothing outside the 16 weeks');
  const hitRate = fixture.habits.map((h) => h.expected.hitPeriods / h.expected.periods);
  assert.ok(hitRate.every((rate) => rate > 0.5 && rate < 0.8), 'a believable mix of hit and missed periods');
});

test('demo store: sample data loads only when asked for and only into empty storage', () => {
  const storage = fakeStorage();
  const now = noonOn(fixture.today);
  assert.deepEqual(open(storage, { now }).getState().habits, []);
  assert.equal(storage.map.size, 0, 'looking does not write');

  const store = open(storage, { now, sample: true });
  const { habits, logs } = store.getState();
  assert.deepEqual({ habits, logs }, sampleData(fixture.today));
  for (const [i, habit] of habits.entries()) assert.deepEqual(stats(habit, logs, fixture.today), fixture.habits[i].expected);
  assert.deepEqual(open(storage, { now }).getState(), store.getState(), 'the sample was saved');

  store.deleteHabit(habits[0].id);
  store.deleteHabit(habits[1].id);
  const later = open(storage, { now: noonOn(addDays(fixture.today, 1)), sample: true });
  assert.deepEqual(later.getState().habits, [], 'the sample does not come back over saved data');
  assert.equal(open(fakeStorage({ [STORAGE_KEY]: 'damaged' }), { now, sample: true }).getState().habits.length, 2);
});
