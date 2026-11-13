// Placeholder. Package B5 (push registration) replaces this file. Contract: docs/contracts.md section 6.
export function createPush() {
  return {
    getStatus: () => 'demo',
    subscribe: (fn) => (fn('demo'), () => {}),
    enable: async () => 'demo',
    disable: async () => {},
    resume: async () => {},
  };
}
