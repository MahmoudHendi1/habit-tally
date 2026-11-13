// The seam between the screens and the backend. Contract: docs/contracts.md sections 2 and 5.

/** @typedef {'demo' | 'emulator' | 'firebase'} Backend */

const BACKENDS = ['demo', 'emulator', 'firebase'];

/** @returns {Backend} */
function pickBackend() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo')) return 'demo';
  } catch { /* no address to read: fall through */ }
  const fromBuild = import.meta.env?.VITE_BACKEND;
  return BACKENDS.includes(fromBuild) ? fromBuild : 'firebase';
}

/** Which backend this page runs on. */
export const BACKEND = pickBackend();

/** True when the address asks for sample data in demo mode (?demo=sample). */
export const WANTS_SAMPLE = (() => {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === 'sample';
  } catch {
    return false;
  }
})();

/** Error thrown or rejected by store calls. `code` is one of the codes in docs/contracts.md section 5;
 *  `message` is a plain sentence the UI can show as it is. */
export class StoreError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

/** Create the store for this page. Firebase code is only downloaded when it is needed. */
export async function createStore() {
  if (BACKEND === 'demo') {
    const { createLocalStore } = await import('./store-local.js');
    return createLocalStore({ sample: WANTS_SAMPLE });
  }
  const { createFirebaseStore } = await import('./store-firebase.js');
  return createFirebaseStore({ emulator: BACKEND === 'emulator' });
}
