// Security rules against the Firestore emulator (work package B2). Run with `npm run test:emulator`.
// The numbered groups follow the acceptance checks for B2 in docs/plan.md.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, increment, query, setDoc, setLogLevel, Timestamp,
  updateDoc, where,
} from 'firebase/firestore';

setLogLevel('error'); // a refused request is expected here; do not print a warning for each one

const file = (name) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');

// alice and bob are invited; carol has an account but is not on the list.
const INVITE_LINE = /^.*\/\/ @invite-list$/gm;
const rules = file('firestore.rules')
  .replace(INVITE_LINE, "function invited() { return ['alice', 'bob']; } // @invite-list");

const HABIT = 'habit000000000000001'; // 20 letters or digits, like the ids the store makes
const MONTH = '2026-11';
const NOW = 1794000000000;
const ALL_TIMES = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

const habit = (over = {}) => ({
  name: 'Drink water', period: 'day', target: 8, unit: 'glasses', times: ['09:00', '13:30'],
  created: '2026-11-02', archived: false, deletedAt: null, order: 1, updatedAt: NOW, ...over,
});
const without = (obj, key) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
const account = (over = {}) => ({ tz: 'Europe/London', createdAt: NOW, updatedAt: NOW, ...over });
const device = (uid, over = {}) => ({ uid, ua: 'Chrome on Android', updatedAt: NOW, ...over });
// The exact write the app makes for one tap.
const tap = (db, uid, day, habitId = HABIT, delta = 1, month = day.slice(0, 7)) =>
  setDoc(doc(db, `users/${uid}/logs/${month}`), { days: { [day]: { [habitId]: increment(delta) } } }, { merge: true });

let env, alice, bob, carol, visitor;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-habit-tally',
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });
  alice = env.authenticatedContext('alice').firestore();
  bob = env.authenticatedContext('bob').firestore();
  carol = env.authenticatedContext('carol').firestore();
  visitor = env.unauthenticatedContext().firestore();
});
beforeEach(() => env.clearFirestore());
after(() => env.cleanup());

/** Writes documents past the rules: { path: data }. */
const seed = (docs) => env.withSecurityRulesDisabled(async (ctx) => {
  for (const [path, data] of Object.entries(docs)) await setDoc(doc(ctx.firestore(), path), data);
});
/** Reads one document past the rules: its data, or null when it does not exist. */
async function stored(path) {
  let snap;
  await env.withSecurityRulesDisabled(async (ctx) => { snap = await getDoc(doc(ctx.firestore(), path)); });
  return snap.exists() ? snap.data() : null;
}
const seedUser = (uid) => seed({
  [`users/${uid}`]: account(),
  [`users/${uid}/habits/${HABIT}`]: habit(),
  [`users/${uid}/logs/${MONTH}`]: { days: { '2026-11-12': { [HABIT]: 3 } } },
  [`devices/fid-${uid}`]: device(uid),
});

/** Every kind of request on one user's data, in an order that works when all are allowed. */
function userOps(db, uid) {
  const u = `users/${uid}`, h = `${u}/habits/${HABIT}`, l = `${u}/logs/${MONTH}`;
  return [
    ['get account', () => getDoc(doc(db, u))],
    ['set account', () => setDoc(doc(db, u), account())],
    ['update account', () => updateDoc(doc(db, u), { tz: 'Africa/Cairo', updatedAt: NOW + 1 })],
    ['get habit', () => getDoc(doc(db, h))],
    ['set habit', () => setDoc(doc(db, h), habit())],
    ['update habit', () => updateDoc(doc(db, h), { target: 9, updatedAt: NOW + 1 })],
    ['list habits', () => getDocs(collection(db, `${u}/habits`))],
    ['get log', () => getDoc(doc(db, l))],
    ['count', () => tap(db, uid, '2026-11-13')],
    ['list logs', () => getDocs(collection(db, `${u}/logs`))],
    ['delete habit', () => deleteDoc(doc(db, h))],
    ['delete log', () => deleteDoc(doc(db, l))],
    ['delete account', () => deleteDoc(doc(db, u))],
  ];
}
/** Every kind of request on one device record, written with `uid`. */
const deviceOps = (db, fid, uid) => [
  ['get device', () => getDoc(doc(db, `devices/${fid}`))],
  ['set device', () => setDoc(doc(db, `devices/${fid}`), device(uid))],
  ['delete device', () => deleteDoc(doc(db, `devices/${fid}`))],
  ['list devices', () => getDocs(collection(db, 'devices'))],
  ['query devices', () => getDocs(query(collection(db, 'devices'), where('uid', '==', uid)))],
];
const named = (label, promise) => promise.catch((e) => { throw new Error(`${label}: ${e.message}`); });
async function allRefused(ops) { for (const [label, run] of ops) await named(label, assertFails(run())); }
async function allAllowed(ops) { for (const [label, run] of ops) await named(label, assertSucceeds(run())); }

describe('1. own data only', () => {
  test('an invited user reads and writes their own account record, habits and logs', async () => {
    await allAllowed(userOps(alice, 'alice'));
  });

  test('an invited user is refused every read and write on another user\'s data', async () => {
    await seedUser('bob');
    await allRefused(userOps(alice, 'bob'));
    assert.deepEqual(await stored(`users/bob/habits/${HABIT}`), habit());
    await allRefused(userOps(alice, 'nobody-yet')); // also where nothing is stored
  });

  test('a signed-out visitor is refused everywhere', async () => {
    await seedUser('alice');
    await allRefused([...userOps(visitor, 'alice'), ...deviceOps(visitor, 'fid-alice', 'alice'),
      ...deviceOps(visitor, 'fid-new', 'alice')]);
  });

  test('a signed-in account that is not invited is refused everywhere, also on its own record', async () => {
    await allRefused([...userOps(carol, 'carol'), ...deviceOps(carol, 'fid-new', 'carol')]); // nothing stored yet
    await seedUser('carol');
    await seedUser('alice');
    await allRefused([...userOps(carol, 'carol'), ...deviceOps(carol, 'fid-carol', 'carol'),
      ...userOps(carol, 'alice'), ...deviceOps(carol, 'fid-alice', 'carol')]);
  });

  test('nobody can list the accounts', async () => {
    await seedUser('alice');
    for (const db of [alice, carol, visitor]) await assertFails(getDocs(collection(db, 'users')));
  });
});

describe('2. queries across users', () => {
  test('a collection-group query over all habits or logs is refused, also for an invited user', async () => {
    await seedUser('alice');
    for (const db of [alice, carol, visitor]) {
      await assertFails(getDocs(collectionGroup(db, 'habits')));
      await assertFails(getDocs(query(collectionGroup(db, 'habits'), where('archived', '==', false))));
      await assertFails(getDocs(collectionGroup(db, 'logs')));
    }
  });
});

describe('3. habits', () => {
  const ref = (id = HABIT) => doc(alice, `users/alice/habits/${id}`);

  test('a valid create and a valid full update are allowed', async () => {
    await assertSucceeds(setDoc(ref(), habit()));
    const edited = habit({ name: 'Walk', period: 'week', target: 3, unit: '', times: [], updatedAt: NOW + 5 });
    await assertSucceeds(setDoc(ref(), edited));
    assert.deepEqual(await stored(`users/alice/habits/${HABIT}`), edited);
  });

  test('the limits themselves are allowed: target 1 and 50, name 60, unit 20, all 48 times', async () => {
    await assertSucceeds(setDoc(ref(), habit({ target: 1, name: 'x'.repeat(60), unit: 'u'.repeat(20) })));
    await assertSucceeds(setDoc(ref(), habit({ target: 50, times: ALL_TIMES })));
  });

  test('a soft delete (deletedAt a number) and a restore (deletedAt null) are allowed', async () => {
    await assertSucceeds(setDoc(ref(), habit()));
    await assertSucceeds(updateDoc(ref(), { deletedAt: NOW + 1, updatedAt: NOW + 1 }));
    assert.equal((await stored(`users/alice/habits/${HABIT}`)).deletedAt, NOW + 1);
    await assertSucceeds(setDoc(ref(), { deletedAt: null, updatedAt: NOW + 2 }, { merge: true }));
    assert.deepEqual(await stored(`users/alice/habits/${HABIT}`), habit({ updatedAt: NOW + 2 }));
  });

  const INVALID = {
    'target 0': { target: 0 },
    'target 51': { target: 51 },
    'a non-integer target': { target: 2.5 },
    'a target that is text': { target: '8' },
    'an empty name': { name: '' },
    'a name of only spaces': { name: '   ' },
    'a name of 61 characters': { name: 'x'.repeat(61) },
    'a name that is not text': { name: 8 },
    'a name that is a list': { name: ['Drink water'] },
    'a unit of 21 characters': { unit: 'u'.repeat(21) },
    'a unit that is not text': { unit: null },
    'a unit that is a list': { unit: ['glasses'] },
    '49 times': { times: [...ALL_TIMES, '09:00'] },
    'times that are not a list (text)': { times: '09:00' },
    'times that are not a list (map)': { times: { 0: '09:00' } },
    'a time off the half hour': { times: ['09:15'] },
    'a time that is not HH:MM': { times: ['9:00'] },
    'a time after 23:30': { times: ['24:00'] },
    'a time listed twice': { times: ['09:00', '09:00'] },
    'a time that is a number': { times: [900] },
    'two times hidden in one item': { times: ['09:00,09:30'] },
    'two times hidden in one item beside an empty one': { times: ['', '09:00,09:30'] },
    'a wrong period': { period: 'month' },
    'a period that is not text': { period: 7 },
    'a created that is not a day': { created: '2026-11' },
    'a created that is a number': { created: 20261102 },
    'an archived that is not true or false': { archived: 'no' },
    'a deletedAt that is text': { deletedAt: 'yesterday' },
    'a deletedAt that is not a whole number': { deletedAt: 1.5 },
    'an order that is not a number': { order: 'first' },
    'an updatedAt that is not a number': { updatedAt: '2026-11-13' },
    'an updatedAt that is a Firestore Timestamp': { updatedAt: Timestamp.fromMillis(NOW) },
    'an unknown extra field': { colour: 'red' },
    'the id stored as a field': { id: HABIT },
  };
  for (const [label, over] of Object.entries(INVALID)) {
    test(`refused: ${label}`, async () => {
      await assertFails(setDoc(ref(), habit(over))); // as a create
      assert.equal(await stored(`users/alice/habits/${HABIT}`), null);
      await seed({ [`users/alice/habits/${HABIT}`]: habit() });
      await assertFails(setDoc(ref(), habit(over))); // as a full update
      await assertFails(setDoc(ref(), over, { merge: true })); // as a partial update
      assert.deepEqual(await stored(`users/alice/habits/${HABIT}`), habit());
    });
  }

  test('refused: a habit with any one of the ten fields missing', async () => {
    const fields = Object.keys(habit());
    assert.equal(fields.length, 10);
    for (const field of fields) await named(field, assertFails(setDoc(ref(), without(habit(), field))));
  });

  test('refused: a partial merge write to a habit that does not exist; no document is created', async () => {
    await assertFails(setDoc(ref(), { deletedAt: NOW, updatedAt: NOW }, { merge: true }));
    await assertFails(setDoc(ref(), { created: '2026-11-01' }, { merge: true }));
    await assertFails(updateDoc(ref(), { target: 9 }));
    assert.equal(await stored(`users/alice/habits/${HABIT}`), null);
  });

  test('refused: a habit id that is not 20 letters or digits', async () => {
    for (const id of ['short', 'habit-00000000000001', 'habit0000000000000012']) {
      await named(id, assertFails(setDoc(ref(id), habit())));
    }
  });
});

describe('4. logs and the account record', () => {
  const log = (month = MONTH) => doc(alice, `users/alice/logs/${month}`);

  test('the increment merge write is allowed on a new month document', async () => {
    await assertSucceeds(tap(alice, 'alice', '2026-11-13'));
    assert.deepEqual(await stored(`users/alice/logs/${MONTH}`), { days: { '2026-11-13': { [HABIT]: 1 } } });
  });

  test('the increment merge write is allowed on an existing month document and keeps the rest', async () => {
    await seed({ [`users/alice/logs/${MONTH}`]: { days: { '2026-11-12': { [HABIT]: 3 } } } });
    await assertSucceeds(tap(alice, 'alice', '2026-11-12'));
    await assertSucceeds(tap(alice, 'alice', '2026-11-13'));
    await assertSucceeds(tap(alice, 'alice', '2026-11-13', 'habit000000000000002'));
    await assertSucceeds(tap(alice, 'alice', '2026-11-13', HABIT, -1));
    assert.deepEqual(await stored(`users/alice/logs/${MONTH}`), {
      days: { '2026-11-12': { [HABIT]: 4 }, '2026-11-13': { [HABIT]: 0, habit000000000000002: 1 } },
    });
  });

  test('refused: a log document with any key other than days', async () => {
    const days = { '2026-11-13': { [HABIT]: 1 } };
    await assertFails(setDoc(log(), { days, note: 'x' }));
    await assertFails(setDoc(log(), { '2026-11-13': { [HABIT]: 1 } }));
    await assertFails(setDoc(log(), {}));
    assert.equal(await stored(`users/alice/logs/${MONTH}`), null);
    await seed({ [`users/alice/logs/${MONTH}`]: { days } });
    await assertFails(setDoc(log(), { note: 'x' }, { merge: true }));
    await assertFails(updateDoc(log(), { total: increment(1) }));
    assert.deepEqual(await stored(`users/alice/logs/${MONTH}`), { days });
  });

  test('a month of 31 days is allowed; a 32nd key in days is refused', async () => {
    const days = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`2026-12-${String(i + 1).padStart(2, '0')}`,
      { [HABIT]: 1 }]));
    await assertFails(setDoc(log('2026-12'), { days: days(32) }));
    await assertSucceeds(setDoc(log('2026-12'), { days: days(31) }));
    await assertSucceeds(tap(alice, 'alice', '2026-12-31'));
    await assertFails(tap(alice, 'alice', '2026-12-32'));
    await assertFails(setDoc(log('2026-12'), { days: { junk: { [HABIT]: 1 } } }, { merge: true }));
    assert.deepEqual(await stored('users/alice/logs/2026-12'), { days: { ...days(31), '2026-12-31': { [HABIT]: 2 } } });
  });

  test('refused: days that is not a map, and a month id that is not YYYY-MM', async () => {
    await assertFails(setDoc(log(), { days: 3 }));
    await assertFails(setDoc(log(), { days: ['2026-11-13'] }));
    await assertFails(tap(alice, 'alice', '2026-11-13', HABIT, 1, 'november'));
    await assertFails(tap(alice, 'alice', '2026-11-13', HABIT, 1, '2026-11-13'));
  });

  test('the account record is exactly tz, createdAt, updatedAt', async () => {
    const me = doc(alice, 'users/alice');
    await assertSucceeds(setDoc(me, account()));
    await assertSucceeds(updateDoc(me, { tz: 'Asia/Kathmandu', updatedAt: NOW + 1 }));
    const bad = [account({ email: 'a@example.com' }), account({ uid: 'alice' }), without(account(), 'tz'),
      without(account(), 'createdAt'), without(account(), 'updatedAt'), account({ tz: 7 }), account({ tz: '' }),
      account({ tz: 'x'.repeat(65) }), account({ createdAt: 'today' }), account({ updatedAt: Timestamp.fromMillis(NOW) })];
    for (const data of bad) await named(JSON.stringify(data), assertFails(setDoc(me, data)));
    await assertFails(setDoc(me, { invited: true }, { merge: true }));
    assert.deepEqual(await stored('users/alice'), account({ tz: 'Asia/Kathmandu', updatedAt: NOW + 1 }));
    await assertFails(setDoc(doc(bob, 'users/bob'), { tz: 'Europe/London' }, { merge: true })); // partial create
    assert.equal(await stored('users/bob'), null);
  });
});

describe('5. devices', () => {
  const dev = (db, fid = 'fid-1') => doc(db, `devices/${fid}`);

  test('a user can create and refresh a device record with their own uid', async () => {
    await assertSucceeds(setDoc(dev(alice), device('alice')));
    await assertSucceeds(setDoc(dev(alice), device('alice', { updatedAt: NOW + 1 })));
    assert.deepEqual(await stored('devices/fid-1'), device('alice', { updatedAt: NOW + 1 }));
  });

  test('a user can take over a record that belongs to someone else, only by setting their own uid', async () => {
    await seed({ 'devices/fid-1': device('bob') });
    await assertFails(setDoc(dev(alice), device('bob', { updatedAt: NOW + 1 }))); // still bob's
    await assertFails(updateDoc(dev(alice), { ua: 'changed' })); // still bob's
    await assertSucceeds(setDoc(dev(alice), device('alice')));
    assert.equal((await stored('devices/fid-1')).uid, 'alice');
    await assertFails(getDoc(dev(bob))); // the previous owner has lost it
    await assertFails(deleteDoc(dev(bob)));
  });

  test('refused: writing a record with another uid, new or over your own', async () => {
    await assertFails(setDoc(dev(alice), device('bob')));
    await assertFails(setDoc(dev(alice), device('carol')));
    await seed({ 'devices/fid-1': device('alice') });
    await assertFails(setDoc(dev(alice), device('bob'))); // giving it away
    await assertFails(updateDoc(dev(alice), { uid: 'bob' }));
    assert.deepEqual(await stored('devices/fid-1'), device('alice'));
  });

  test('get and delete work only on a record the user owns', async () => {
    await seed({ 'devices/fid-1': device('alice'), 'devices/fid-2': device('bob') });
    assert.deepEqual((await assertSucceeds(getDoc(dev(alice)))).data(), device('alice'));
    await assertFails(getDoc(dev(alice, 'fid-2')));
    await assertFails(deleteDoc(dev(alice, 'fid-2')));
    await assertFails(getDoc(dev(alice, 'fid-none'))); // nothing stored: no owner, so refused
    await assertFails(deleteDoc(dev(alice, 'fid-none')));
    await assertSucceeds(deleteDoc(dev(alice)));
    assert.equal(await stored('devices/fid-1'), null);
    assert.deepEqual(await stored('devices/fid-2'), device('bob'));
  });

  test('refused: listing devices, even only your own', async () => {
    await seed({ 'devices/fid-1': device('alice') });
    await assertFails(getDocs(collection(alice, 'devices')));
    await assertFails(getDocs(query(collection(alice, 'devices'), where('uid', '==', 'alice'))));
  });

  test('a device id is 1 to 64 letters, digits, _ or -', async () => {
    for (const fid of ['dK3_pX-9aB7cD1eF2gH3iJ', 'a', 'a'.repeat(64)]) {
      await named(fid, assertSucceeds(setDoc(dev(alice, fid), device('alice'))));
    }
    for (const fid of ['a'.repeat(65), 'fid 1', 'fid-\u00e9', 'fid.1', 'fid:1']) {
      await named(fid, assertFails(setDoc(dev(alice, fid), device('alice'))));
      assert.equal(await stored(`devices/${fid}`), null);
    }
  });

  test('refused: extra, missing or wrongly typed device fields', async () => {
    const bad = [device('alice', { token: 'abc' }), without(device('alice'), 'ua'), without(device('alice'), 'updatedAt'),
      without(device('alice'), 'uid'), device('alice', { ua: 7 }), device('alice', { ua: 'x'.repeat(501) }),
      device('alice', { updatedAt: 'now' }), device('alice', { updatedAt: Timestamp.fromMillis(NOW) })];
    for (const data of bad) await named(JSON.stringify(data), assertFails(setDoc(dev(alice), data)));
    await assertFails(setDoc(dev(alice), { uid: 'alice' }, { merge: true }));
    assert.equal(await stored('devices/fid-1'), null);
  });
});

describe('6. system and every other path', () => {
  const OTHER = ['system/reminders', 'system/other', 'system/reminders/sub/x', 'other/x', 'habits/x', 'logs/2026-11',
    'users/alice/other/x', `users/alice/habits/${HABIT}/sub/x`, 'devices/fid-alice/sub/x'];

  test('system/reminders and any other path cannot be read or written by any client', async () => {
    await seedUser('alice');
    await seed(Object.fromEntries(OTHER.map((path) => [path, { lastSlot: NOW, updatedAt: NOW }])));
    for (const [who, db] of Object.entries({ alice, carol, visitor })) {
      for (const path of OTHER) {
        const parent = path.slice(0, path.lastIndexOf('/'));
        await allRefused([
          [`${who} get ${path}`, () => getDoc(doc(db, path))],
          [`${who} list ${parent}`, () => getDocs(collection(db, parent))],
          [`${who} set ${path}`, () => setDoc(doc(db, path), { lastSlot: 0, updatedAt: 0 })],
          [`${who} merge ${path}`, () => setDoc(doc(db, path), { lastSlot: 0 }, { merge: true })],
          [`${who} delete ${path}`, () => deleteDoc(doc(db, path))],
        ]);
      }
    }
    assert.deepEqual(await stored('system/reminders'), { lastSlot: NOW, updatedAt: NOW });
  });
});

describe('7. project files', () => {
  test('firestore.rules is version 2 and has the invite list on one marked line', () => {
    const text = file('firestore.rules');
    assert.match(text, /^rules_version = '2';$/m);
    const lines = text.match(INVITE_LINE);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\s*function invited\(\) \{ return \[('[^']+'(, '[^']+')*)?\]; \} \/\/ @invite-list$/);
    assert.equal(rules.match(INVITE_LINE).length, 1);
    assert.ok(rules.includes("return ['alice', 'bob'];") && !rules.includes('REPLACE_AT_GO_LIVE'));
  });

  test('firestore.indexes.json has no indexes', () => {
    assert.deepEqual(JSON.parse(file('firestore.indexes.json')), { indexes: [], fieldOverrides: [] });
  });

  test('firebase.json serves dist; only /assets/** may be cached, every other path is no-cache', () => {
    const cfg = JSON.parse(file('firebase.json'));
    assert.equal(cfg.hosting.public, 'dist');
    // A missing file under /assets/ must be a 404, not index.html cached for a year.
    assert.deepEqual(cfg.hosting.rewrites, [{ source: '!/assets/**', destination: '/index.html' }]);
    // Hosting matches header rules against the request path, before rewrites, and applies every matching
    // rule in the order written, so for one header the last matching rule wins.
    const cacheControl = (path) => {
      const sent = {};
      for (const rule of cfg.hosting.headers) {
        if (!matchesGlob(path, rule.source.startsWith('/') ? rule.source : `/${rule.source}`)) continue;
        for (const { key, value } of rule.headers) sent[key.toLowerCase()] = value;
      }
      return sent['cache-control'];
    };
    assert.ok(cfg.hosting.headers.every((rule) => typeof rule.source === 'string'));
    for (const path of ['/', '/index.html', '/sw.js', '/settings', '/habit/abc/edit', '/manifest.webmanifest']) {
      assert.equal(cacheControl(path), 'no-cache', path);
    }
    for (const path of ['/assets/index-ea-HuSDn.js', '/assets/styles-B1x2.css']) {
      assert.equal(cacheControl(path), 'public, max-age=31536000, immutable', path);
    }
    assert.equal(cfg.firestore.rules, 'firestore.rules');
    assert.equal(cfg.firestore.indexes, 'firestore.indexes.json');
    assert.equal(cfg.auth.providers.emailPassword, true);
    assert.deepEqual(cfg.emulators.firestore, { host: '127.0.0.1', port: 8080 });
    assert.deepEqual(cfg.emulators.auth, { host: '127.0.0.1', port: 9099 });
  });
});
