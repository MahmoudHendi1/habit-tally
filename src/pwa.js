// The PWA part of the page: registering the service worker (public/sw.js: offline shell and reminder
// notifications). Nothing here touches the browser until initPwa() is called, so the module can be
// imported by Node tests. Installing is left to the browser's own "Install" offer.
//
// Updates: the browser fetches /sw.js again on each launch (and we ask at most hourly when the app comes
// back to the front). A changed worker installs in the background and takes over on the next launch, once
// every window of the app has been closed. Nothing is reloaded or swapped while the app is in use.

const SW_URL = '/sw.js';
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const READY_TIMEOUT_MS = 10_000;

/** Start the PWA parts. Call once at start-up. Never throws, also where service workers or `window` do
 *  not exist. The worker is registered only in production builds (`vite build`, demo build included):
 *  the dev server has no built file list, so there `swRegistration()` resolves null.
 *  @returns {{ swRegistration: () => Promise<ServiceWorkerRegistration | null> }}  `swRegistration()` never
 *    rejects. It resolves with the registration once its worker is active, or null where there is none
 *    (dev server, no service worker support, registration failed, or no worker active within 10 seconds). */
export function initPwa() {
  /** @type {Promise<ServiceWorkerRegistration | null>} */
  let registered = Promise.resolve(null);
  try {
    if (import.meta.env?.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) registered = register();
  } catch { /* the app works without a service worker */ }

  return {
    async swRegistration() {
      try {
        const registration = await registered;
        if (!registration || registration.active) return registration;
        return await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => setTimeout(resolve, READY_TIMEOUT_MS, null)),
        ]);
      } catch {
        return null;
      }
    },
  };
}

/** Register the worker once the page has loaded, so it never competes with the first paint. Resolves with
 *  the registration, or null if registering failed. Never rejects.
 *  @returns {Promise<ServiceWorkerRegistration | null>} */
async function register() {
  try {
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    }
    // updateViaCache 'none': the check for a new worker never reads /sw.js from the HTTP cache.
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
    let checked = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || Date.now() - checked < UPDATE_CHECK_MS) return;
      checked = Date.now();
      registration.update().catch(() => { /* offline: the next launch checks again */ });
    });
    return registration;
  } catch {
    return null;
  }
}
