// Placeholder. Package A1 (demo store) replaces this file. Contract: docs/contracts.md section 5.
export function createLocalStore() {
  const state = { status: 'loading', mode: 'demo', user: null, habits: [], logs: {}, lastError: null };
  return { getState: () => state, subscribe: (fn) => (fn(state), () => {}) };
}
