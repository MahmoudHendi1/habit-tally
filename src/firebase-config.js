// Public Firebase web configuration for the "habit-tally" project.
// These values identify the project to Google; they are not secrets. Access is enforced by
// Firestore security rules (firestore.rules), not by hiding this file.
export const firebaseConfig = {
  apiKey: 'AIzaSyB26e4dq4dX-JXHDol5tSM-e2vZH04bcXk',
  authDomain: 'habit-tally.firebaseapp.com',
  projectId: 'habit-tally',
  storageBucket: 'habit-tally.firebasestorage.app',
  messagingSenderId: '929979107422',
  appId: '1:929979107422:web:b6c56a0572abac3be28ccf',
};

// Web Push public key (Firebase console > Project settings > Cloud Messaging > Web Push certificates).
// Public by design. While it is empty, push registration leaves the option out.
export const vapidKey = '';

// Used when BACKEND is 'emulator' (npm run dev:emulator, emulator tests). The "demo-" project id
// guarantees that nothing can reach a real Firebase project.
export const emulatorConfig = {
  firebase: { apiKey: 'demo-key', authDomain: 'demo-habit-tally.firebaseapp.com', projectId: 'demo-habit-tally', appId: 'demo-app' },
  firestoreHost: '127.0.0.1',
  firestorePort: 8080,
  authUrl: 'http://127.0.0.1:9099',
};
