// Habit Tally service worker: the offline app shell and the display of reminder notifications.
// A plain script: no imports and no push SDK (docs/contracts.md section 7).
//
// WHAT IS CACHED, AND WHEN IT UPDATES
// - The build puts one line above this comment: self.__BUILD = { version, files } (vite.config.js).
//   `files` is every built file except sw.js; `version` is a hash of them. Without that line (dev) nothing
//   is cached and no request is intercepted.
// - install:  every file in `files` is downloaded into the cache `habit-tally-shell-<version>`. All or nothing:
//             if one download fails the install fails, the browser retries on a later visit, and the worker
//             that is active now stays in charge.
// - activate: older `habit-tally-shell-*` caches are deleted. A new version is never activated early (no
//             skipWaiting): it waits until every window of the app is closed, so it takes over on the next
//             launch and a running app never has its files swapped underneath it.
// - fetch, same-origin GET only:
//     a page navigation -> network first; after NAVIGATION_TIMEOUT_MS, or when offline or on a server error,
//                          the cached "/" (hosting answers every app path with the same shell);
//     a precached file, or anything under /assets/ -> cache first, then the network. Asset names contain
//                          a hash, so a cached copy is never stale, and a copy in any version's cache will
//                          do: a page whose HTML is newer than this worker finds its assets in the cache
//                          the waiting worker has filled;
//     anything else, other origins and non-GET requests -> not intercepted at all, and never cached.
// - The cache `habit-tally-flags` belongs to src/push.js (the signed-out flag). It is only read here.

const BUILD = self.__BUILD || null;
const CACHE_PREFIX = 'habit-tally-shell-';
const CACHE = BUILD ? CACHE_PREFIX + BUILD.version : null;
const PRECACHED = new Set(BUILD ? BUILD.files : []);
const SHELL = '/';
const ASSETS = '/assets/';
const NAVIGATION_TIMEOUT_MS = 3000;

const FLAGS_CACHE = 'habit-tally-flags';
const SIGNED_OUT_FLAG = '/__flags/signed-out';

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';
const GENERIC = Object.freeze({ title: 'Habit Tally', body: 'Time to check your habits.', tag: 'habit-tally', url: '/' });
const TITLE_MAX = 60, BODY_MAX = 120, TAG_MAX = 64;

// ---------------------------------------------------------------------------------------------- cache

self.addEventListener('install', (event) => {
  if (!CACHE) return;
  // addAll() stores nothing unless every response arrived with an OK status. 'reload' skips the HTTP cache,
  // so the shell and the unhashed files (manifest, icons) are the ones of this build.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(BUILD.files.map((path) => new Request(path, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (CACHE) {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)));
    }
    // Only has an effect on the very first install, when the open page has no worker yet. Later versions
    // activate when no page is open, so there is nothing to take over.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!CACHE || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path !== SHELL && (PRECACHED.has(path) || path.startsWith(ASSETS))) event.respondWith(cacheFirst(request, path));
  else if (request.mode === 'navigate') event.respondWith(shellNetworkFirst(request));
});

/** @param {string} path @returns {Promise<Response | undefined>} */
async function fromCache(path) {
  const cache = await caches.open(/** @type {string} */ (CACHE));
  return cache.match(path, { ignoreVary: true });
}

/** A precached file or a hashed asset: this version's copy, for an asset any version's copy, or the network
 *  (the cache was cleared, or the asset is not part of this build). Nothing is stored here.
 *  @param {Request} request @param {string} path @returns {Promise<Response>} */
async function cacheFirst(request, path) {
  const cached = (await fromCache(path).catch(() => undefined))
    || (path.startsWith(ASSETS) ? await caches.match(path, { ignoreVary: true }).catch(() => undefined) : undefined);
  return cached || fetch(request);
}

/** A page navigation: the network's answer if it comes in time, otherwise the cached shell.
 *  @param {Request} request @returns {Promise<Response>} */
async function shellNetworkFirst(request) {
  const network = fetch(request);
  const settled = network.catch(() => null);
  const first = await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null))]);
  if (first && (first.ok || first.type === 'opaqueredirect')) return first;
  const cached = await fromCache(SHELL).catch(() => undefined);
  if (cached) return cached;
  // No cached shell (storage was cleared): the network is all there is, however slow or broken.
  return (await settled) || network;
}

// ---------------------------------------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  // A notification is always shown, inside waitUntil: Chrome requires every push to be visible.
  event.waitUntil(showReminder(event));
});

/** @param {PushEvent} event */
async function showReminder(event) {
  let message = GENERIC;
  try {
    const own = readMessage(event);
    if (own && !(await signedOut())) message = own;
  } catch {
    message = GENERIC; // unreadable payload, or the flag could not be checked: say nothing personal
  }
  try {
    await notify(message);
  } catch {
    if (message !== GENERIC) await notify(GENERIC).catch(() => {});
  }
}

/** @param {{ title: string, body: string, tag: string, url: string }} message */
function notify(message) {
  return self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag, // one notification per habit: a later reminder replaces the earlier one...
    renotify: true, // ...and alerts again
    icon: ICON,
    badge: BADGE,
    data: { url: message.url },
  });
}

/** The reminder in a push message, or null when it has no usable title. Throws on unreadable data.
 *  The message is `{ data: { title, body, tag, url }, ... }` (docs/contracts.md section 7).
 *  @param {PushEvent} event @returns {{ title: string, body: string, tag: string, url: string } | null} */
function readMessage(event) {
  if (!event.data) return null;
  const payload = event.data.json();
  const data = payload && typeof payload === 'object' ? payload.data : null;
  if (!data || typeof data !== 'object') return null;
  const title = text(data.title, TITLE_MAX);
  if (!title) return null;
  return { title, body: text(data.body, BODY_MAX), tag: text(data.tag, TAG_MAX) || GENERIC.tag, url: safeUrl(data.url) };
}

/** @param {unknown} value @param {number} max @returns {string} trimmed, at most `max` characters */
function text(value, max) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, max).join('').trim() : '';
}

/** Only an address inside this app is ever opened: a relative path on this origin. Anything else is "/".
 *  @param {unknown} value @returns {string} */
function safeUrl(value) {
  if (typeof value !== 'string' || !/^\/(?![/\\])/.test(value)) return GENERIC.url;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search + url.hash : GENERIC.url;
  } catch {
    return GENERIC.url;
  }
}

/** True while the last person on this device has signed out (docs/contracts.md section 6): src/push.js
 *  keeps a response under SIGNED_OUT_FLAG until someone signs in again. @returns {Promise<boolean>} */
async function signedOut() {
  return Boolean(await caches.match(SIGNED_OUT_FLAG, { cacheName: FLAGS_CACHE }));
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openApp(safeUrl(event.notification.data && event.notification.data.url)));
});

/** Bring an open app window to the front, or open one at `path`. An open window is left on the screen it
 *  shows (reminders always link to "/", and going there again would only reload the app).
 *  @param {string} path */
async function openApp(path) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => client.visibilityState === 'visible') || windows[0];
  if (open) {
    try {
      await open.focus();
      return;
    } catch {
      // The window went away in the meantime: open a new one.
    }
  }
  await self.clients.openWindow(path);
}
