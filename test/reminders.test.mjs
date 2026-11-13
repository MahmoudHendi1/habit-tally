// Tests for scripts/send-reminders.mjs. No network: run() is driven with an in-memory stand-in for the `google`
// object of scripts/lib/google.mjs, and the command itself is only started with a missing or unusable key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../scripts/send-reminders.mjs';
import { GoogleError, PreconditionError } from '../scripts/lib/google.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/send-reminders.mjs', import.meta.url));
const BOOKMARK = 'system/reminders';
const SLOT = 30 * 60 * 1000;
const EMAIL = 'alice.owner@example.test';
/** 13 Nov 2026 (a Friday) at h:m UTC, or another day and month (0 = January). */
const at = (h, m = 0, day = 13, month = 10) => Date.UTC(2026, month, day, h, m);

// Every line the job logs in any test, and every string that must never be in one (test 9).
const logged = [];
const sensitive = new Set([EMAIL]);
const log = (line) => {
  assert.equal(typeof line, 'string');
  logged.push(line);
};

/** Stand-in for Firestore and FCM: documents in a map, a new updateTime on every write, preconditions enforced
 *  like the real client, a list of the pushes accepted, and switches to make calls fail. */
function createWorld(from) {
  const docs = new Map(from ?? []); // path -> { data, updateTime }
  let writes = docs.size;
  const w = {
    docs,
    calls: [], // { op, arg, options? } in the order the job made them
    pushes: [], // { fid, data } of every push answered 'sent'
    billed: 0, // document reads as Firestore bills them (a read that finds nothing costs one)
    fail: () => null, // (op, arg) => an Error to throw, or null
    pushReply: () => 'sent', // (fid, data) => 'sent' | 'unregistered' | an Error to throw
    before: async () => {}, // awaited at the start of every call: lets a test interleave two runs
    put(path, data) {
      writes += 1;
      docs.set(path, { data: structuredClone(data), updateTime: new Date(at(0) + writes).toISOString() });
    },
    ops: (op) => w.calls.filter((c) => c.op === op).map((c) => c.arg),
  };
  const doc = (path) => ({
    id: path.slice(path.lastIndexOf('/') + 1), path, data: structuredClone(docs.get(path).data),
    updateTime: docs.get(path).updateTime,
  });
  const enter = async (op, arg, options) => {
    w.calls.push(options ? { op, arg, options } : { op, arg });
    await w.before(op, arg);
    const err = w.fail(op, arg);
    if (err) throw err;
  };
  const children = (col) => [...docs.keys()].filter((p) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/')).sort();
  const found = (paths) => {
    w.billed += Math.max(1, paths.length);
    return paths.map(doc);
  };
  w.google = {
    async getDoc(path) {
      await enter('getDoc', path);
      w.billed += 1;
      return docs.has(path) ? doc(path) : null;
    },
    async listDocs(col) {
      await enter('listDocs', col);
      return found(children(col));
    },
    async queryEqual(col, field, value) {
      await enter('queryEqual', `${col} ${field}`);
      return found(children(col).filter((p) => docs.get(p).data[field] === value));
    },
    async setDoc(path, data, options = {}) {
      await enter('setDoc', path, options);
      const { ifUpdateTime, ifMissing } = options;
      if (ifUpdateTime && ifMissing) throw new TypeError('Use ifUpdateTime or ifMissing, not both');
      const refused = (status, code) => new PreconditionError(`setDoc failed: HTTP ${status} ${code}`, { status, code });
      if (ifMissing && docs.has(path)) throw refused(409, 'ALREADY_EXISTS');
      if (ifUpdateTime && docs.get(path)?.updateTime !== ifUpdateTime) throw refused(400, 'FAILED_PRECONDITION');
      w.put(path, data);
      return doc(path);
    },
    async deleteDoc(path) {
      await enter('deleteDoc', path);
      docs.delete(path);
    },
    async sendPush(fid, data) {
      await enter('sendPush', fid);
      if (typeof fid !== 'string' || !fid) throw new TypeError('sendPush needs an installation id');
      if (Object.values(data).some((v) => typeof v !== 'string')) throw new TypeError('Push data must be an object of strings');
      const reply = w.pushReply(fid, data);
      if (reply instanceof Error) throw reply;
      if (reply === 'sent') w.pushes.push({ fid, data });
      return reply;
    },
  };
  return w;
}

const habit = (over = {}) => ({
  name: 'Drink water', period: 'day', target: 3, unit: '', times: ['09:00'], created: '2026-01-05',
  archived: false, deletedAt: null, order: 1, updatedAt: 1, ...over,
});

/** Adds a user: habits = { id: fields }, logs = { 'YYYY-MM-DD': { habitId: count } }, devices = ids or [id, updatedAt]. */
function addUser(w, uid, { tz = 'Europe/London', habits = {}, logs = {}, devices = [] } = {}) {
  sensitive.add(uid);
  w.put(`users/${uid}`, { tz, createdAt: 1, updatedAt: 1 });
  for (const [id, over] of Object.entries(habits)) {
    w.put(`users/${uid}/habits/${id}`, habit(over));
    if (typeof habit(over).name === 'string') sensitive.add(habit(over).name);
  }
  const months = {};
  for (const [day, counts] of Object.entries(logs)) (months[day.slice(0, 7)] ??= {})[day] = counts;
  for (const [month, days] of Object.entries(months)) w.put(`users/${uid}/logs/${month}`, { days });
  for (const d of devices) {
    const [fid, updatedAt] = [].concat(d, 1);
    sensitive.add(fid);
    w.put(`devices/${fid}`, { uid, ua: 'Chrome on Android', updatedAt });
  }
  return w;
}

/** A world whose last claimed slot is `lastSlot` (omit for "the job has never run"). */
function worldAt(lastSlot) {
  const w = createWorld();
  if (lastSlot) w.put(BOOKMARK, { lastSlot, updatedAt: lastSlot });
  return w;
}
/** One run, started four minutes before `slot` as the schedule does. */
const go = (w, slot, options = {}) => run({ google: w.google, now: slot - 4 * 60 * 1000, log, ...options });
const nothing = { slot: null, sent: 0, skipped: 0, failed: 0, removed: 0 };
const tags = (w, fid) => w.pushes.filter((p) => !fid || p.fid === fid).map((p) => p.data.tag);
const unavailable = (detail = '') => new GoogleError('call failed: HTTP 503 UNAVAILABLE', { status: 503, code: 'UNAVAILABLE', detail });

test('1. a due habit is sent to both devices of its owner with its name, progress text and id as tag', async () => {
  const w = worldAt(at(8, 30));
  addUser(w, 'uid-alice', {
    habits: { h1: { unit: 'glasses' } }, logs: { '2026-11-13': { h1: 1 } }, devices: ['fid-alice-phone', 'fid-alice-laptop'],
  });
  addUser(w, 'uid-bob', { habits: { h2: { name: 'Read a book', target: 1 } }, devices: ['fid-bob-phone'] });
  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 3, skipped: 0, failed: 0, removed: 0 });
  const data = { title: 'Drink water', body: '1 of 3 glasses done today.', tag: 'h1', url: '/' };
  assert.deepEqual(w.pushes.filter((p) => p.fid.includes('alice')), [
    { fid: 'fid-alice-laptop', data }, { fid: 'fid-alice-phone', data },
  ]);
  // a habit goes to its owner's devices only
  assert.deepEqual(w.pushes.filter((p) => p.fid === 'fid-bob-phone').map((p) => p.data),
    [{ title: 'Read a book', body: 'Not started today. Target: 1.', tag: 'h2', url: '/' }]);
});

test('2. no message: daily and weekly target hit, weekly habit logged today, archived and deleted habits', async () => {
  const sunday = Date.UTC(2026, 10, 1, 9); // 1 Nov 2026: its week began on Monday 26 October
  const w = worldAt(sunday - SLOT);
  addUser(w, 'uid-alice', {
    habits: {
      dailyHit: { name: 'Daily hit', target: 2 },
      weeklyHit: { name: 'Weekly hit', period: 'week', target: 3 },
      weeklyToday: { name: 'Weekly today', period: 'week', target: 5 },
      archived: { name: 'Archived', archived: true },
      deleted: { name: 'Deleted', deletedAt: 1793000000000 },
      weeklyOpen: { name: 'Weekly open', period: 'week', target: 3 },
    },
    logs: {
      '2026-10-27': { weeklyOpen: 2 }, '2026-10-28': { weeklyHit: 2 }, '2026-10-30': { weeklyHit: 1 },
      '2026-11-01': { dailyHit: 2, weeklyToday: 1 },
    },
    devices: ['fid-alice-phone'],
  });
  assert.deepEqual(await go(w, sunday), { slot: sunday, sent: 1, skipped: 3, failed: 0, removed: 0 });
  assert.deepEqual(w.pushes.map((p) => p.data), [{ title: 'Weekly open', body: '2 of 3 done this week.', tag: 'weeklyOpen', url: '/' }]);
  assert.deepEqual(w.ops('getDoc'), [BOOKMARK, 'users/uid-alice/logs/2026-10', 'users/uid-alice/logs/2026-11']);
});

test('3a. the same slot run twice: the second run sends nothing', async () => {
  const w = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone', 'fid-alice-laptop'] });
  assert.equal((await go(w, at(9))).sent, 2);
  assert.deepEqual(await run({ google: w.google, now: at(9, 10), log }), nothing);
  assert.equal(w.pushes.length, 2);
  assert.deepEqual(w.docs.get(BOOKMARK).data, { lastSlot: at(9), updatedAt: at(8, 56) });
});

test('3b. two runs racing for one slot: exactly one sends, the other succeeds having sent nothing', async () => {
  const w = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone', 'fid-alice-laptop'] });
  let reads = 0;
  let release;
  const bothRead = new Promise((done) => { release = done; });
  w.before = async (op, arg) => { // no claim until both runs have read the bookmark
    if (op === 'getDoc' && arg === BOOKMARK && ++reads === 2) release();
    if (op === 'setDoc') await bothRead;
  };
  const results = await Promise.all([go(w, at(9)), go(w, at(9))]);
  assert.deepEqual(results.sort((a, b) => b.sent - a.sent), [{ slot: at(9), sent: 2, skipped: 0, failed: 0, removed: 0 }, nothing]);
  assert.equal(w.pushes.length, 2);
  assert.equal(w.ops('setDoc').length, 2); // both tried; the precondition let one through

  // the run that loses reports nothing of its own, not even a read that failed
  const v = worldAt(at(8, 30));
  for (const name of ['alice', 'bob']) addUser(v, `uid-${name}`, { habits: { h1: {} }, devices: [`fid-${name}`] });
  v.fail = (op, arg) => (arg === 'users/uid-bob/habits' ? unavailable() : null);
  v.before = async (op) => { if (op === 'setDoc') v.put(BOOKMARK, { lastSlot: at(9), updatedAt: at(8, 57) }); };
  assert.deepEqual(await go(v, at(9)), nothing);
  assert.deepEqual(v.pushes, []);
});

test('3c. everything is read first, then the slot is claimed, then the first push; an empty slot is claimed too', async () => {
  const w = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone', 'fid-alice-laptop'] });
  const before = w.docs.get(BOOKMARK).updateTime;
  await go(w, at(9));
  assert.deepEqual(w.calls.map((c) => c.op),
    ['getDoc', 'listDocs', 'listDocs', 'getDoc', 'queryEqual', 'setDoc', 'sendPush', 'sendPush']);
  assert.deepEqual(w.calls[5], { op: 'setDoc', arg: BOOKMARK, options: { ifUpdateTime: before } });

  const empty = addUser(worldAt(at(8, 30)), 'uid-bob', { habits: { h1: { times: ['20:00'] } }, devices: ['fid-bob-phone'] });
  assert.deepEqual(await go(empty, at(9)), { slot: at(9), sent: 0, skipped: 0, failed: 0, removed: 0 });
  assert.equal(empty.docs.get(BOOKMARK).data.lastSlot, at(9));
});

test('4. one missed run is caught up, older slots are not replayed, the first ever run sends the current slot only', async () => {
  const habits = {
    t0730: { name: 'At 07:30', times: ['07:30'] }, t0800: { name: 'At 08:00', times: ['08:00'] },
    t0830: { name: 'At 08:30', times: ['08:30'] }, t0900: { name: 'At 09:00', times: ['09:00'] },
    both: { name: 'Both', times: ['08:30', '09:00'] },
  };
  const user = { habits, devices: ['fid-alice-phone'] };
  // the 08:30 run was missed: 08:30 and 09:00 are sent, a habit with both times once
  const missed = addUser(worldAt(at(8)), 'uid-alice', user);
  assert.equal((await go(missed, at(9))).sent, 3);
  assert.deepEqual(tags(missed), ['both', 't0830', 't0900']);
  // a day without runs: still only the last two slots
  const outage = addUser(worldAt(at(9, 0, 12)), 'uid-alice', user);
  await go(outage, at(9));
  assert.deepEqual(tags(outage), ['both', 't0830', 't0900']);
  // first ever run: no bookmark, the current slot only, and the bookmark is created
  const first = addUser(worldAt(), 'uid-alice', user);
  assert.equal((await go(first, at(9))).slot, at(9));
  assert.deepEqual(tags(first), ['both', 't0900']);
  assert.deepEqual(first.calls.find((c) => c.op === 'setDoc'), { op: 'setDoc', arg: BOOKMARK, options: { ifMissing: true } });
  assert.deepEqual(first.docs.get(BOOKMARK).data, { lastSlot: at(9), updatedAt: at(8, 56) });
});

test('4b. a catch-up window across local midnight is judged day by day; a habit due on both days is sent once', async () => {
  const w = worldAt(at(23)); // Europe/London, window 23:00 to 24:00 UTC on 13 Nov
  addUser(w, 'uid-alice', {
    habits: {
      hitBoth: { name: 'Hit, both times', target: 1, times: ['00:00', '23:30'] },
      hitLate: { name: 'Hit, 23:30 only', target: 1, times: ['23:30'] },
      openLate: { name: 'Open, 23:30 only', times: ['23:30'] },
      openBoth: { name: 'Open, both times', times: ['00:00', '23:30'] },
    },
    logs: { '2026-11-13': { hitBoth: 1, hitLate: 1, openLate: 1, openBoth: 2 } },
    devices: ['fid-alice-phone'],
  });
  assert.deepEqual(await go(w, at(24)), { slot: at(24), sent: 3, skipped: 1, failed: 0, removed: 0 });
  assert.deepEqual(Object.fromEntries(w.pushes.map((p) => [p.data.tag, p.data.body])), {
    hitBoth: 'Not started today. Target: 1.', // for the 14th
    openLate: '1 of 3 done today.', // for the 13th
    openBoth: 'Not started today. Target: 3.', // once, with the text of the 14th
  });

  // Sunday 31 May to Monday 1 June 2026 (UTC): the two days are in different weeks and months
  const june = Date.UTC(2026, 5, 1);
  const v = worldAt(june - 2 * SLOT);
  addUser(v, 'uid-bob', {
    tz: 'UTC',
    habits: {
      weekHit: { name: 'Week hit', period: 'week', target: 2, times: ['00:00', '23:30'] },
      weekOpen: { name: 'Week open', period: 'week', target: 3, times: ['23:30'] },
    },
    logs: { '2026-05-26': { weekOpen: 1 }, '2026-05-27': { weekHit: 2 } },
    devices: ['fid-bob-phone'],
  });
  await go(v, june);
  assert.deepEqual(Object.fromEntries(v.pushes.map((p) => [p.data.tag, p.data.body])),
    { weekHit: 'Not started this week. Target: 2.', weekOpen: '1 of 3 done this week.' });
  assert.deepEqual(v.ops('getDoc'), [BOOKMARK, 'users/uid-bob/logs/2026-05', 'users/uid-bob/logs/2026-06']);
});

test('5a. the same local time fires at the right moment in each zone, including a 45-minute offset', async () => {
  const w = worldAt(at(0) - SLOT);
  addUser(w, 'uid-london', { tz: 'Europe/London', habits: { h1: {} }, devices: ['fid-london'] });
  addUser(w, 'uid-kathmandu', { tz: 'Asia/Kathmandu', habits: { h1: {} }, devices: ['fid-kathmandu'] });
  addUser(w, 'uid-no-zone', { tz: 'Not/AZone', habits: { h1: {} }, devices: ['fid-no-zone'] });
  const firedAt = {};
  for (let slot = at(0); slot < at(24); slot += SLOT) {
    const before = w.pushes.length;
    await go(w, slot);
    for (const p of w.pushes.slice(before)) (firedAt[p.fid] ??= []).push(new Date(slot).toISOString().slice(11, 16));
  }
  // 09:00 in Kathmandu is 03:15 UTC: the first slot after it. An unknown zone counts as UTC.
  assert.deepEqual(firedAt, { 'fid-kathmandu': ['03:30'], 'fid-london': ['09:00'], 'fid-no-zone': ['09:00'] });
});

test('5b. times skipped by spring-forward are sent at the next slot (Europe/London, 29 March 2026)', async () => {
  const march = (h, m = 0) => at(h, m, 29, 2);
  const w = worldAt(march(0));
  addUser(w, 'uid-alice', {
    habits: {
      t0100: { name: 'At 01:00', times: ['01:00'] }, t0130: { name: 'At 01:30', times: ['01:30'] },
      t0200: { name: 'At 02:00', times: ['02:00'] },
    },
    devices: ['fid-alice-phone'],
  });
  await go(w, march(0, 30)); // 00:30 GMT
  assert.deepEqual(tags(w), []);
  await go(w, march(1)); // 01:00 UTC is 02:00 BST: the clock jumped over 01:00 and 01:30
  assert.deepEqual(tags(w), ['t0100', 't0130', 't0200']);
  await go(w, march(1, 30));
  assert.equal(w.pushes.length, 3);
});

test('5c. "today" for the target check is the user\'s local day (UTC+13 and UTC-11 at the same instant)', async () => {
  const w = worldAt(at(9, 30)); // 10:00 UTC on 13 Nov: 23:00 on the 13th in Tonga, 23:00 on the 12th in Pago Pago
  const user = (tz, fid) => ({
    tz, devices: [fid],
    habits: {
      on12: { name: 'Done on the 12th', target: 1, times: ['23:00'] },
      on13: { name: 'Done on the 13th', target: 1, times: ['23:00'] },
    },
    logs: { '2026-11-12': { on12: 1 }, '2026-11-13': { on13: 1 } },
  });
  addUser(w, 'uid-tonga', user('Pacific/Tongatapu', 'fid-tonga'));
  addUser(w, 'uid-pago', user('Pacific/Pago_Pago', 'fid-pago'));
  assert.deepEqual(await go(w, at(10)), { slot: at(10), sent: 2, skipped: 2, failed: 0, removed: 0 });
  assert.deepEqual(tags(w, 'fid-tonga'), ['on12']);
  assert.deepEqual(tags(w, 'fid-pago'), ['on13']);
});

test('6a. an unregistered device is deleted and the run succeeds; no device is deleted on any other error', async () => {
  const user = { habits: { h1: {}, h2: { name: 'Stretch' } }, devices: ['fid-alice-old', 'fid-alice-phone'] };
  const w = addUser(worldAt(at(8, 30)), 'uid-alice', user);
  w.pushReply = (fid) => (fid === 'fid-alice-old' ? 'unregistered' : 'sent');
  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 2, skipped: 0, failed: 0, removed: 1 });
  assert.deepEqual(w.ops('deleteDoc'), ['devices/fid-alice-old']);
  assert.ok(!w.docs.has('devices/fid-alice-old') && w.docs.has('devices/fid-alice-phone'));
  assert.deepEqual(w.ops('sendPush'), ['fid-alice-old', 'fid-alice-phone', 'fid-alice-phone']); // not tried again

  for (const [status, code] of [[500, 'INTERNAL'], [404, 'HTTP_404'], [400, 'INVALID_ARGUMENT'], [0, 'NETWORK']]) {
    const v = addUser(worldAt(at(8, 30)), 'uid-alice', user);
    v.pushReply = (fid) => (fid === 'fid-alice-old' ? new GoogleError('sendPush failed', { status, code }) : 'sent');
    assert.deepEqual(await go(v, at(9)), { slot: at(9), sent: 2, skipped: 0, failed: 2, removed: 0 }, code);
    assert.deepEqual(v.ops('deleteDoc'), []);
    assert.ok(v.docs.has('devices/fid-alice-old'));
  }
  // a device record that cannot be deleted is a failure, not a removal
  const x = addUser(worldAt(at(8, 30)), 'uid-alice', user);
  x.pushReply = w.pushReply;
  x.fail = (op) => (op === 'deleteDoc' ? unavailable() : null);
  assert.deepEqual(await go(x, at(9)), { slot: at(9), sent: 2, skipped: 0, failed: 1, removed: 0 });
});

test('6b. one user\'s failed read does not stop the others; the result reports it', async () => {
  const w = worldAt(at(8, 30));
  for (const name of ['alice', 'bob', 'carol', 'dave']) addUser(w, `uid-${name}`, { habits: { h1: {} }, devices: [`fid-${name}`] });
  w.fail = (op, arg) => {
    if (arg === 'users/uid-bob/habits' || arg === 'users/uid-carol/logs/2026-11') return unavailable();
    return op === 'sendPush' && arg === 'fid-alice' ? new Error('socket closed') : null;
  };
  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 1, skipped: 0, failed: 3, removed: 0 });
  assert.deepEqual(w.pushes.map((p) => p.fid), ['fid-dave']);
  assert.equal(w.docs.get(BOOKMARK).data.lastSlot, at(9));
});

test('6c. a failed read of the bookmark or the user list, or of every user, leaves the slot for the next run', async () => {
  const fresh = () => addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone'] });
  for (const broken of [BOOKMARK, 'users']) {
    const w = fresh();
    w.fail = (op, arg) => (arg === broken ? unavailable() : null);
    await assert.rejects(go(w, at(9)), GoogleError, broken);
    assert.deepEqual([w.ops('setDoc'), w.pushes], [[], []]);
    w.fail = () => null;
    assert.equal((await go(w, at(9))).sent, 1); // the next run still has the slot
  }
  const w = fresh(); // the only user cannot be read: counted, nothing claimed
  w.fail = (op) => (op === 'queryEqual' ? unavailable() : null);
  assert.deepEqual(await go(w, at(9)), { slot: null, sent: 0, skipped: 0, failed: 1, removed: 0 });
  assert.deepEqual(w.ops('setDoc'), []);
  w.fail = () => null;
  assert.equal((await go(w, at(9, 30))).sent, 1); // caught up by the next slot's run
});

test('6d. only a PreconditionError on the claim means "another run has it"; any other claim error sends nothing', async () => {
  for (const err of [new GoogleError('setDoc failed: network error', { code: 'NETWORK' }), unavailable(), new Error('boom')]) {
    const w = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone'] });
    w.fail = (op) => (op === 'setDoc' ? err : null);
    await assert.rejects(go(w, at(9)), (thrown) => thrown === err);
    assert.deepEqual(w.pushes, []);
  }
});

test('6e. a crash while sending leaves the slot claimed: the next run does not resend', async () => {
  const w = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone', 'fid-alice-laptop'] });
  let atFirstPush;
  w.pushReply = () => {
    atFirstPush ??= [...w.docs]; // what Firestore holds if the process dies during the first push
    return 'sent';
  };
  await go(w, at(9));
  const afterCrash = createWorld(atFirstPush);
  assert.equal(afterCrash.docs.get(BOOKMARK).data.lastSlot, at(9));
  assert.deepEqual(await run({ google: afterCrash.google, now: at(9, 5), log }), nothing);
  assert.deepEqual(afterCrash.pushes, []);
});

test('force: a forced run sends the current slot again and leaves the bookmark untouched', async () => {
  const w = worldAt(at(8)); // one run was missed
  addUser(w, 'uid-alice', { habits: { h1: {}, early: { name: 'At 08:30', times: ['08:30'] } }, devices: ['fid-alice-phone'] });
  assert.equal((await go(w, at(9))).sent, 2);
  const bookmark = structuredClone(w.docs.get(BOOKMARK));
  w.calls.length = 0;
  assert.deepEqual(await go(w, at(9), { force: true }), { slot: at(9), sent: 1, skipped: 0, failed: 0, removed: 0 });
  assert.deepEqual(tags(w), ['early', 'h1', 'h1']); // the current slot only, no catch-up
  assert.deepEqual(w.docs.get(BOOKMARK), bookmark);
  assert.ok(!w.calls.some((c) => c.arg === BOOKMARK));
  assert.deepEqual(await go(w, at(9)), nothing); // a normal run still sees the slot as done

  const never = addUser(worldAt(), 'uid-bob', { habits: { h1: {} }, devices: ['fid-bob-phone'] });
  assert.equal((await go(never, at(9), { force: true })).sent, 1);
  assert.ok(!never.docs.has(BOOKMARK));
});

test('limits: at most 100 habits and the 10 most recently updated devices per user', async () => {
  const w = worldAt(at(8, 30));
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`h${String(i).padStart(3, '0')}`, { name: `Habit ${i}` }]));
  addUser(w, 'uid-alice', { habits: many, devices: ['fid-alice-phone'] });
  addUser(w, 'uid-bob', { habits: { h1: {} }, devices: Array.from({ length: 12 }, (_, i) => [`fid-bob-${i}`, 1000 + ((i * 5) % 12)]) });
  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 110, skipped: 0, failed: 0, removed: 0 });
  assert.deepEqual(tags(w, 'fid-alice-phone'), Object.keys(many).slice(0, 100));
  const oldest = ['fid-bob-0', 'fid-bob-5']; // updatedAt 1000 and 1001
  assert.deepEqual(w.pushes.filter((p) => p.fid.startsWith('fid-bob')).map((p) => p.fid).sort(),
    Array.from({ length: 12 }, (_, i) => `fid-bob-${i}`).filter((fid) => !oldest.includes(fid)).sort());
});

test('hostile or broken data: nothing crashes, nothing reaches another user, nothing oversized is sent', async () => {
  const w = worldAt(at(8, 30));
  addUser(w, 'uid-mallory', {
    tz: 42,
    habits: {
      junkTimes: { times: 'nope' }, mixedTimes: { times: ['09:00', 9, null, { a: 1 }] }, nestedTimes: { times: [['09:00']] },
      numberName: { name: 42 }, mapName: { name: { toString: 'x' } }, longName: { name: 'x'.repeat(5000) },
      longUnit: { unit: 'y'.repeat(5000) }, hugeTarget: { target: 1e300 }, zeroTarget: { target: 0 },
      textTarget: { target: '3' }, oddPeriod: { period: 'month' },
      fine: { name: 'Mallory\'s habit' }, textCount: { name: 'Text count' }, hugeCount: { name: 'Huge count' },
    },
    devices: ['fid-mallory'],
  });
  w.put('users/uid-mallory/habits/empty', {});
  w.put('users/uid-mallory/logs/2026-11', {
    days: { '2026-11-13': { fine: 'lots', textCount: '5', hugeCount: 1e300, toString: 3 }, '2026-11-12': 7 },
  });
  w.put('devices/fid mallory!', { uid: 'uid-mallory', ua: '', updatedAt: 9 }); // not a usable id
  w.put(`devices/${'f'.repeat(65)}`, { uid: 'uid-mallory', ua: '', updatedAt: 9 });
  w.put('devices/fid-mallory-claims-alice', { uid: 'uid-alice', ua: '', updatedAt: 'now' }); // rules prevent this; still harmless
  addUser(w, 'uid-nolog', { habits: { h1: { name: 'No log map' } }, devices: ['fid-nolog'] });
  w.put('users/uid-nolog/logs/2026-11', { days: ['2026-11-13'] });
  w.put('users/uid-nodata', {});
  addUser(w, 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone'] });

  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 6, skipped: 0, failed: 0, removed: 0 });
  assert.deepEqual(tags(w, 'fid-mallory'), ['fine', 'hugeCount', 'textCount']);
  assert.ok(w.pushes.filter((p) => p.fid === 'fid-mallory').every((p) => p.data.body === 'Not started today. Target: 3.'));
  assert.deepEqual(tags(w, 'fid-nolog'), ['h1']);
  // alice's habit goes to her phone and to the record that names her, never to mallory; mallory's go nowhere else
  assert.deepEqual(w.pushes.filter((p) => p.data.title === 'Drink water').map((p) => p.fid),
    ['fid-alice-phone', 'fid-mallory-claims-alice']);
  assert.ok(w.pushes.filter((p) => p.data.title !== 'Drink water').every((p) => ['fid-mallory', 'fid-nolog'].includes(p.fid)));
  for (const { data } of w.pushes) {
    assert.deepEqual(Object.keys(data), ['title', 'body', 'tag', 'url']);
    assert.ok(data.title.length <= 60 && data.body.length <= 120);
  }
  assert.deepEqual(w.ops('deleteDoc'), []);

  // even if the device query answered with everybody's records, a habit stays with its owner
  const leaky = worldAt(at(8, 30));
  addUser(leaky, 'uid-alice', { habits: { h1: {} }, devices: ['fid-alice-phone'] });
  addUser(leaky, 'uid-bob', { habits: { h2: { name: 'Read a book' } }, devices: ['fid-bob-phone'] });
  leaky.google.queryEqual = () => leaky.google.listDocs('devices');
  await go(leaky, at(9));
  assert.deepEqual(leaky.pushes.map((p) => [p.fid, p.data.title]), [['fid-alice-phone', 'Drink water'], ['fid-bob-phone', 'Read a book']]);
});

/** Runs the command itself with the given environment (nothing inherited but PATH). */
function command(env, args = [SCRIPT]) {
  const child = spawnSync(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
  return { code: child.status, output: child.stdout + child.stderr };
}

test('7. missing or malformed key: exit code 1 and a clear message that shows no part of the key', () => {
  const MARKER = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
  // token_uri points at a closed local port, so nothing could leave this machine even if a key were accepted
  const key = { type: 'service_account', project_id: 'demo-habit-tally', client_email: EMAIL, token_uri: 'http://127.0.0.1:9/token' };
  const pem = `-----BEGIN PRIVATE KEY-----\n${MARKER}\n-----END PRIVATE KEY-----\n`;
  const cases = [
    [{}, /FIREBASE_SERVICE_ACCOUNT is not set/],
    [{ FIREBASE_SERVICE_ACCOUNT: '   ' }, /FIREBASE_SERVICE_ACCOUNT is not set/],
    [{ FIREBASE_SERVICE_ACCOUNT: `{"private_key": "${MARKER}` }, /not a JSON service account key/],
    [{ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...key, note: MARKER }) }, /has no private_key/],
    [{ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...key, private_key: pem }) }, /private_key is not a usable RSA key/],
    [{ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ ...key, private_key: pem }), GCLOUD_PROJECT: 'not a project!' },
      /project id is not valid/],
  ];
  for (const [env, message] of cases) {
    const { code, output } = command(env);
    assert.equal(code, 1, output);
    assert.match(output, message);
    assert.ok(!output.includes(MARKER) && !output.includes('PRIVATE KEY') && !output.includes(EMAIL), output);
    assert.ok(output.trim().split('\n').length <= 3, output);
    logged.push(output);
  }
  // importing the module runs nothing
  const importOnly = ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`];
  assert.deepEqual(command({}, importOnly), { code: 0, output: '' });
});

test('8. reads are kept to a minimum, and a 200-user run finishes in under 5 seconds', async () => {
  const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`h${i}`, { name: `Habit ${i}`, times: ['07:00', '20:00'] }]));
  const devices = ['fid-alice-phone', 'fid-alice-laptop'];
  // nothing due: the bookmark, the user and the 10 habits; no logs, no devices
  const quiet = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: ten, devices });
  await go(quiet, at(9));
  assert.deepEqual(quiet.calls.map((c) => `${c.op} ${c.arg}`),
    [`getDoc ${BOOKMARK}`, 'listDocs users', 'listDocs users/uid-alice/habits', `setDoc ${BOOKMARK}`]);
  assert.equal(quiet.billed, 12);
  // one habit due (and one more in the window): one month of logs and one device query on top
  const due = addUser(worldAt(at(8, 30)), 'uid-alice', {
    habits: { ...ten, h3: { times: ['09:00'] }, h4: { name: 'Stretch', times: ['09:00'] } }, logs: { '2026-11-13': { h4: 3 } }, devices,
  });
  assert.deepEqual(await go(due, at(9)), { slot: at(9), sent: 2, skipped: 1, failed: 0, removed: 0 });
  assert.deepEqual(due.calls.map((c) => `${c.op} ${c.arg}`), [
    `getDoc ${BOOKMARK}`, 'listDocs users', 'listDocs users/uid-alice/habits', 'getDoc users/uid-alice/logs/2026-11',
    'queryEqual devices uid', `setDoc ${BOOKMARK}`, 'sendPush fid-alice-laptop', 'sendPush fid-alice-phone',
  ]);
  assert.equal(due.billed, 15);
  // every candidate already done: logs are read, devices are not
  const done = addUser(worldAt(at(8, 30)), 'uid-alice', { habits: { h1: { target: 1 } }, logs: { '2026-11-13': { h1: 1 } }, devices });
  await go(done, at(9));
  assert.deepEqual([done.ops('getDoc').length, done.ops('queryEqual').length], [2, 0]);
  // no local time in the window (Europe/London, the hour the clocks go back): not even the habits are read
  const autumn = Date.UTC(2026, 9, 25, 1);
  const back = addUser(worldAt(autumn - SLOT), 'uid-alice', { habits: ten, devices });
  await go(back, autumn);
  assert.deepEqual(back.ops('listDocs'), ['users']);
  // several due habits: logs and devices are still read once per user
  const w = worldAt(at(8, 30));
  for (let i = 0; i < 200; i += 1) {
    const id = `uid-${String(i).padStart(4, '0')}`;
    addUser(w, id, {
      habits: { h1: {}, h2: { name: 'Stretch', period: 'week' }, h3: { name: 'Later', times: ['21:00'] } },
      devices: [`f${id}a`, `f${id}b`],
    });
  }
  const started = performance.now();
  assert.deepEqual(await go(w, at(9)), { slot: at(9), sent: 800, skipped: 0, failed: 0, removed: 0 });
  assert.ok(performance.now() - started < 5000);
  assert.deepEqual([w.ops('listDocs').length, w.ops('getDoc').length, w.ops('queryEqual').length], [201, 201, 200]);
});

test('9. nothing sensitive in the log: no habit name, uid, device id, email or server text', async () => {
  const w = worldAt(at(8));
  const said = `Drink water for uid-alice on fid-alice-phone, ${EMAIL}`; // what a server might quote back
  addUser(w, 'uid-alice', {
    habits: { h1: {}, h2: { name: 'Stretch', target: 1 } }, logs: { '2026-11-13': { h2: 1 } },
    devices: ['fid-alice-phone', 'fid-alice-old'],
  });
  addUser(w, 'uid-bob', { habits: { h1: { name: 'Read a book' }, bad: { name: 7 } }, devices: ['fid-bob-phone'] });
  addUser(w, 'uid-carol', { habits: { h1: { name: 'Call mum' } } });
  w.put('devices/fid carol!', { uid: 'uid-carol', ua: EMAIL, updatedAt: 1 });
  w.fail = (op, arg) => (arg === 'users/uid-bob/habits' ? unavailable(said) : null);
  w.pushReply = (fid) => (fid === 'fid-alice-old' ? 'unregistered' : new GoogleError(said, { status: 403, code: said, detail: said }));
  const lines = [];
  const result = await run({ google: w.google, now: at(8, 56), log: (line) => { lines.push(line); log(line); } });
  assert.deepEqual(result, { slot: at(9), sent: 0, skipped: 1, failed: 2, removed: 1 });
  assert.deepEqual(lines, [
    'Slot 2026-11-13T09:00Z, window 60 min: 3 users, 2 reminders due, 1 skipped (already done), 2 devices, '
      + '1 due without a device, 1 unusable device record ignored.',
    'Failed 1 x: reading a user, HTTP 503 UNAVAILABLE.',
    'Failed 1 x: a push, HTTP 403 UNKNOWN.',
  ]);
  // run-level failures and the quiet paths log too
  w.fail = (op) => (op === 'setDoc' ? new TypeError(said) : null);
  await assert.rejects(go(w, at(9, 30)));
  w.fail = (op, arg) => (arg === 'users' ? unavailable(said) : null);
  await assert.rejects(go(w, at(9, 30)));
  w.fail = () => null;
  await go(w, at(9));

  assert.ok(logged.length >= lines.length + 3 && sensitive.size > 8);
  for (const line of logged) {
    for (const secret of sensitive) assert.ok(!line.includes(secret), `"${secret}" is in the log line: ${line}`);
    assert.ok(line.length < 400 && !/@|uid-|fid-|ya29|PRIVATE/.test(line), line);
  }
});
