// Placeholder. Package B1 (Firebase store) replaces this file. Contract: docs/contracts.md section 5.
export function createFirebaseStore({ emulator = false } = {}) {
  const state = { status: 'loading', mode: emulator ? 'emulator' : 'firebase', user: null, habits: [], logs: {}, lastError: null };
  return { getState: () => state, subscribe: (fn) => (fn(state), () => {}) };
}
