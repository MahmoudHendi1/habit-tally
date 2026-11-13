// Placeholder. Package A2 (app skeleton) replaces this file.
import { createStore, BACKEND } from './store.js';

const store = await createStore();
document.querySelector('#app').textContent = `Habit Tally (${BACKEND}): ${store.getState().status}`;
