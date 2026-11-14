// Reminders on this device: asks for permission, registers the browser with Firebase Cloud Messaging by
// its Firebase installation ID (FID) and keeps the account's device record in step with it.
// Contract: docs/contracts.md section 6.
//
// - The app's own service worker (public/sw.js) shows the pushes, so registration always passes the
//   registration from `swRegistration()`. Without one nothing is registered: the SDK would otherwise look
//   for a /firebase-messaging-sw.js that this app does not have.
// - Only `register`, `onRegistered`, `onUnregistered` and `unregister` (plus `isSupported`) are used. The SDK's
//   `register` asks for permission by itself while it is still undecided, so it is only ever called once
//   permission is granted: the one place that asks is `enable()`.
// - No Firebase code is downloaded in demo mode: the Firebase modules and the configuration are imported
//   dynamically, and only when the backend is 'firebase'.
// - An empty `vapidKey` (the owner has not created the Web Push key yet) leaves the option out, as the
//   contract says. The status is then 'off' as usual and `enable()` tries with the SDK's default key; if the
//   push service or FCM refuses, `enable()` resolves 'off' and nothing is saved.
import { BACKEND } from './store.js';

export const CHOICE_KEY = 'habit-tally:push';
export const FID_KEY = 'habit-tally:push-fid';
export const FLAGS_CACHE = 'habit-tally-flags';
export const SIGNED_OUT_FLAG = '/__flags/signed-out';

/** How long detach() keeps the sign-out waiting. */
const DETACH_WAIT_MS = 3000;
/** How long one network step may take before it counts as failed (nothing here may hang forever). */
const STEP_MS = 10_000;

/** @typedef {'demo' | 'unsupported' | 'off' | 'blocked' | 'on'} PushStatus */
/** The part of `firebase/messaging` this file uses, with the SDK's own signatures.
 *  @typedef {{
 *    isSupported(): Promise<boolean>,
 *    register(messaging: object, options?: { vapidKey?: string, serviceWorkerRegistration?: ServiceWorkerRegistration }): Promise<void>,
 *    onRegistered(messaging: object, next: (fid: string) => void): () => void,
 *    onUnregistered(messaging: object, next: (fid: string) => void): () => void,
 *    unregister(messaging: object): Promise<void>,
 *  }} MessagingSdk */
/** What a loader resolves with. `messaging()` creates the Messaging instance; it is only called once
 *  `isSupported()` has said yes.
 *  @typedef {{ sdk: MessagingSdk, vapidKey: string, messaging: () => object }} Loaded */
/** Stand-ins for tests; every one is optional.
 *  @typedef {{
 *    backend?: string,
 *    loadMessaging?: () => Promise<Loaded>,
 *    Notification?: { permission: string, requestPermission: (cb?: (p: string) => void) => Promise<string> | void } | null,
 *    localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
 *    caches?: Pick<CacheStorage, 'open'> | null,
 *    browserSupport?: () => boolean,
 *  }} PushDeps */

/** The real messaging service. @returns {Promise<Loaded>} */
async function loadFirebaseMessaging() {
  const [app, messaging, config] = await Promise.all([
    import('firebase/app'), import('firebase/messaging'), import('./firebase-config.js'),
  ]);
  const { isSupported, register, onRegistered, onUnregistered, unregister } = messaging;
  return {
    sdk: { isSupported, register, onRegistered, onUnregistered, unregister },
    vapidKey: config.vapidKey,
    // The store has created the default Firebase app by now; if it has not, create it from the same config.
    messaging: () => messaging.getMessaging(app.getApps().length ? app.getApp() : app.initializeApp(config.firebaseConfig)),
  };
}

/** @template T @param {() => T} read @returns {T | undefined} */
function attempt(read) {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** `promise`, or a rejection after STEP_MS. @template T @param {Promise<T> | T} promise @returns {Promise<T>} */
function within(promise) {
  /** @type {any} */
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(reject, STEP_MS, new Error('timed out'));
    timer?.unref?.(); // under Node (tests) a pending step must not keep the process alive
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, late]).finally(() => clearTimeout(timer)));
}

/**
 * @param {{ store: { saveDevice(fid: string): Promise<void>, removeDevice(fid: string): Promise<void> },
 *           swRegistration: () => Promise<ServiceWorkerRegistration | null>, deps?: PushDeps }} options
 */
export function createPush({ store, swRegistration, deps = {} }) {
  const demo = (deps.backend ?? BACKEND) !== 'firebase';
  const N = 'Notification' in deps ? deps.Notification : attempt(() => globalThis.Notification);
  const storage = 'localStorage' in deps ? deps.localStorage : attempt(() => globalThis.localStorage);
  const cacheStorage = 'caches' in deps ? deps.caches : attempt(() => globalThis.caches);
  const load = deps.loadMessaging ?? loadFirebaseMessaging;
  const browserSupport = deps.browserSupport
    ?? (() => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in globalThis);
  const hasBrowserApis = !demo && Boolean(N) && Boolean(attempt(browserSupport));

  /** What `isSupported()` said; null until it has answered. @type {boolean | null} */
  let sdkSupported = null;
  /** True from detach() until resume(): nothing is saved for an account that is signing out. */
  let detached = false;
  /** True while resume() waits for a saved device record before it clears the signed-out flag. */
  let flagHeld = false;
  /** The device record removed last, so that an explicit removal and onUnregistered do not both delete it. */
  let dropped = '';

  // ------------------------------------------------------------------------------- remembered per browser

  const read = (/** @type {string} */ key) => attempt(() => storage?.getItem(key)) ?? null;
  const write = (/** @type {string} */ key, /** @type {string} */ value) => void attempt(() => storage?.setItem(key, value));
  const forget = (/** @type {string} */ key) => void attempt(() => storage?.removeItem(key));

  // ---------------------------------------------------------------------------------------------- status

  /** @returns {PushStatus} */
  function getStatus() {
    if (demo) return 'demo';
    if (!hasBrowserApis || !N || sdkSupported === false) return 'unsupported';
    const permission = attempt(() => N.permission);
    if (permission === 'denied') return 'blocked';
    return permission === 'granted' && read(CHOICE_KEY) === 'on' && read(FID_KEY) ? 'on' : 'off';
  }

  /** @type {Set<(status: PushStatus) => void>} */
  const listeners = new Set();
  let announced = getStatus();

  /** Tell the listeners when the status is no longer the one they were told. Never throws. */
  function emit() {
    const status = getStatus();
    if (status === announced) return;
    announced = status;
    for (const fn of [...listeners]) attempt(() => fn(status));
  }

  // ------------------------------------------------------------------------------- the signed-out flag

  async function setFlag() {
    try {
      const cache = await /** @type {CacheStorage} */ (cacheStorage).open(FLAGS_CACHE);
      await cache.put(SIGNED_OUT_FLAG, new Response('1'));
    } catch { /* no Cache Storage here: the worker then cannot tell, and unregistering below still applies */ }
  }

  async function clearFlag() {
    try {
      const cache = await /** @type {CacheStorage} */ (cacheStorage).open(FLAGS_CACHE);
      await cache.delete(SIGNED_OUT_FLAG);
    } catch { /* nothing to clear */ }
  }

  // ------------------------------------------------------------------------------------ the messaging SDK

  /** @type {Promise<Loaded> | null} */
  let loading = null;

  /** Download the messaging code (once) and ask it whether this browser can do push. A failed download is
   *  tried again by the next call. @returns {Promise<Loaded>} */
  function loadSdk() {
    if (loading) return loading;
    const started = load().then(async (loaded) => {
      sdkSupported = Boolean(await loaded.sdk.isSupported().catch(() => false));
      return loaded;
    });
    loading = started;
    started.catch(() => {
      if (loading === started) loading = null;
    });
    return started;
  }

  /** @type {{ sdk: MessagingSdk, messaging: object, vapidKey: string } | null} */
  let session = null;

  /** The messaging instance with this file's two listeners on it. Only called from inside `serial`. */
  async function connect() {
    if (session) return session;
    const loaded = await loadSdk();
    if (!sdkSupported) throw new Error('push is not supported in this browser');
    const messaging = loaded.messaging();
    loaded.sdk.onRegistered(messaging, onRegisteredFid);
    loaded.sdk.onUnregistered(messaging, onUnregisteredFid);
    session = { sdk: loaded.sdk, messaging, vapidKey: loaded.vapidKey };
    return session;
  }

  // One operation at a time: a sign-out during a registration, or two taps, must not interleave.
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} step @returns {Promise<T>} */
  function serial(step) {
    const result = queue.then(step);
    queue = result.catch(() => {});
    return result;
  }

  let registering = false;
  let registeredFid = '';
  /** True from a register() call in this page until an unregister() succeeds. */
  let maybeRegistered = false;

  /** onRegistered: the SDK reports the installation ID on every register() call, and by itself when the
   *  ID changes. @param {string} fid */
  function onRegisteredFid(fid) {
    if (typeof fid !== 'string' || !fid) return;
    registeredFid = fid;
    if (registering) return; // registerDevice() is waiting for it
    // The SDK registered again without being asked: the ID changed. Move the device record with it.
    const saved = read(FID_KEY);
    if (!detached && read(CHOICE_KEY) === 'on' && saved && saved !== fid) {
      serial(() => saveFid(fid)).catch(() => {}).then(emit);
    }
  }

  /** onUnregistered: FCM no longer knows this installation ID, so its device record goes too.
   *  @param {string} fid */
  function onUnregisteredFid(fid) {
    if (typeof fid !== 'string' || !fid) return;
    if (read(FID_KEY) === fid) forget(FID_KEY);
    if (!detached) dropDevice(fid).catch(() => {}); // after a sign-out the record is no longer ours to delete
    emit();
  }

  /** Delete a device record, once. @param {string | null} fid */
  async function dropDevice(fid) {
    if (!fid || fid === dropped) return;
    dropped = fid;
    try {
      await within(store.removeDevice(fid));
    } catch (err) {
      dropped = '';
      throw err;
    }
  }

  /** Save the device record for `fid` under the signed-in account and remember it; a record under an
   *  earlier ID is removed. @param {string} fid */
  async function saveFid(fid) {
    if (detached) throw new Error('signed out');
    await within(store.saveDevice(fid));
    dropped = '';
    if (detached) { // the sign-out began while the record was being written: take it back
      await dropDevice(fid).catch(() => {});
      throw new Error('signed out');
    }
    const old = read(FID_KEY);
    write(FID_KEY, fid);
    if (flagHeld) { // the record now points at the signed-in account: the worker may show reminder text again
      flagHeld = false;
      await clearFlag();
    }
    if (old && old !== fid) await dropDevice(old).catch(() => {});
  }

  /** Register with FCM and save the device. Throws when any step fails. Never asks for permission. */
  async function registerDevice() {
    const { sdk, messaging, vapidKey } = await connect();
    const registration = await swRegistration();
    if (!registration) throw new Error('no service worker to receive reminders');
    if (!N || N.permission !== 'granted') throw new Error('notifications are not allowed');
    registering = true;
    registeredFid = '';
    maybeRegistered = true;
    try {
      await within(sdk.register(messaging, { ...(vapidKey ? { vapidKey } : {}), serviceWorkerRegistration: registration }));
    } finally {
      registering = false;
    }
    if (!registeredFid) throw new Error('no installation ID was reported');
    await saveFid(registeredFid);
  }

  async function unregisterDevice() {
    const { sdk, messaging } = await connect();
    await within(sdk.unregister(messaging));
    maybeRegistered = false;
  }

  /** Ask the browser. Resolves with the permission afterwards; old Safari answers through a callback.
   *  @returns {Promise<string>} */
  function askPermission() {
    return new Promise((resolve) => {
      const done = () => resolve(attempt(() => /** @type {any} */ (N).permission) ?? 'default');
      try {
        const asked = /** @type {any} */ (N).requestPermission(done);
        if (asked && typeof asked.then === 'function') asked.then(done, done);
      } catch {
        done();
      }
    });
  }

  // ------------------------------------------------------------------------------------------- the calls

  /** Call only from a tap handler. Never rejects. @returns {Promise<PushStatus>} */
  async function enable() {
    try {
      const before = getStatus();
      if (before === 'demo' || before === 'unsupported') return before;
      let permission = /** @type {any} */ (N).permission;
      // Nothing is awaited before this line, so the browser still sees the tap that called enable().
      if (permission === 'default') permission = await askPermission();
      if (permission === 'granted') {
        await serial(async () => {
          await registerDevice();
          write(CHOICE_KEY, 'on');
        });
      }
    } catch { /* not turned on: the status below says what the person can do next */ }
    emit();
    return getStatus();
  }

  /** The person turns reminders off. Rejects, with reminders still on, when the device record could not be
   *  deleted (it is what the reminder job sends to); a failed unregister afterwards is not an error.
   *  @returns {Promise<void>} */
  async function disable() {
    if (demo) return;
    try {
      await serial(async () => {
        await dropDevice(read(FID_KEY));
        forget(CHOICE_KEY);
        forget(FID_KEY);
        emit();
        if (hasBrowserApis) await unregisterDevice().catch(() => {});
      });
    } finally {
      emit();
    }
  }

  /** For sign-out. Waits at most 3 s and never rejects. @returns {Promise<void>} */
  async function detach() {
    if (demo) return;
    detached = true;
    flagHeld = false;
    /** @type {any} */
    let timer;
    const work = (async () => {
      await setFlag(); // first, and it needs no network: from here on the worker shows nothing personal
      const fid = read(FID_KEY);
      const registered = Boolean(fid) || read(CHOICE_KEY) === 'on' || maybeRegistered;
      forget(FID_KEY); // the choice stays, for resume()
      await Promise.allSettled([
        dropDevice(fid), // at once: after the sign-out the rules would refuse it
        registered && hasBrowserApis ? serial(unregisterDevice) : null,
      ]);
    })().catch(() => {});
    await Promise.race([work, new Promise((resolve) => {
      timer = setTimeout(resolve, DETACH_WAIT_MS);
    })]);
    clearTimeout(timer);
    emit();
  }

  /** Call when the store becomes 'ready'. Never rejects; never asks for permission. @returns {Promise<void>} */
  async function resume() {
    if (demo) return;
    detached = false;
    if (hasBrowserApis && N && read(CHOICE_KEY) === 'on' && attempt(() => N.permission) === 'granted') {
      // The earlier person's device record and FCM registration may have survived an offline sign-out, so
      // the flag stays until the record points at the account that is signed in now. A failed registration
      // leaves reminders as they were (the status says which) and the flag in place: the worker keeps to
      // the generic text until a later resume() or enable() gets through.
      flagHeld = true;
      await serial(registerDevice).catch(() => {});
    } else {
      await clearFlag();
    }
    emit();
  }

  /** @param {(status: PushStatus) => void} fn @returns {() => void} */
  function subscribe(fn) {
    listeners.add(fn);
    fn(getStatus());
    return () => void listeners.delete(fn);
  }

  // Find out early whether the SDK agrees that push works here, so Settings can say "unsupported" before
  // anyone taps. Nothing is registered and nobody is asked.
  if (hasBrowserApis) loadSdk().then(emit, () => {});

  return { getStatus, subscribe, enable, disable, detach, resume };
}
