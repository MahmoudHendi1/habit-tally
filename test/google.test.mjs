// Tests for scripts/lib/google.mjs with a stand-in for fetch: no network and no real key (a throwaway RSA pair).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { inspect } from 'node:util';
import {
  readServiceAccount, createGoogle, encodeValue, decodeValue, ConfigError, GoogleError, PreconditionError,
  PUSH_TARGET_FIELD,
} from '../scripts/lib/google.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY = {
  type: 'service_account', project_id: 'demo-habit-tally', private_key_id: 'key-id-1', private_key: PEM,
  client_email: 'reminder-job@demo-habit-tally.iam.gserviceaccount.com', token_uri: 'https://oauth2.test/token',
};
const TOKEN = 'ya29.stand-in-access-token-0123456789';
const NOW = Date.UTC(2026, 10, 13, 9, 26);
const NAME = 'projects/demo-habit-tally/databases/(default)/documents';
const ROOT = `https://firestore.googleapis.com/v1/${NAME}`;
const T1 = '2026-11-13T09:00:00.123456Z';
const T2 = '2026-11-13T09:26:01.654321Z';
const PUSH = { title: 'Water', body: '1 of 3 today', tag: 'h1', url: '/' };
const raw = (path, fields, updateTime = T1) => ({ name: `${NAME}/${path}`, fields, createTime: T1, updateTime });
/** A reply in Google's error format: [http status, body]. */
const refusal = (code, status, message = 'refused', details) => [code, { error: { code, message, status, details } }];
const fcmError = (errorCode) => [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }];

/** Stand-in network: answers the token address itself; every other request takes the next [status, body, headers]. */
function setup(replies = [], options = {}) {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    if (url === KEY.token_uri) return Response.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 });
    const [status, body, headers] = replies.shift() ?? refusal(500, 'NO_REPLY_QUEUED');
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  const google = createGoogle({ serviceAccount: KEY, fetch, now: () => NOW, sleep, ...options });
  return { google, calls, sleeps, api: () => calls.filter((c) => c.url !== KEY.token_uri) };
}

const failing = async (fn) => {
  try { await fn(); } catch (err) { return err; }
  return assert.fail('expected an error');
};
const json = (call) => JSON.parse(call.body);

/** Nothing a caller could print from an error may hold the key, a token or one of the `extra` strings. */
function assertNoSecrets(err, extra = []) {
  const shown = [err.message, err.stack, err.detail, String(err), inspect(err), JSON.stringify(err)].join('\n');
  const keyLines = PEM.split('\n').filter((line) => line && !line.startsWith('-----'));
  for (const secret of [TOKEN, PEM, ...keyLines, ...extra].filter(Boolean)) {
    assert.ok(!shown.includes(secret), 'a secret is visible in an error');
  }
}

test('token: the request is a correctly signed JWT; the token is fetched once and reused', async () => {
  let clock = NOW;
  const replies = [[200, raw('system/reminders', {})], [200, { documents: [] }], [200, {}], [200, {}]];
  const { google, calls, api } = setup(replies, { now: () => clock });
  await Promise.all([google.getDoc('system/reminders'), google.listDocs('users')]); // parallel: still one request
  await google.sendPush('fid-1', PUSH);
  const tokenCalls = () => calls.filter((c) => c.url === KEY.token_uri);
  assert.equal(tokenCalls().length, 1);
  assert.equal(api().length, 3);
  assert.ok(api().every((c) => c.headers.authorization === `Bearer ${TOKEN}`));

  const [request] = tokenCalls();
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = form.get('assertion').split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT', kid: 'key-id-1' });
  assert.deepEqual(decode(claims), {
    iss: KEY.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: KEY.token_uri,
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
  });

  clock += 59.5 * 60 * 1000; // inside the last minute of the token's hour: a fresh one is requested
  await google.sendPush('fid-1', PUSH);
  assert.equal(tokenCalls().length, 2);
});

test('values: plain JSON converts to Firestore values and back', () => {
  const plain = {
    text: 'héllo', whole: 42, ms: 1794562000000, negative: -7, fraction: 1.5, yes: true, no: false, nothing: null,
    list: ['09:00', 2, 2.5, null, { k: 'v' }], days: { '2026-11-13': { h1: 3 } }, emptyMap: {}, emptyList: [],
  };
  const typed = { mapValue: { fields: {
    text: { stringValue: 'héllo' }, whole: { integerValue: '42' }, ms: { integerValue: '1794562000000' },
    negative: { integerValue: '-7' }, fraction: { doubleValue: 1.5 }, yes: { booleanValue: true },
    no: { booleanValue: false }, nothing: { nullValue: null },
    list: { arrayValue: { values: [{ stringValue: '09:00' }, { integerValue: '2' }, { doubleValue: 2.5 },
      { nullValue: null }, { mapValue: { fields: { k: { stringValue: 'v' } } } }] } },
    days: { mapValue: { fields: { '2026-11-13': { mapValue: { fields: { h1: { integerValue: '3' } } } } } } },
    emptyMap: { mapValue: { fields: {} } }, emptyList: { arrayValue: { values: [] } },
  } } };
  assert.deepEqual(encodeValue(plain), typed);
  assert.deepEqual(decodeValue(typed), plain);
  assert.equal(typeof decodeValue({ integerValue: '1794562000000' }), 'number');
  assert.equal(decodeValue({ timestampValue: T1 }), T1);
  assert.deepEqual(decodeValue({ arrayValue: {} }), []); // the server leaves out empty lists and maps
  assert.deepEqual(decodeValue({ mapValue: {} }), {});
  const hostile = JSON.parse('{"__proto__":{"mapValue":{"fields":{"x":{"integerValue":"1"}}}}}');
  assert.equal(Object.getPrototypeOf(decodeValue({ mapValue: { fields: hostile } })), Object.prototype);
  assert.equal({}.x, undefined);
  for (const bad of [undefined, NaN, Infinity, new Date(0), () => 1, { a: [undefined] }]) {
    assert.throws(() => encodeValue(bad), TypeError);
  }
});

test('firestore: getDoc (null on 404), listDocs with pagination, queryEqual and deleteDoc', async () => {
  const habit = { name: { stringValue: 'Water' }, target: { integerValue: '3' }, times: { arrayValue: {} } };
  const device = raw('devices/fid-1', { uid: { stringValue: 'u1' } });
  const { google, api } = setup([
    [200, raw('users/u1/habits/h1', habit)],
    refusal(404, 'NOT_FOUND'),
    [200, { documents: [raw('users/u1', { tz: { stringValue: 'Europe/London' } }), raw('users/u2')], nextPageToken: 'p/2+=' }],
    [200, { documents: [raw('users/u3')] }],
    [200, {}],
    [200, [{ document: device, readTime: T2 }, { readTime: T2, done: true }]],
    [200, [{ readTime: T2 }]],
    [200, {}],
    refusal(404, 'NOT_FOUND'),
    refusal(403, 'PERMISSION_DENIED'),
  ]);
  assert.deepEqual(await google.getDoc('users/u1/habits/h1'),
    { id: 'h1', path: 'users/u1/habits/h1', data: { name: 'Water', target: 3, times: [] }, updateTime: T1 });
  assert.equal(await google.getDoc('system/reminders'), null);
  const users = await google.listDocs('users');
  assert.deepEqual(users.map((d) => d.id), ['u1', 'u2', 'u3']);
  assert.deepEqual(users[0], { id: 'u1', path: 'users/u1', data: { tz: 'Europe/London' }, updateTime: T1 });
  assert.deepEqual(await google.listDocs('users/u1/logs'), []);
  assert.deepEqual(await google.queryEqual('devices', 'uid', 'u1'),
    [{ id: 'fid-1', path: 'devices/fid-1', data: { uid: 'u1' }, updateTime: T1 }]);
  assert.deepEqual(await google.queryEqual('devices', 'uid', 'nobody'), []);
  assert.equal(await google.deleteDoc('devices/fid-1'), undefined);
  assert.equal(await google.deleteDoc('devices/gone'), undefined);
  const denied = await failing(() => google.deleteDoc('devices/fid-2'));
  assert.ok(denied instanceof GoogleError && !(denied instanceof PreconditionError));
  assert.deepEqual([denied.status, denied.code], [403, 'PERMISSION_DENIED']);

  const sent = api();
  assert.deepEqual(sent.map((c) => `${c.method} ${c.url}`), [
    `GET ${ROOT}/users/u1/habits/h1`,
    `GET ${ROOT}/system/reminders`,
    `GET ${ROOT}/users?pageSize=300`,
    `GET ${ROOT}/users?pageSize=300&pageToken=p%2F2%2B%3D`,
    `GET ${ROOT}/users/u1/logs?pageSize=300`,
    `POST ${ROOT}:runQuery`,
    `POST ${ROOT}:runQuery`,
    `DELETE ${ROOT}/devices/fid-1`,
    `DELETE ${ROOT}/devices/gone`,
    `DELETE ${ROOT}/devices/fid-2`,
  ]);
  assert.ok(sent.every((c) => c.headers.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(json(sent[5]), { structuredQuery: {
    from: [{ collectionId: 'devices' }],
    where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: 'u1' } } },
  } });
  for (const bad of ['', 'users/', '/users/u1', 'users/u1/habits', null, 'users/..', 'users/u1/../x', './u1', 'users/.']) {
    await assert.rejects(google.getDoc(bad), TypeError);
  }
  for (const bad of ['users/u1', '..', '.', 'users/u1/..', 'users/../habits', 'users//habits']) {
    await assert.rejects(google.listDocs(bad), TypeError);
  }
  await assert.rejects(google.deleteDoc('devices/..'), TypeError);
  await assert.rejects(google.setDoc('system/..', { lastSlot: 1 }), TypeError);
  await assert.rejects(google.queryEqual('..', 'uid', 'u1'), TypeError);
  assert.equal(api().length, sent.length); // a malformed path never reaches the network
});

test('firestore: listDocs honours a limit and gives up on a list that never ends', async () => {
  const page = (ids, nextPageToken) => [200, { documents: ids.map((id) => raw(`users/${id}`)), nextPageToken }];
  const { google, api } = setup([page(['u1', 'u2'], 'more'), page(['u1', 'u2'], 'more'), page(['u3', 'u4'], 'more'),
    page(['u1'], 'again'), page(['u2'], 'again')]);
  assert.deepEqual((await google.listDocs('users', { limit: 2 })).map((d) => d.id), ['u1', 'u2']);
  assert.deepEqual((await google.listDocs('users', { limit: 3 })).map((d) => d.id), ['u1', 'u2', 'u3']);
  assert.deepEqual(api().map((c) => c.url.slice(ROOT.length)), // asks only for what is still wanted, then stops
    ['/users?pageSize=2', '/users?pageSize=3', '/users?pageSize=1&pageToken=more']);
  const repeated = await failing(() => google.listDocs('users'));
  assert.ok(repeated instanceof GoogleError);
  assert.deepEqual([repeated.code, api().length], ['BAD_RESPONSE', 5]);
  for (const limit of [0, -1, 1.5, '2', NaN]) await assert.rejects(google.listDocs('users', { limit }), TypeError);
  await assert.rejects(google.listDocs('users', null), TypeError);
  assert.equal(api().length, 5);

  const endless = setup(Array.from({ length: 250 }, (_, i) => page([`u${i}`], `token-${i}`)));
  const tooLong = await failing(() => endless.google.listDocs('users'));
  assert.deepEqual([tooLong.code, endless.api().length], ['BAD_RESPONSE', 200]); // 200 pages, then no more
});

test('firestore: a document without an update time is refused, so no claim can be built on it', async () => {
  const noTime = { name: `${NAME}/system/reminders`, fields: {} };
  const { google } = setup([[200, noTime], [200, { ...noTime, updateTime: '' }], [200, { documents: [noTime] }],
    [200, [{ document: { ...noTime, updateTime: 5 }, readTime: T2 }]], [200, { writeResults: [{}], commitTime: T2 }],
    [200, { writeResults: [{ updateTime: 5 }] }], [200, { fields: {}, updateTime: T1 }]]);
  const calls = [() => google.getDoc('system/reminders'), () => google.getDoc('system/reminders'),
    () => google.listDocs('system'), () => google.queryEqual('system', 'lastSlot', 1),
    () => google.setDoc('system/reminders', { lastSlot: 1 }), () => google.setDoc('system/reminders', { lastSlot: 1 }),
    () => google.getDoc('system/reminders')];
  for (const fn of calls) {
    const err = await failing(fn);
    assert.ok(err instanceof GoogleError && !(err instanceof PreconditionError));
    assert.equal(err.code, 'BAD_RESPONSE');
  }
});

test('firestore: setDoc overwrites with the right precondition; a failed one is a PreconditionError', async () => {
  const done = [200, { writeResults: [{ updateTime: T2 }], commitTime: T2 }];
  const aborted = refusal(409, 'ABORTED', 'Too much contention on these documents.');
  const { google, api, sleeps } = setup([done, done, done,
    refusal(400, 'FAILED_PRECONDITION', 'the stored version does not match the required base version'),
    refusal(409, 'ALREADY_EXISTS'), aborted, refusal(400, 'FAILED_PRECONDITION'), aborted, done,
    aborted, aborted, aborted, refusal(404, 'NOT_FOUND'), refusal(403, 'PERMISSION_DENIED'),
    refusal(400, 'FAILED_PRECONDITION'), refusal(409, 'ALREADY_EXISTS'), refusal(404, 'NOT_FOUND'), done]);
  const data = { lastSlot: 1794562200000, updatedAt: 1794561960000 };
  const doc = { id: 'reminders', path: 'system/reminders', data, updateTime: T2 };
  assert.deepEqual(await google.setDoc('system/reminders', data, { ifUpdateTime: T1 }), doc);
  assert.deepEqual(await google.setDoc('system/reminders', data, { ifMissing: true }), doc);
  assert.deepEqual(await google.setDoc('system/reminders', data), doc);
  const fields = { lastSlot: { integerValue: '1794562200000' }, updatedAt: { integerValue: '1794561960000' } };
  const update = { name: `${NAME}/system/reminders`, fields };
  assert.deepEqual(api().map((c) => [c.method, c.url, json(c)]), [
    ['POST', `${ROOT}:commit`, { writes: [{ update, currentDocument: { updateTime: T1 } }] }],
    ['POST', `${ROOT}:commit`, { writes: [{ update, currentDocument: { exists: false } }] }],
    ['POST', `${ROOT}:commit`, { writes: [{ update }] }], // no updateMask anywhere: a full overwrite
  ]);

  const stale = await failing(() => google.setDoc('system/reminders', data, { ifUpdateTime: T1 }));
  const exists = await failing(() => google.setDoc('system/reminders', data, { ifMissing: true }));
  for (const [err, status, code] of [[stale, 400, 'FAILED_PRECONDITION'], [exists, 409, 'ALREADY_EXISTS']]) {
    assert.ok(err instanceof PreconditionError && err instanceof GoogleError);
    assert.deepEqual([err.name, err.status, err.code], ['PreconditionError', status, code]);
  }
  // A write that collided with another (ABORTED) is sent again: the race is then lost, or won.
  const lost = await failing(() => google.setDoc('system/reminders', data, { ifUpdateTime: T1 }));
  assert.ok(lost instanceof PreconditionError);
  assert.deepEqual(await google.setDoc('system/reminders', data, { ifUpdateTime: T1 }), doc);
  assert.deepEqual([api().length, sleeps.length], [9, 2]);
  // Not a lost claim: contention that never clears (3 attempts), a missing database on the first run, an error
  // on an unconditional write.
  const contended = await failing(() => google.setDoc('system/reminders', data, { ifUpdateTime: T1 }));
  const noDatabase = await failing(() => google.setDoc('system/reminders', data, { ifMissing: true }));
  const denied = await failing(() => google.setDoc('system/reminders', data));
  assert.equal(api().length, 14);
  for (const [err, status] of [[contended, 409], [noDatabase, 404], [denied, 403]]) {
    assert.ok(err instanceof GoogleError && !(err instanceof PreconditionError));
    assert.deepEqual([err.name, err.status], ['GoogleError', status]);
  }
  // A write without a condition cannot fail a condition, whatever the server answers.
  for (const status of [400, 409, 404]) {
    const err = await failing(() => google.setDoc('system/reminders', data));
    assert.ok(err instanceof GoogleError && !(err instanceof PreconditionError));
    assert.deepEqual([err.name, err.status], ['GoogleError', status]);
  }
  assert.equal(api().length, 17);

  // A condition that is asked for but unusable is an error before any request, never an unconditional write.
  const unusable = [{ ifUpdateTime: '' }, { ifUpdateTime: undefined }, { ifUpdateTime: null }, { ifUpdateTime: 1794562200000 },
    { ifUpdateTime: 'yesterday' }, { ifUpdateTime: new Date(0) }, { ifUpdateTime: T1, ifMissing: true },
    { ifUpdateTime: undefined, ifMissing: true }, { ifMissing: 1 }, { ifMissing: 'true' }, { ifMissing: null }, null, 'x'];
  for (const options of unusable) {
    await assert.rejects(google.setDoc('system/reminders', data, options), TypeError);
  }
  await assert.rejects(google.setDoc('system/reminders', { lastSlot: undefined }), TypeError);
  await assert.rejects(google.setDoc('system', data), TypeError);
  assert.equal(api().length, 17);
  assert.deepEqual(await google.setDoc('system/reminders', data, { ifMissing: false }), doc); // false = no condition
  assert.deepEqual(json(api()[17]), { writes: [{ update }] });
});

test('emulator: Firestore uses the emulator address and "Bearer owner", no token; the push address can be replaced', async () => {
  const options = { projectId: 'other-project', firestoreEmulatorHost: '127.0.0.1:8181', fcmBaseUrl: 'http://127.0.0.1:9911/' };
  const { google, calls } = setup([[200, { documents: [] }], [200, raw('system/reminders', {})], [200, {}]], options);
  await google.listDocs('users');
  await google.getDoc('system/reminders');
  const base = 'http://127.0.0.1:8181/v1/projects/other-project/databases/(default)/documents';
  assert.deepEqual(calls.map((c) => [c.url, c.headers.authorization]),
    [[`${base}/users?pageSize=300`, 'Bearer owner'], [`${base}/system/reminders`, 'Bearer owner']]);
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  assert.deepEqual(calls.slice(2).map((c) => c.url),
    [KEY.token_uri, 'http://127.0.0.1:9911/v1/projects/other-project/messages:send']);
  assert.equal(calls[3].headers.authorization, `Bearer ${TOKEN}`);
  assert.throws(() => createGoogle({ serviceAccount: KEY, firestoreEmulatorHost: 'http://127.0.0.1:8181' }), ConfigError);
});

test('sendPush: the body is exactly the contract message; only 404 with FCM code UNREGISTERED is unregistered', async () => {
  const replies = [[200, { name: 'projects/demo-habit-tally/messages/1' }],
    refusal(404, 'NOT_FOUND', 'Requested entity was not found.', fcmError('UNREGISTERED')),
    refusal(404, 'NOT_FOUND', 'Method not found.'), // Google's generic 404: a wrong address or project
    refusal(404, 'NOT_FOUND', 'x', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', errorCode: 'UNREGISTERED' }]),
    refusal(404, 'UNREGISTERED'), refusal(404, 'NOT_FOUND', 'x', fcmError('INVALID_ARGUMENT')),
    [404, '<html>Not Found</html>'],
    refusal(400, 'INVALID_ARGUMENT', 'x', fcmError('UNREGISTERED')), refusal(403, 'PERMISSION_DENIED', 'x', fcmError('UNREGISTERED')),
    refusal(400, 'UNREGISTERED'), refusal(410, 'NOT_FOUND', 'x', fcmError('UNREGISTERED'))];
  const { google, api, sleeps } = setup(replies);
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  const [call] = api();
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://fcm.googleapis.com/v1/projects/demo-habit-tally/messages:send');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(PUSH_TARGET_FIELD, 'fid');
  assert.deepEqual(json(call), { message: {
    fid: 'fid-1',
    data: { title: 'Water', body: '1 of 3 today', tag: 'h1', url: '/' },
    webpush: { headers: { TTL: '1800', Urgency: 'high' } },
  } });
  assert.equal(await google.sendPush('fid-2', PUSH), 'unregistered');
  // Every other 404, and UNREGISTERED at any other status, throws: the job must not delete a device for these.
  const expected = [[404, 'NOT_FOUND'], [404, 'NOT_FOUND'], [404, 'UNREGISTERED'], [404, 'INVALID_ARGUMENT'],
    [404, 'HTTP_404'], [400, 'UNREGISTERED'], [403, 'UNREGISTERED'], [400, 'UNREGISTERED'], [410, 'UNREGISTERED']];
  for (const pair of expected) {
    const err = await failing(() => google.sendPush('fid-3', PUSH));
    assert.ok(err instanceof GoogleError);
    assert.deepEqual([err.status, err.code], pair);
  }
  assert.deepEqual([api().length, sleeps.length], [11, 0]);
  await assert.rejects(google.sendPush('fid-5', { ...PUSH, tag: 5 }), TypeError);
  await assert.rejects(google.sendPush('', PUSH), TypeError);
});

test('sendPush: one retry on 429 or 5xx; other failures throw with their status; 400 is never unregistered', async () => {
  const { google, api, sleeps } = setup([
    refusal(429, 'RESOURCE_EXHAUSTED', 'quota', fcmError('QUOTA_EXCEEDED')), [200, {}],
    [503, { error: { code: 503, status: 'UNAVAILABLE' } }, { 'retry-after': '3' }], [200, {}],
    refusal(500, 'INTERNAL'), refusal(500, 'INTERNAL'), [200, {}],
    refusal(400, 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token',
      fcmError('INVALID_ARGUMENT')),
    refusal(403, 'PERMISSION_DENIED', 'refused', fcmError('SENDER_ID_MISMATCH')),
    [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, { 'retry-after': '3600' }], [200, {}],
  ]);
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  assert.deepEqual([api().length, sleeps], [2, [1000]]);
  assert.equal(api()[0].body, api()[1].body);
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  assert.deepEqual([api().length, sleeps], [4, [1000, 3000]]); // Retry-After is honoured (up to 5 s)

  const twice = await failing(() => google.sendPush('fid-1', PUSH));
  assert.ok(twice instanceof GoogleError);
  assert.deepEqual([twice.status, twice.code, api().length], [500, 'INTERNAL', 6]); // two attempts, not three
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  const invalid = await failing(() => google.sendPush('fid-1', PUSH));
  assert.deepEqual([invalid.status, invalid.code, api().length], [400, 'INVALID_ARGUMENT', 8]); // no retry
  const mismatch = await failing(() => google.sendPush('fid-1', PUSH));
  assert.deepEqual([mismatch.status, mismatch.code], [403, 'SENDER_ID_MISMATCH']);
  assert.equal(await google.sendPush('fid-1', PUSH), 'sent');
  assert.deepEqual(sleeps, [1000, 3000, 1000, 5000]); // an hour of Retry-After is cut to 5 s
});

test('timeout: a request that gets no answer ends as a GoogleError with status 0', { timeout: 10000 }, async (t) => {
  const never = () => new Promise(() => {});
  const emulator = { firestoreEmulatorHost: '127.0.0.1:8181', timeoutMs: 20 };
  const stuckBody = async () => ({ status: 200, ok: true, headers: new Headers(), text: never });
  let signal;
  const polite = (url, init) => new Promise((_, reject) => { // a fetch that honours the abort signal, like the real one
    signal = init.signal;
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const tooSlow = new Promise((_, reject) => { setTimeout(() => reject(new Error('too slow')), 2000).unref(); });
  const errors = await Promise.all([
    () => setup([], { ...emulator, fetch: never }).google.getDoc('users/u1'),
    () => setup([], { ...emulator, fetch: stuckBody }).google.listDocs('users'),
    () => setup([], { ...emulator, fetch: polite }).google.deleteDoc('users/u1'),
    () => setup([], { fetch: never, timeoutMs: 20 }).google.sendPush('fid-1', PUSH), // stuck in the token request
  ].map((fn) => failing(() => Promise.race([fn(), tooSlow]))));
  assert.ok(signal.aborted);
  for (const err of errors) {
    assert.ok(err instanceof GoogleError);
    assert.deepEqual([err.status, err.code], [0, 'TIMEOUT']);
  }
  assert.equal(errors[3].message, 'token request failed: no answer in time');

  t.mock.timers.enable({ apis: ['setTimeout'] }); // the default limit is 20 s
  let settled = false;
  const waiting = failing(() => setup([], { fetch: never }).google.getDoc('users/u1')).finally(() => { settled = true; });
  const turn = () => new Promise((done) => { setImmediate(done); });
  await turn();
  t.mock.timers.tick(19999);
  await turn();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal((await waiting).code, 'TIMEOUT');
});

test('readServiceAccount: returns the key; a missing or malformed one is a ConfigError showing no part of it', () => {
  const text = JSON.stringify(KEY);
  assert.deepEqual(readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: text }), KEY);
  const { client_email: _, ...noEmail } = KEY;
  const cases = [undefined, '', '   ', text.slice(0, -1), text.slice(1), PEM, '"just a string"', '[1]', 'null',
    JSON.stringify(noEmail), JSON.stringify({ ...KEY, project_id: '' }), JSON.stringify({ private_key: PEM })];
  for (const value of cases) {
    assert.throws(() => readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: value }), (err) => {
      assertNoSecrets(err, [KEY.client_email, 'key-id-1']);
      const fixed = /^FIREBASE_SERVICE_ACCOUNT (is not set|is not a JSON service account key|has no [a-z_, ]+)$/;
      return err instanceof ConfigError && fixed.test(err.message); // fixed wording: nothing of the value
    });
  }
  assert.throws(() => readServiceAccount({}), /FIREBASE_SERVICE_ACCOUNT is not set/);
  assert.throws(() => readServiceAccount({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify(noEmail) }), /no client_email$/);
  assert.throws(() => createGoogle({ serviceAccount: { project_id: 'p' } }), ConfigError);
});

test('secrets: the key, the access token and request bodies never appear in a thrown error', async () => {
  const echo = `Bad request: Bearer ${TOKEN} key ${PEM} body {"message":{"fid":"fid-1","data":{"title":"Water"}}}`;
  const { google } = setup([refusal(403, 'PERMISSION_DENIED', echo), refusal(400, 'INVALID_ARGUMENT', echo),
    refusal(400, 'FAILED_PRECONDITION', echo), refusal(500, `X${TOKEN}`, echo), refusal(500, TOKEN, echo),
    [200, 'not json']]);
  const errors = [
    await failing(() => google.getDoc('users/u1')),
    await failing(() => google.sendPush('fid-1', PUSH)),
    await failing(() => google.setDoc('system/reminders', { lastSlot: 1 }, { ifUpdateTime: T1 })),
    await failing(() => google.sendPush('fid-1', PUSH)), // uses both 500 replies
    await failing(() => google.listDocs('users')),
  ];
  assert.equal(errors[0].message, 'getDoc failed: HTTP 403 PERMISSION_DENIED');
  assert.ok(errors[0].detail.includes('Bearer [removed] key [removed]') && errors[0].detail.length <= 300);
  assert.deepEqual(errors.map((e) => e.code),
    ['PERMISSION_DENIED', 'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'HTTP_500', 'BAD_RESPONSE']);

  const offline = setup([], { fetch: async () => { throw new Error(`connect failed for Bearer ${TOKEN}`); } });
  errors.push(await failing(() => offline.google.getDoc('users/u1')));
  assert.deepEqual([errors[5].status, errors[5].code], [0, 'NETWORK']);

  let assertion = '';
  const refuse = async (url, init) => {
    assertion = new URLSearchParams(init.body).get('assertion');
    const body = { error: 'invalid_grant', error_description: `Invalid JWT ${assertion} ${PEM}` };
    return Response.json(body, { status: 400 });
  };
  errors.push(await failing(() => setup([], { fetch: refuse }).google.getDoc('users/u1')));
  assert.deepEqual([errors[6].status, errors[6].message], [400, 'token request failed: HTTP 400 invalid_grant']);
  const badKey = createGoogle({ serviceAccount: { ...KEY, private_key: 'not-a-pem-SECRETSECRET' }, fetch: refuse });
  errors.push(await failing(() => badKey.getDoc('users/u1')));
  assert.ok(errors[7] instanceof ConfigError);

  for (const err of errors) {
    assertNoSecrets(err, ['SECRETSECRET', assertion]);
    // Text from the server (it may quote the request) is kept in `detail` only, which printing an error never shows.
    const printed = [err.message, err.stack, String(err), inspect(err), JSON.stringify(err)].join('\n');
    assert.ok(!/Water|fid-1|Bad request|Invalid JWT/.test(printed));
  }
});

test('scripts/: only node: modules and project files are imported; google.mjs never logs', () => {
  const dir = new URL('../scripts/', import.meta.url);
  const files = readdirSync(dir, { recursive: true }).filter((f) => /\.[cm]?js$/.test(f));
  assert.ok(files.some((f) => f.replaceAll('\\', '/') === 'lib/google.mjs'));
  for (const file of files) {
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), dir), 'utf8');
    const names = [...source.matchAll(/(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    for (const name of names) {
      const ours = /^\.\.?\//.test(name) && !name.includes('node_modules');
      assert.ok(/^node:[a-z/_]+$/.test(name) || ours, `${file} imports ${name}`);
    }
    assert.ok(!/\bimport\s*\(\s*[^'"`\s]/.test(source), `${file} imports a computed name`);
    if (file.endsWith('google.mjs')) {
      assert.deepEqual(names, ['node:crypto']);
      assert.ok(!/console\s*\.|process\s*\.\s*(stdout|stderr)/.test(source), 'google.mjs must not log');
    }
  }
});
