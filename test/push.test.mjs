// Push registration (docs/contracts.md section 6) against a stand-in for firebase/messaging: no browser,
// no Firebase. The stand-in behaves like SDK 13 where it matters: register() asks for permission by itself
// while it is undecided, refuses without an onRegistered listener, and reports the installation ID through
// onRegistered on every call; unregister() reports through onUnregistered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPush, CHOICE_KEY, FID_KEY, FLAGS_CACHE, SIGNED_OUT_FLAG } from '../src/push.js';

const ALLOWED = ['isSupported', 'register', 'onRegistered', 'onUnregistered', 'unregister'];
const SW = { scope: 'https://habit-tally.example/' }; // stands for the app's ServiceWorkerRegistration
const never = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)), removeItem: (k) => void map.delete(k) };
}

/** `answer` is what the person says when asked. */
function fakeNotification(permission = 'default', answer = 'granted') {
  const N = {
    permission,
    asked: 0,
    requestPermission() {
      N.asked++;
      N.permission = answer;
      return Promise.resolve(answer);
    },
  };
  return N;
}

function fakeCaches(log) {
  const stores = new Map();
  return {
    stores,
    flag: () => stores.get(FLAGS_CACHE)?.get(SIGNED_OUT_FLAG),
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        put: async (url, response) => {
          log.push('flag:set');
          entries.set(url, response);
        },
        delete: async (url) => {
          log.push('flag:clear');
          return entries.delete(url);
        },
      };
    },
  };
}

/** Device records, each owned by whoever is signed in when it is saved. */
function fakeStore(log) {
  const store = {
    uid: 'ana',
    devices: new Map(),
    async saveDevice(fid) {
      log.push(`save:${fid}`);
      store.devices.set(fid, { uid: store.uid });
    },
    async removeDevice(fid) {
      log.push(`remove:${fid}`);
      store.devices.delete(fid);
    },
  };
  return store;
}

function fakeMessaging(N, log, { supported = true } = {}) {
  const instance = { app: 'habit-tally' };
  const m = { fid: 'fid-1', registered: false, registerCalls: [], used: new Set(), onRegistered: null, onUnregistered: null, failRegister: null, failUnregister: null };
  const api = {
    isSupported: async () => supported,
    onRegistered(messaging, next) {
      assert.equal(messaging, instance);
      m.onRegistered = next;
      return () => {};
    },
    onUnregistered(messaging, next) {
      assert.equal(messaging, instance);
      m.onUnregistered = next;
      return () => {};
    },
    async register(messaging, options) {
      assert.equal(messaging, instance);
      m.registerCalls.push(options);
      if (N.permission === 'default') await N.requestPermission();
      if (N.permission !== 'granted') throw new Error('messaging/permission-blocked');
      if (!m.onRegistered) throw new Error('messaging/invalid-on-registered-handler');
      if (!options?.serviceWorkerRegistration) throw new Error('the SDK would look for /firebase-messaging-sw.js');
      if (m.failRegister) return m.failRegister();
      log.push(`register:${m.fid}`);
      m.registered = true;
      m.onRegistered(m.fid);
    },
    async unregister(messaging) {
      assert.equal(messaging, instance);
      if (m.failUnregister) return m.failUnregister();
      log.push('unregister');
      m.registered = false;
      m.onUnregistered?.(m.fid);
    },
  };
  // Anything else (getToken, deleteToken, onMessage, ...) fails the test that touches it.
  m.sdk = new Proxy(api, {
    get(target, key) {
      m.used.add(String(key));
      if (!(key in target)) throw new Error(`push.js must not use ${String(key)}`);
      return target[key];
    },
  });
  m.instance = instance;
  return m;
}

/** A push object in a browser that can do everything, plus every stand-in behind it. */
function setup({ backend = 'firebase', permission = 'default', answer = 'granted', stored = {}, vapidKey = 'VAPID-KEY', supported = true, sw = SW, ...deps } = {}) {
  const log = [];
  const N = fakeNotification(permission, answer);
  const storage = fakeStorage(stored);
  const caches = fakeCaches(log);
  const store = fakeStore(log);
  const m = fakeMessaging(N, log, { supported });
  const world = { log, N, storage, caches, store, m, loads: 0, sw };
  world.push = createPush({
    store,
    swRegistration: async () => world.sw,
    deps: {
      backend, Notification: N, localStorage: storage, caches, browserSupport: () => true,
      loadMessaging: async () => {
        world.loads++;
        return { sdk: m.sdk, vapidKey, messaging: () => m.instance };
      },
      ...deps,
    },
  });
  world.onlyAllowedCalls = () => assert.deepEqual([...m.used].filter((name) => !ALLOWED.includes(name)), []);
  return world;
}

const ON = { [CHOICE_KEY]: 'on', [FID_KEY]: 'fid-1' };

// ------------------------------------------------------------------------- demo and unsupported browsers

for (const backend of ['demo', 'emulator']) {
  test(`${backend} backend: the status is 'demo', nobody is asked, no messaging code is loaded`, async () => {
    const w = setup({ backend, stored: ON });
    const seen = [];
    w.push.subscribe((status) => seen.push(status));
    assert.equal(w.push.getStatus(), 'demo');
    assert.equal(await w.push.enable(), 'demo');
    await w.push.resume();
    await w.push.detach();
    await w.push.disable();
    await tick();
    assert.deepEqual(seen, ['demo']);
    assert.equal(w.N.asked, 0);
    assert.equal(w.loads, 0);
    assert.deepEqual(w.log, [], 'no flag, no device record, no registration');
    assert.equal(w.storage.map.get(CHOICE_KEY), 'on', 'storage is left alone');
  });
}

test('a browser without Notification, service worker or PushManager is unsupported, without a prompt or an error', async () => {
  for (const deps of [{ Notification: null }, { browserSupport: () => false }, { browserSupport: () => { throw new Error('no navigator'); } }]) {
    const w = setup(deps);
    assert.equal(w.push.getStatus(), 'unsupported');
    assert.equal(await w.push.enable(), 'unsupported');
    await w.push.resume();
    await w.push.detach();
    await w.push.disable();
    assert.equal(w.N.asked, 0);
    assert.equal(w.loads, 0, 'the messaging code is not even downloaded');
    assert.deepEqual(w.log.filter((entry) => !entry.startsWith('flag:')), []);
  }
});

test('with the real defaults under Node (no browser at all) the status is unsupported', async () => {
  const push = createPush({ store: {}, swRegistration: async () => null, deps: { backend: 'firebase' } });
  assert.equal(push.getStatus(), 'unsupported');
  assert.equal(await push.enable(), 'unsupported');
  await push.detach();
  await push.resume();
});

test("isSupported() false: the status becomes 'unsupported' and listeners hear it; enable() does not ask", async () => {
  const w = setup({ supported: false });
  const seen = [];
  w.push.subscribe((status) => seen.push(status));
  await tick();
  assert.deepEqual(seen, ['off', 'unsupported']);
  assert.equal(await w.push.enable(), 'unsupported');
  assert.equal(w.N.asked, 0);
  assert.deepEqual(w.m.registerCalls, []);
  w.onlyAllowedCalls();
});

// --------------------------------------------------------------------------------------------- permission

test('permission is asked only inside enable(), and before enable() waits for anything', async () => {
  const w = setup();
  const unsubscribe = w.push.subscribe(() => {});
  w.push.getStatus();
  await w.push.resume();
  await w.push.detach();
  await w.push.resume();
  await tick();
  assert.equal(w.N.asked, 0, 'creating, reading, resuming and detaching never ask');
  assert.equal(w.push.getStatus(), 'off');

  const enabling = w.push.enable();
  assert.equal(w.N.asked, 1, 'asked synchronously, while the tap still counts');
  assert.equal(await enabling, 'on');
  assert.equal(w.N.asked, 1, "the SDK's own prompt never runs");
  unsubscribe();
});

test("refused: the status is 'blocked' and nothing is registered or saved", async () => {
  const w = setup({ answer: 'denied' });
  const seen = [];
  w.push.subscribe((status) => seen.push(status));
  assert.equal(await w.push.enable(), 'blocked');
  assert.equal(w.push.getStatus(), 'blocked');
  assert.deepEqual(seen, ['off', 'blocked']);
  assert.deepEqual(w.m.registerCalls, []);
  assert.equal(w.store.devices.size, 0);
  assert.equal(w.storage.map.has(CHOICE_KEY), false);

  assert.equal(await w.push.enable(), 'blocked');
  assert.equal(w.N.asked, 1, 'a blocked browser is not asked again');
});

test("the prompt dismissed without an answer leaves the status 'off'", async () => {
  const w = setup({ answer: 'default' });
  assert.equal(await w.push.enable(), 'off');
  assert.deepEqual(w.m.registerCalls, []);
});

test('an old browser that answers the permission request through a callback', async () => {
  const w = setup();
  w.N.requestPermission = (callback) => {
    w.N.asked++;
    w.N.permission = 'granted';
    setImmediate(callback, 'granted');
  };
  assert.equal(await w.push.enable(), 'on');
});

// ------------------------------------------------------------------------------------------------ enable

test("enable() registers by installation ID with the app's own service worker and saves one device for the signed-in user", async () => {
  const w = setup();
  const seen = [];
  w.push.subscribe((status) => seen.push(status));
  assert.equal(await w.push.enable(), 'on');

  assert.deepEqual(w.m.registerCalls, [{ vapidKey: 'VAPID-KEY', serviceWorkerRegistration: SW }]);
  assert.deepEqual([...w.store.devices], [['fid-1', { uid: 'ana' }]]);
  assert.equal(w.storage.map.get(CHOICE_KEY), 'on');
  assert.equal(w.storage.map.get(FID_KEY), 'fid-1');
  assert.deepEqual(seen, ['off', 'on']);
  assert.equal(w.push.getStatus(), 'on');
  w.onlyAllowedCalls();
});

test('enabling twice keeps one device record', async () => {
  const w = setup();
  assert.equal(await w.push.enable(), 'on');
  assert.equal(await w.push.enable(), 'on');
  const [first, second] = [w.push.enable(), w.push.enable()]; // a double tap
  assert.deepEqual(await Promise.all([first, second]), ['on', 'on']);
  assert.deepEqual([...w.store.devices.keys()], ['fid-1']);
  assert.equal(w.log.includes('remove:fid-1'), false);
  assert.equal(w.N.asked, 1);
});

test('a new installation ID replaces the old device record', async () => {
  const w = setup();
  await w.push.enable();

  w.m.fid = 'fid-2'; // found by the next register call
  assert.equal(await w.push.enable(), 'on');
  assert.deepEqual([...w.store.devices], [['fid-2', { uid: 'ana' }]]);
  assert.equal(w.storage.map.get(FID_KEY), 'fid-2');
  assert.ok(w.log.indexOf('save:fid-2') < w.log.indexOf('remove:fid-1'), 'the new record is saved before the old one goes');

  w.m.fid = 'fid-3'; // found when the app starts again
  await w.push.resume();
  assert.deepEqual([...w.store.devices.keys()], ['fid-3']);

  w.m.onRegistered('fid-4'); // the SDK registered again by itself after the ID changed
  await tick();
  assert.deepEqual([...w.store.devices.keys()], ['fid-4']);
  assert.equal(w.storage.map.get(FID_KEY), 'fid-4');
  assert.equal(w.push.getStatus(), 'on');
  w.onlyAllowedCalls();
});

test('an installation ID reported while reminders are off saves nothing', async () => {
  const w = setup({ permission: 'granted' });
  await w.push.resume();
  await w.push.enable();
  await w.push.disable();
  w.m.onRegistered('fid-9');
  await tick();
  assert.equal(w.store.devices.size, 0);
});

test('an empty vapidKey leaves the option out; registration is still tried', async () => {
  const w = setup({ vapidKey: '' });
  assert.equal(w.push.getStatus(), 'off');
  assert.equal(await w.push.enable(), 'on');
  assert.deepEqual(w.m.registerCalls, [{ serviceWorkerRegistration: SW }]);
  assert.equal('vapidKey' in w.m.registerCalls[0], false);
});

test("enable() never rejects: whatever fails, the status is 'off' and no choice is remembered", async () => {
  const failures = {
    'registration refused (for example no usable Web Push key)': (w) => { w.m.failRegister = async () => { throw new Error('messaging/token-subscribe-failed'); }; },
    'no service worker registration': (w) => { w.sw = null; },
    'the service worker lookup fails': (w) => { w.push = createPush({ store: w.store, swRegistration: async () => { throw new Error('no'); }, deps: { backend: 'firebase', Notification: w.N, localStorage: w.storage, caches: w.caches, browserSupport: () => true, loadMessaging: async () => ({ sdk: w.m.sdk, vapidKey: '', messaging: () => w.m.instance }) } }); },
    'the device record cannot be saved': (w) => { w.store.saveDevice = async () => { throw new Error('permission-denied'); }; },
    'no installation ID is reported': (w) => { w.m.failRegister = async () => {}; },
  };
  for (const [name, breakIt] of Object.entries(failures)) {
    const w = setup();
    breakIt(w);
    assert.equal(await w.push.enable(), 'off', name);
    assert.equal(w.storage.map.has(CHOICE_KEY), false, name);
    assert.equal(w.store.devices.size, 0, name);
  }
});

test('without a service worker registration the SDK is never asked to register', async () => {
  const w = setup({ sw: null });
  assert.equal(await w.push.enable(), 'off');
  assert.deepEqual(w.m.registerCalls, [], 'it would otherwise look for /firebase-messaging-sw.js');
});

test('the messaging code failing to download is tried again by the next enable()', async () => {
  let online = false;
  const w = setup();
  const m = w.m;
  w.push = createPush({
    store: w.store, swRegistration: async () => SW,
    deps: {
      backend: 'firebase', Notification: w.N, localStorage: w.storage, caches: w.caches, browserSupport: () => true,
      loadMessaging: async () => {
        if (!online) throw new Error('offline');
        return { sdk: m.sdk, vapidKey: 'VAPID-KEY', messaging: () => m.instance };
      },
    },
  });
  assert.equal(await w.push.enable(), 'off');
  online = true;
  assert.equal(await w.push.enable(), 'on');
});

// ----------------------------------------------------------------------------------------------- disable

test('disable() deletes the device record, unregisters and forgets the choice', async () => {
  const w = setup();
  await w.push.enable();
  const seen = [];
  w.push.subscribe((status) => seen.push(status));
  await w.push.disable();

  assert.equal(w.store.devices.size, 0);
  assert.equal(w.m.registered, false);
  assert.equal(w.storage.map.has(CHOICE_KEY), false);
  assert.equal(w.storage.map.has(FID_KEY), false);
  assert.deepEqual(seen, ['on', 'off']);
  assert.deepEqual(w.log.filter((entry) => entry.startsWith('remove:')), ['remove:fid-1'], 'deleted once, not again by onUnregistered');
  assert.ok(w.log.includes('unregister'));

  await w.push.resume();
  assert.equal(w.m.registered, false, 'off stays off');
  assert.equal(await w.push.enable(), 'on');
  assert.deepEqual([...w.store.devices.keys()], ['fid-1']);
  w.onlyAllowedCalls();
});

test('disable() after a reload unregisters too (nothing was loaded yet in this page)', async () => {
  const w = setup({ permission: 'granted', stored: ON });
  w.store.devices.set('fid-1', { uid: 'ana' });
  assert.equal(w.push.getStatus(), 'on');
  await w.push.disable();
  assert.equal(w.store.devices.size, 0);
  assert.ok(w.log.includes('unregister'));
  assert.equal(w.push.getStatus(), 'off');
});

test('disable(): a failed unregister is not an error; a device record that cannot be deleted keeps reminders on and rejects', async () => {
  const w = setup();
  await w.push.enable();
  w.m.failUnregister = async () => { throw new Error('offline'); };
  await w.push.disable();
  assert.equal(w.push.getStatus(), 'off');
  assert.equal(w.store.devices.size, 0);

  const v = setup();
  await v.push.enable();
  const removeDevice = v.store.removeDevice;
  v.store.removeDevice = async () => { throw new Error('offline'); };
  await assert.rejects(v.push.disable());
  assert.equal(v.push.getStatus(), 'on', 'the record is still there, so the reminders are too');
  v.store.removeDevice = removeDevice;
  await v.push.disable(); // trying again works
  assert.equal(v.push.getStatus(), 'off');
  assert.equal(v.store.devices.size, 0);
});

// ------------------------------------------------------------------------------------- detach and resume

test('detach() sets the signed-out flag first, removes the device, unregisters and keeps the choice', async () => {
  const w = setup();
  await w.push.enable();
  w.log.length = 0;
  await w.push.detach();

  assert.equal(w.log[0], 'flag:set');
  assert.equal(await w.caches.flag().text(), '1');
  assert.deepEqual([...w.caches.stores.keys()], ['habit-tally-flags']);
  assert.deepEqual([...w.caches.stores.get('habit-tally-flags').keys()], ['/__flags/signed-out']);
  assert.equal(w.store.devices.size, 0);
  assert.equal(w.m.registered, false);
  assert.deepEqual(w.log.filter((entry) => entry.startsWith('remove:')), ['remove:fid-1']);
  assert.equal(w.storage.map.get(CHOICE_KEY), 'on', 'the choice is kept for the next sign-in');
  assert.equal(w.storage.map.has(FID_KEY), false);
  assert.equal(w.push.getStatus(), 'off');
  w.onlyAllowedCalls();
});

test('resume() clears the flag and registers again, so the device belongs to whoever is signed in now', async () => {
  const w = setup();
  await w.push.enable();
  await w.push.detach();
  w.store.uid = 'ben';
  w.log.length = 0;
  await w.push.resume();

  assert.equal(w.caches.flag(), undefined);
  assert.equal(w.log[0], 'flag:clear');
  assert.deepEqual([...w.store.devices], [['fid-1', { uid: 'ben' }]]);
  assert.equal(w.m.registered, true);
  assert.equal(w.push.getStatus(), 'on');
  assert.equal(w.N.asked, 1, 'only the first enable() asked');
  w.onlyAllowedCalls();
});

test('resume() at the start of a visit registers again when reminders are on', async () => {
  const w = setup({ permission: 'granted', stored: ON });
  assert.equal(w.push.getStatus(), 'on');
  await w.push.resume();
  assert.deepEqual(w.m.registerCalls, [{ vapidKey: 'VAPID-KEY', serviceWorkerRegistration: SW }]);
  assert.deepEqual([...w.store.devices], [['fid-1', { uid: 'ana' }]]);
  assert.equal(w.N.asked, 0);
});

test('resume() registers nothing when reminders are off, and never asks when permission is no longer granted', async () => {
  const off = setup({ permission: 'granted' });
  await off.push.resume();
  assert.deepEqual(off.m.registerCalls, []);
  assert.ok(off.log.includes('flag:clear'));

  for (const permission of ['default', 'denied']) {
    const w = setup({ permission, stored: ON });
    await w.push.resume();
    assert.deepEqual(w.m.registerCalls, [], permission);
    assert.equal(w.N.asked, 0, permission);
    assert.equal(w.push.getStatus(), permission === 'denied' ? 'blocked' : 'off');
    assert.equal(w.storage.map.get(CHOICE_KEY), 'on', 'the choice survives');
  }
});

test('resume() never rejects; a failed registration leaves reminders as they were', async () => {
  const w = setup({ permission: 'granted', stored: ON });
  w.m.failRegister = async () => { throw new Error('offline'); };
  await w.push.resume();
  assert.equal(w.push.getStatus(), 'on', 'the earlier registration and record still stand');

  const v = setup({ permission: 'granted', stored: ON, caches: null, localStorage: null });
  await v.push.resume();
  assert.equal(v.push.getStatus(), 'off');
});

test('detach() never rejects, even when every step fails', async () => {
  const w = setup();
  await w.push.enable();
  w.caches.open = async () => { throw new Error('no cache storage'); };
  w.store.removeDevice = async () => { throw new Error('offline'); };
  w.m.failUnregister = async () => { throw new Error('offline'); };
  w.storage.getItem = () => { throw new Error('storage is closed'); };
  w.storage.removeItem = () => { throw new Error('storage is closed'); };
  await w.push.detach();

  // Nothing usable at all: a store without device calls, storage and caches that throw, a loader that fails.
  const broken = createPush({
    store: {},
    swRegistration: async () => { throw new Error('no'); },
    deps: {
      backend: 'firebase', browserSupport: () => true, Notification: fakeNotification('granted'),
      localStorage: { getItem: () => 'on', setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('full'); } },
      caches: { open: () => { throw new Error('no'); } },
      loadMessaging: async () => { throw new Error('offline'); },
    },
  });
  let calls = 0;
  broken.subscribe(() => {
    if (calls++) throw new Error('a listener that throws');
  });
  await broken.detach();
  await broken.resume();
  assert.equal(typeof await broken.enable(), 'string', 'enable() does not reject either');
});

test('detach() keeps the sign-out waiting at most 3 seconds when the network never answers', async () => {
  const w = setup();
  await w.push.enable();
  w.store.removeDevice = never;
  w.m.failUnregister = never;
  const started = performance.now();
  await w.push.detach();
  const took = performance.now() - started;
  assert.ok(took >= 2900 && took < 3400, `took ${Math.round(took)} ms`);
  assert.ok(w.caches.flag(), 'the flag is set although nothing else finished');
  assert.equal(w.storage.map.get(CHOICE_KEY), 'on');
});

test('detach() while a registration is in flight: nothing is saved for the account that is leaving', async () => {
  const w = setup({ permission: 'granted' });
  let finish;
  w.m.failRegister = () => new Promise((resolve) => {
    finish = () => {
      w.m.failRegister = null;
      w.m.registered = true;
      w.m.onRegistered('fid-1');
      resolve();
    };
  });
  const enabling = w.push.enable();
  await tick();
  const detaching = w.push.detach();
  await tick();
  finish();
  assert.equal(await enabling, 'off');
  await detaching;
  assert.equal(w.store.devices.size, 0);
  assert.equal(w.m.registered, false, 'unregistered once the registration had finished');
  assert.ok(w.caches.flag());
});

test('detach() with reminders never turned on only sets the flag', async () => {
  const w = setup();
  await tick();
  await w.push.detach();
  assert.deepEqual(w.log, ['flag:set']);
  assert.ok(w.caches.flag());
});

test('only register, onRegistered, onUnregistered and unregister (and isSupported) are ever used', async () => {
  const w = setup();
  await w.push.enable();
  w.m.fid = 'fid-2';
  await w.push.resume();
  await w.push.detach();
  await w.push.resume();
  await w.push.disable();
  await w.push.enable();
  assert.deepEqual([...w.m.used].sort(), [...ALLOWED].sort());
  assert.throws(() => w.m.sdk.getToken, /must not use getToken/);
  assert.throws(() => w.m.sdk.deleteToken, /must not use deleteToken/);
});
