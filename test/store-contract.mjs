// The Store contract (docs/contracts.md section 5) as tests that every store must pass.
// Run against the demo store by test/store-local.test.mjs and against the Firebase store on the emulator by B1.
// It only uses the Store interface, and it checks every expectation twice: at once, because changes are
// optimistic and must show before the call returns, and again after `settle()`, because a backend that
// confirms a little later must not take the change back.
import assert from 'node:assert/strict';
import { LIMITS, addDays, countOn, monthId, startDay, stats } from '../shared/logic.js';
import { StoreError } from '../src/store.js';

const WATER = { name: 'Water', period: 'day', target: 3, unit: 'glasses', times: ['09:00'] };
const shortWait = () => new Promise((resolve) => setTimeout(resolve, 5));
const anotherZone = (store) => (store.getState().user.tz === 'Africa/Cairo' ? 'Asia/Tokyo' : 'Africa/Cairo');
const UNKNOWN_ID = 'noSuchHabit000000000';
const fails = (code) => (err) => err instanceof StoreError && err.code === code && err.message.length > 0;

/**
 * @param {object} options
 * @param {(name: string, fn: (t: any) => Promise<void>) => unknown} options.test `test` from node:test
 * @param {() => Promise<{ store: any, today: string, cleanup?: () => unknown, settle?: () => Promise<unknown>,
 *   advance?: (ms: number) => void }>} options.makeStore
 *   Called once per test. Resolves with a store that is already `ready` on a fresh, empty account, the day
 *   that store calls today ('YYYY-MM-DD'), an optional `cleanup` run after the test, an optional `settle`
 *   that resolves once the backend has confirmed the writes so far (default: wait 5 ms), and an optional
 *   `advance` that moves the store's clock (its `now`) forward by `ms`. Without `advance` the one test that
 *   needs it is reported as skipped. The suite advances by a few seconds at most.
 * @param {string} [options.label] put in front of every test name
 */
export function runStoreContract({ test, makeStore, label = 'store' }) {
  const check = (name, body) => test(`${label} contract: ${name}`, async (t) => {
    const { store, today, cleanup, settle = shortWait, advance } = await makeStore();
    const holds = async (expectation) => {
      expectation();
      await settle();
      expectation();
    };
    const habit = (id) => store.getState().habits.find((h) => h.id === id);
    const count = (id, day = today) => countOn(store.getState().logs, id, day);
    try {
      await body({ store, today, holds, settle, habit, count, advance, t });
      await settle();
      assert.equal(store.getState().lastError, null, 'the backend refused none of these writes');
    } finally {
      await cleanup?.();
    }
  });

  check('a fresh account is ready and empty', async ({ store, holds }) => {
    await holds(() => {
      const { status, mode, user, habits, logs, lastError } = store.getState();
      assert.equal(status, 'ready');
      assert.ok(['demo', 'emulator', 'firebase'].includes(mode));
      assert.deepEqual([typeof user.uid, typeof user.email, typeof user.tz], ['string', 'string', 'string']);
      assert.deepEqual({ habits, logs, lastError }, { habits: [], logs: {}, lastError: null });
    });
  });

  check('add a habit: cleaned, with id, start date and order set by the store', async ({ store, today, holds }) => {
    const id = store.saveHabit({ name: '  Drink   water ', period: 'day', target: '8', unit: ' glasses ', times: ['15:00', '09:10', '09:00'] });
    assert.match(id, /^[A-Za-z0-9]{20}$/);
    const second = store.saveHabit({ ...WATER, name: 'Gym', period: 'week' });
    assert.notEqual(second, id);
    await holds(() => {
      const [first, next] = store.getState().habits;
      const { order, updatedAt, ...rest } = first;
      assert.deepEqual(rest, { id, name: 'Drink water', period: 'day', target: 8, unit: 'glasses', times: ['09:00', '15:00'],
        created: today, archived: false, deletedAt: null });
      assert.deepEqual([typeof order, typeof updatedAt], ['number', 'number']);
      assert.deepEqual([next.id, next.period, next.order > order], [second, 'week', true]);
      assert.equal(store.getState().habits.length, 2);
    });
  });

  check('edit a habit: id, start date and order never change', async ({ store, holds, habit }) => {
    const id = store.saveHabit(WATER);
    const before = habit(id);
    const same = store.saveHabit({ id, name: 'Tea', period: 'week', target: 5, unit: '', times: [], created: '2001-01-01', order: 99 });
    assert.equal(same, id);
    await holds(() => {
      const { updatedAt, ...rest } = habit(id);
      const { updatedAt: savedBefore, ...old } = before;
      assert.deepEqual(rest, { ...old, name: 'Tea', period: 'week', target: 5, unit: '', times: [] });
      assert.ok(updatedAt >= savedBefore);
      assert.equal(store.getState().habits.length, 1);
    });
  });

  check('saveHabit: an unknown id throws "not-found"; a new habit takes only the editor fields from the input', async ({ store, today, holds, habit }) => {
    assert.throws(() => store.saveHabit({ ...WATER, id: UNKNOWN_ID }), fails('not-found'));
    const id = store.saveHabit({ ...WATER, created: '2001-01-01', order: 99, archived: true, deletedAt: 5, updatedAt: 5, colour: 'red' });
    await holds(() => {
      assert.deepEqual(store.getState().habits.map((h) => h.id), [id]);
      const { updatedAt, ...rest } = habit(id);
      assert.deepEqual(rest, { id, ...WATER, created: today, archived: false, deletedAt: null, order: 1 });
      assert.ok(updatedAt > 5);
    });
  });

  check('updatedAt is set again on every save', async ({ store, holds, habit, advance, t }) => {
    if (!advance) return t.skip('makeStore returned no advance(ms), so the clock cannot be moved');
    const id = store.saveHabit(WATER);
    const saved = [habit(id).updatedAt];
    for (const name of ['Tea', 'Coffee']) {
      advance(1000);
      store.saveHabit({ ...WATER, id, name });
      saved.push(habit(id).updatedAt);
    }
    assert.ok(saved[1] - saved[0] >= 1000 && saved[2] - saved[1] >= 1000, `updatedAt after each save: ${saved}`);
    await holds(() => assert.equal(habit(id).updatedAt, saved[2]));
  });

  check('order: delete, create, restore gives three different orders and the restored habit keeps its own', async ({ store, holds }) => {
    const first = store.saveHabit(WATER);
    const deleted = store.saveHabit({ ...WATER, name: 'Deleted, then restored' });
    store.deleteHabit(deleted);
    const created = store.saveHabit({ ...WATER, name: 'Created meanwhile' });
    store.restoreHabit(deleted);
    await holds(() => assert.deepEqual(store.getState().habits.map((h) => [h.id, h.order]), [[first, 1], [deleted, 2], [created, 3]]));
  });

  check('delete hides the habit and keeps its counts; restore brings it back', async ({ store, today, holds, habit, count }) => {
    const id = store.saveHabit(WATER);
    const other = store.saveHabit({ ...WATER, name: 'Other' });
    const { order } = habit(id);
    store.addCount(today, id, 1);
    store.deleteHabit(id);
    await holds(() => {
      assert.deepEqual(store.getState().habits.map((h) => h.id), [other]);
      assert.equal(count(id), 1);
    });
    store.restoreHabit(id);
    await holds(() => {
      assert.deepEqual(store.getState().habits.map((h) => h.id), [id, other]);
      assert.deepEqual([habit(id).deletedAt, habit(id).order, count(id)], [null, order, 1]);
    });
  });

  check('+1 and -1 today; a count never goes below 0', async ({ store, today, holds, count }) => {
    const id = store.saveHabit(WATER);
    const other = store.saveHabit({ ...WATER, name: 'Other' });
    const steps = [[1, 1], [1, 2], [-1, 1], [-1, 0], [-1, 0], [1, 1]];
    for (const [delta, shown] of steps) {
      store.addCount(today, id, delta);
      await holds(() => {
        assert.equal(count(id), shown);
        const stored = store.getState().logs[monthId(today)]?.[today]?.[id] ?? 0;
        assert.ok(stored >= 0, 'a -1 at 0 must not be sent');
        assert.equal(count(other), 0);
      });
    }
  });

  check('the last 7 days can be logged; a future day and a day 8 days back are refused', async ({ store, today, holds, habit, count }) => {
    const id = store.saveHabit(WATER);
    const [weekAgo, tooOld, tomorrow] = [addDays(today, -LIMITS.backDays), addDays(today, -LIMITS.backDays - 1), addDays(today, 1)];
    for (const day of [tooOld, tomorrow]) store.addCount(day, id, 1);
    await holds(() => {
      assert.deepEqual([count(id, tooOld), count(id, tomorrow), habit(id).created], [0, 0, today]);
    });
    store.addCount(weekAgo, id, 1);
    await holds(() => assert.deepEqual([count(id, weekAgo), count(id, today)], [1, 0]));
  });

  check('a count before the start date leaves the habit alone; startDay() and stats() pick it up', async ({ store, today, holds, habit }) => {
    const id = store.saveHabit(WATER);
    const [before, threeBack] = [habit(id), addDays(today, -3)];
    const firstDayAndPeriods = () => [startDay(habit(id), store.getState().logs), stats(habit(id), store.getState().logs, today).periods];
    store.addCount(today, id, 1);
    await holds(() => assert.deepEqual([habit(id), ...firstDayAndPeriods()], [before, today, 1]));
    store.addCount(threeBack, id, 1);
    await holds(() => assert.deepEqual([habit(id), ...firstDayAndPeriods()], [before, threeBack, 4]));
    store.addCount(threeBack, id, -1);
    await holds(() => assert.deepEqual([habit(id), ...firstDayAndPeriods()], [before, today, 1]));
  });

  check('five quick taps count 5 at once, and no listener ever sees the count go down', async ({ store, today, holds, settle, count }) => {
    const id = store.saveHabit(WATER);
    await settle();
    const seen = [];
    store.subscribe((state) => seen.push(countOn(state.logs, id, today)));
    for (let taps = 1; taps <= 5; taps++) {
      store.addCount(today, id, 1);
      assert.equal(count(id), taps);
    }
    await holds(() => assert.equal(count(id), 5));
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `counts seen, in order: ${seen}`);
    assert.deepEqual([seen[0], seen.at(-1)], [0, 5]);
  });

  check('quick save, edit, delete, restore: no listener ever sees an earlier step come back', async ({ store, holds, habit }) => {
    const seen = [];
    store.subscribe((state) => seen.push(state));
    const id = store.saveHabit(WATER);
    store.saveHabit({ ...WATER, id, name: 'Tea' });
    store.deleteHabit(id);
    store.restoreHabit(id);
    await holds(() => assert.equal(habit(id)?.name, 'Tea'));
    const names = seen.map((state) => state.habits.find((h) => h.id === id)?.name ?? null);
    const steps = names.filter((name, i) => name !== names[i - 1]);
    assert.deepEqual(steps, [null, 'Water', 'Tea', null, 'Tea'], `the habit as listeners saw it: ${names}`);
  });

  check('ignored calls change nothing and tell no listener', async ({ store, today, settle }) => {
    const id = store.saveHabit(WATER);
    const gone = store.saveHabit({ ...WATER, name: 'Gone' });
    store.addCount(today, gone, 1);
    store.deleteHabit(gone);
    await settle();
    let calls = 0;
    store.subscribe(() => calls++);
    const before = store.getState();
    const ignored = {
      'delta 0': () => store.addCount(today, id, 0),
      'delta 2': () => store.addCount(today, id, 2),
      '-1 at 0': () => store.addCount(today, id, -1),
      'a day that is not a day key': () => store.addCount('yesterday', id, 1),
      'a day key in another form': () => store.addCount(today.replaceAll('-', '/'), id, 1),
      'tomorrow': () => store.addCount(addDays(today, 1), id, 1),
      'a count for an unknown habit': () => store.addCount(today, UNKNOWN_ID, 1),
      'a count for a deleted habit': () => store.addCount(today, gone, 1),
      'deleting an unknown habit': () => store.deleteHabit(UNKNOWN_ID),
      'restoring an unknown habit': () => store.restoreHabit(UNKNOWN_ID),
    };
    for (const [name, call] of Object.entries(ignored)) {
      call();
      assert.equal(store.getState(), before, `${name}: the state object is the same`);
      assert.equal(calls, 1, `${name}: no listener call`);
    }
    await settle();
    assert.deepEqual(store.getState(), before);
  });

  check('setTimeZone changes only the zone of the user', async ({ store, holds }) => {
    const { uid, email } = store.getState().user;
    const zone = anotherZone(store);
    store.setTimeZone(zone);
    await holds(() => assert.deepEqual(store.getState().user, { uid, email, tz: zone }));
  });

  check('every change reaches listeners, at once and before the call returns', async ({ store, today, settle }) => {
    const seen = [];
    const unsubscribe = store.subscribe((state) => seen.push(state));
    assert.deepEqual(seen, [store.getState()], 'subscribe calls the listener at once');
    let id;
    const changes = {
      create: () => { id = store.saveHabit(WATER); },
      edit: () => store.saveHabit({ ...WATER, id, target: 4 }),
      '+1': () => store.addCount(today, id, 1),
      '-1': () => store.addCount(today, id, -1),
      delete: () => store.deleteHabit(id),
      restore: () => store.restoreHabit(id),
      zone: () => store.setTimeZone(anotherZone(store)),
    };
    for (const [name, change] of Object.entries(changes)) {
      const calls = seen.length, before = store.getState();
      change();
      assert.ok(seen.length > calls, `${name}: listener called before the call returned`);
      assert.notEqual(store.getState(), before, `${name}: a new state`);
      assert.equal(seen.at(-1), store.getState(), `${name}: listener got the current state`);
      await settle();
      assert.equal(seen.at(-1), store.getState(), `${name}: listener still has the current state`);
    }
    unsubscribe();
    const calls = seen.length;
    store.addCount(today, id, 1);
    await settle();
    assert.equal(seen.length, calls, 'no calls after unsubscribe');
  });

  check('invalid habits throw StoreError "invalid" and change nothing', async ({ store, holds, habit }) => {
    const id = store.saveHabit(WATER);
    const before = habit(id);
    const bad = [{ name: '   ' }, { name: 'x'.repeat(LIMITS.nameMax + 1) }, { target: 0 }, { target: LIMITS.targetMax + 1 },
      { target: 'lots' }, { unit: 'x'.repeat(LIMITS.unitMax + 1) }, { name: '', target: 0 }];
    for (const change of bad) {
      for (const input of [{ ...WATER, ...change }, { ...WATER, ...change, id }]) {
        assert.throws(() => store.saveHabit(input), (err) => fails('invalid')(err)
          && Array.isArray(err.details) && err.details.length > 0 && err.message === err.details[0], JSON.stringify(input));
      }
    }
    assert.throws(() => store.saveHabit({}), fails('invalid'));
    assert.equal(store.saveHabit({ ...WATER, name: 'x'.repeat(LIMITS.nameMax), target: LIMITS.targetMax }).length, 20);
    await holds(() => {
      assert.equal(store.getState().habits.length, 2);
      assert.deepEqual(habit(id), before);
    });
  });

  check(`at most ${LIMITS.habitsMax} live habits: one more, created or restored, throws StoreError "too-many"`, async ({ store, holds }) => {
    const ids = Array.from({ length: LIMITS.habitsMax }, (_, i) => store.saveHabit({ ...WATER, name: `Habit ${i + 1}` }));
    assert.equal(new Set(ids).size, LIMITS.habitsMax);
    assert.throws(() => store.saveHabit(WATER), fails('too-many'));
    store.saveHabit({ ...WATER, id: ids[0], name: 'Editing is still allowed' });
    await holds(() => assert.equal(store.getState().habits.length, LIMITS.habitsMax));
    store.deleteHabit(ids[0]);
    store.saveHabit({ ...WATER, name: 'Fits again' });
    await holds(() => {
      const names = store.getState().habits.map((h) => h.name);
      assert.deepEqual([names.length, names[0], names.at(-1)], [LIMITS.habitsMax, 'Habit 2', 'Fits again']);
    });
    assert.throws(() => store.restoreHabit(ids[0]), fails('too-many'));
    await holds(() => assert.deepEqual(store.getState().habits.map((h) => h.id).slice(0, 2), [ids[1], ids[2]]));
    store.deleteHabit(ids[1]);
    store.restoreHabit(ids[0]);
    await holds(() => {
      const live = store.getState().habits.map((h) => h.id);
      assert.deepEqual([live.length, live[0], live[1]], [LIMITS.habitsMax, ids[0], ids[2]]);
    });
  });

  check('state objects are replaced, never mutated', async ({ store, today, settle }) => {
    let id;
    const changes = [
      () => { id = store.saveHabit(WATER); },
      () => store.saveHabit({ ...WATER, id, name: 'Tea' }),
      () => store.addCount(today, id, 1),
      () => store.addCount(addDays(today, -2), id, 1),
      () => store.addCount(today, id, -1),
      () => store.deleteHabit(id),
      () => store.restoreHabit(id),
      () => store.setTimeZone(anotherZone(store)),
    ];
    const earlier = [];
    for (const change of changes) {
      const before = store.getState();
      earlier.push([before, structuredClone(before)]);
      change();
      assert.notEqual(store.getState(), before);
      await settle();
      for (const [state, copy] of earlier) assert.deepEqual(state, copy);
    }
  });

  check('sign-out clears the data from the state', async ({ store, today, settle }) => {
    const id = store.saveHabit(WATER);
    store.addCount(today, id, 1);
    await settle();
    const seen = [];
    store.subscribe((state) => seen.push(state.status));
    await store.signOut();
    const { status, user, habits, logs } = store.getState();
    assert.deepEqual({ status, user, habits, logs }, { status: 'signedOut', user: null, habits: [], logs: {} });
    assert.equal(seen.at(-1), 'signedOut');
  });
}
