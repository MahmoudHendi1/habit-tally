# Habit Tally: contracts (v1.2)

The interfaces where two packages meet. Owned by the lead; a developer who needs a change asks the lead. Read
`docs/architecture.md` first. Anything not fixed here is the owning package's choice.

## 1. Versions and scripts

- Node 22, ES modules everywhere. `firebase` 13.3 (modular API only), `vite` 7, `@playwright/test` 1.63.0 (its
  Chromium is already installed; never run `playwright install`), `firebase-tools` 15 and
  `@firebase/rules-unit-testing` 6 for the emulator.
- Scripts (`package.json` is lead-only):

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server in **demo** mode |
| `npm run dev:emulator` | Vite dev server against the local emulators (start them with `npm run emulators`) |
| `npm run build` | Production build to `dist/` (real Firebase) |
| `npm run build:demo` | Demo build to `dist-demo/` |
| `npm test` | `node --test test/*.test.mjs`: fast tests, no network, no emulator, no browser |
| `npm run test:emulator` | Starts the Firestore and Auth emulators and runs `node --test test/emulator/*.test.mjs` |
| `npm run test:e2e` | Builds the demo and runs Playwright (`playwright.config.js`, owned by A7) |
| `npm run test:e2e:emulator` | Playwright against the emulators (`playwright.emulator.config.js`, owned by L1) |

- Emulator project id: `demo-habit-tally`. Ports: Firestore `127.0.0.1:8080`, Auth `127.0.0.1:9099`.

## 2. Backend switch

`src/store.js` exports `BACKEND`, one of `'demo' | 'emulator' | 'firebase'`:

1. `?demo` in the page address forces `'demo'` (`?demo=sample` also loads sample data when storage is empty).
2. Otherwise `import.meta.env.VITE_BACKEND` if it is one of the three values.
3. Otherwise `'firebase'`.

In demo mode no Firebase code may be downloaded: `store-firebase.js` and `push.js`'s Firebase imports are loaded
with dynamic `import()` only when `BACKEND !== 'demo'`.

## 3. Shared logic (`shared/logic.js`)

Pure functions, no DOM, no Firebase, runs unchanged in the browser and in Node. Both stores, every screen and the
job must use these instead of re-implementing them: `LIMITS`, `keyOf`, `addDays`, `weekStart`, `weekKeys`,
`countOn`, `startDay`, `periodCount`, `isHit`, `streak`, `stats`, `summary`, `recentDays`, `calendarWeeks`, `cleanHabit`,
`validateHabit`, `sortHabits`, `snapTime`, `cleanTimes`, `everyHours`, `localParts`, `planRun`, `dueTimes`,
`dueWindows`, `dueHabits`, `reminderText`. Their behaviour is defined by the doc comments and `test/logic.test.mjs`.

`LIMITS = { nameMax: 60, unitMax: 20, targetMin: 1, targetMax: 50, timesMax: 48, habitsMax: 50, backDays: 7 }`.
"Last 7 days" (R6) means today plus the 7 days before it: `recentDays(today)`.

## 4. Data shapes

```
Habit   { id: string,               // set by the store: 20 chars of [A-Za-z0-9]
          name: string,             // 1..60 chars, trimmed
          period: 'day' | 'week',
          target: integer,          // 1..50
          unit: string,             // 0..20 chars
          times: string[],          // 'HH:MM' on :00 or :30, unique, sorted, at most 48
          created: 'YYYY-MM-DD',    // set by the store to the device's today on create; never changed.
                                    // The first day that counts is derived: startDay(habit, logs)
          archived: boolean,        // always false in v1 (no UI), kept for later
          deletedAt: null | number, // ms since epoch when soft-deleted
          order: number,            // set by the store on create: highest existing order + 1
          updatedAt: number }       // ms since epoch, set by the store on every save
Logs    { 'YYYY-MM': { 'YYYY-MM-DD': { [habitId]: number } } }     // all months the user has
User    { uid: string, email: string, tz: string }                 // tz = IANA zone used for reminders
```

Firestore documents (see architecture section 3) store exactly these fields: a habit document has every Habit
field except `id` (the document id); `users/{uid}` is `{ tz, createdAt, updatedAt }` with numbers in ms;
`users/{uid}/logs/{YYYY-MM}` is `{ days: { 'YYYY-MM-DD': { [habitId]: number } } }`;
`devices/{fid}` is `{ uid, ua, updatedAt }`; `system/reminders` is `{ lastSlot, updatedAt }`.
All timestamps are plain numbers (ms since epoch), never Firestore Timestamp values, so the job and the rules
stay simple.

## 5. Store (`src/store.js`, `src/store-local.js`, `src/store-firebase.js`)

`createStore(): Promise<Store>` in `src/store.js` picks the implementation from `BACKEND`.
`src/store-local.js` exports `createLocalStore({ storage, now, tz, sample })` and `src/store-firebase.js` exports
`createFirebaseStore({ emulator, now })`. Both return the same Store and both must pass the shared contract tests
in `test/store-contract.mjs` (written by A1, reused by B1).

### State

```
State { status: 'loading' | 'signedOut' | 'waiting' | 'ready',
        mode: 'demo' | 'emulator' | 'firebase',
        user: null | User,          // set when status is 'waiting' or 'ready'
        habits: Habit[],            // sortHabits(): deleted ones left out
        logs: Logs,
        lastError: null | { code: string, message: string } }   // a write the backend refused later
```

- `waiting` = signed in, but the rules refuse this account (not on the invite list). Never happens in demo mode.
- State is replaced, never mutated: every change produces a new `State` object (unchanged parts may be shared).
- `habits` and `logs` are empty unless status is `ready`.

### Calls

| Call | Behaviour |
|---|---|
| `getState(): State` | Current state |
| `subscribe(fn): () => void` | Calls `fn(state)` at once and after every change; returns an unsubscribe function |
| `signUp(email, password): Promise<void>` | Creates the account and signs in. Resolves once the status is `ready` or `waiting` |
| `signIn(email, password): Promise<void>` | Resolves once the status is `ready` or `waiting` |
| `resetPassword(email): Promise<void>` | Always resolves for a well-formed email (no account enumeration) |
| `signOut(): Promise<void>` | Status becomes `signedOut`; habits and logs are cleared from state |
| `retry(): void` | In `waiting`: checks again whether the account is now allowed |
| `saveHabit(input): string` | `input` is editor data, with `id` to edit or without to create. The store runs `cleanHabit` and `validateHabit`; on problems it throws `StoreError('invalid', problems[0], problems)`. On create it sets `id`, `created` (device today), `order`, `archived: false`, `deletedAt: null`. Editing never changes `id`, `created`, `order`. Creating beyond `LIMITS.habitsMax` live habits throws `StoreError('too-many', ...)`. Returns the id |
| `deleteHabit(id): void` | Soft delete: sets `deletedAt`. The habit leaves `state.habits`; its counts stay in `logs` |
| `restoreHabit(id): void` | Clears `deletedAt` (Undo). Throws `StoreError('too-many', ...)` if that would exceed `LIMITS.habitsMax` live habits |
| `addCount(dayKey, habitId, delta): void` | `delta` is `+1` or `-1`. Ignored when `delta` is `-1` and `countOn` is 0, when `dayKey` is in the future, or older than `LIMITS.backDays` days before today. Never changes the habit itself: a count on a day before `created` is picked up by `startDay()` |
| `setTimeZone(tz): void` | Changes `user.tz` (only called after the person says yes) |
| `saveDevice(fid): Promise<void>` | Writes `devices/{fid}` for the signed-in user. Demo: resolves, does nothing |
| `removeDevice(fid): Promise<void>` | Deletes `devices/{fid}`. Demo: resolves, does nothing |

- `saveHabit`, `deleteHabit`, `restoreHabit`, `addCount`, `setTimeZone` are synchronous and optimistic: state
  changes and listeners fire before they return, and they never wait for the network (offline must feel the
  same). If the backend later refuses a write, the store sets `lastError`.
- Counts are written with `increment(delta)` through `setDoc(..., { merge: true })` with nested objects
  (`{ days: { [dayKey]: { [habitId]: increment(delta) } } }`), never with dotted field paths.
- "Today" is always the device's local day: `keyOf(now())`.
- The user record: whenever an allowed account has no `users/{uid}` record (first sign-in, or the first time it
  is let in after being invited, including after `retry()`), the store creates it with the device's zone before
  the status becomes `ready`. Sign-up alone cannot create it, because a new account is not invited yet.
- The object passed to listeners is the same object `getState()` returns at that moment.
- While the status is not `ready`: `saveHabit` throws `StoreError('not-ready', ...)`; `deleteHabit`,
  `restoreHabit`, `addCount` and `setTimeZone` do nothing.
- Unknown ids and bad input: `saveHabit` with an `id` that does not exist throws `StoreError('not-found', ...)`;
  editing a soft-deleted habit is allowed and it stays deleted. `deleteHabit`, `restoreHabit` and `addCount` on an
  unknown id do nothing, as does `addCount` on a deleted habit, with a delta other than `+1`/`-1`, or with a
  malformed day key. `setTimeZone` ignores an invalid or unchanged zone.
- `order`: the first habit gets 1; deleted habits count towards the highest.
- `lastError` is `{ code: 'not-saved', message }` when a write could not be saved (the backend refused it, or
  browser storage failed). The optimistic state stays as it is; the next write that succeeds clears `lastError`.
- `removeDevice` resolves even when the record does not exist or now belongs to someone else.

### Errors

`StoreError extends Error` with `code` and optional `details`, exported from `src/store.js`. Sign-in calls
reject with one of: `invalid-email`, `wrong-credentials` (wrong password or unknown email, not told apart),
`email-in-use`, `weak-password` (fewer than 6 characters), `too-many-requests`, `offline`, `unknown`.
The message is a plain sentence the UI can show as is.

### Demo store

- On the first visit (empty storage) it starts **signed in** as `demo@habit-tally.example` with no habits; with `sample: true` (from `?demo=sample`) and
  empty storage it loads the sample fixture (16 weeks, one daily and one weekly habit).
- Sign-out shows the sign-in screen and is remembered across reloads; any well-formed email with a password of 6 or more characters signs in or up.
  There is one data set per browser, whatever the email. Two demo tabs do not see each other's changes until
  reload (accepted demo limit).
- Everything is kept in `storage` (default `localStorage`) under the single key `habit-tally:v1`. Missing or
  damaged data starts clean without an error.

## 6. Push (`src/push.js`) and the Settings screen

```
createPush({ store, swRegistration }): Push        // swRegistration: () => Promise<ServiceWorkerRegistration | null>
push.getStatus(): 'demo' | 'unsupported' | 'off' | 'blocked' | 'on'
push.subscribe(fn): () => void                     // fn(status) at once and on change
push.enable(): Promise<status>     // call only from a tap handler: asks permission, registers, saves the device.
                                   // Never rejects: resolves with the status it ended in
push.disable(): Promise<void>      // the person turns reminders off: forgets the choice, removes the device
                                   // record, unregisters from FCM
push.detach(): Promise<void>       // for sign-out: keeps the choice, sets the signed-out flag (below), removes the
                                   // device record and unregisters. Waits at most 3 s and never rejects
push.resume(): Promise<void>       // call when the store becomes 'ready': clears the signed-out flag; if this
                                   // browser has reminders on and permission is still granted, registers again
                                   // so the device record points at the account that is signed in now
```

- `demo`: `BACKEND` is not `'firebase'`. `unsupported`: no service worker, Notification or PushManager, or
  `isSupported()` is false. `blocked`: permission denied. `off`: can be turned on. `on`: registered and saved.
- Registration uses only `register(messaging, { vapidKey, serviceWorkerRegistration })`, `onRegistered`,
  `onUnregistered`, `unregister` from `firebase/messaging`. `getToken` and `deleteToken` are deprecated and must
  not be used. `vapidKey` comes from `src/firebase-config.js` (`vapidKey`; when empty, the option is left out).
- Remembered per browser in `localStorage`: `habit-tally:push` (`'on'` or absent, the person's choice) and
  `habit-tally:push-fid` (the installation ID last saved, so a changed ID can replace the old record).
- **Signed-out flag.** Unregistering needs the network, so an offline sign-out could leave the previous person's
  reminders arriving. `detach()` therefore first stores a flag the service worker can read: a `Response('1')` in
  the Cache Storage cache `habit-tally-flags` under the request URL `/__flags/signed-out`. `resume()` deletes it.
  While the flag exists the service worker shows only the generic notification text (section 7). In demo mode
  both are no-ops.
- **Sign-out sequence** (in `src/main.js`, one function used by every sign-out button):
  `await push.detach()` then `await store.signOut()`.

## 7. Push message and service worker (`public/sw.js`)

The job sends an FCM **data-only** message. Request body to
`POST https://fcm.googleapis.com/v1/projects/habit-tally/messages:send`:

```
{ "message": { "fid": "<installation id>",
               "data": { "title": "<habit name>", "body": "<reminderText body>", "tag": "<habitId>", "url": "/" },
               "webpush": { "headers": { "TTL": "1800", "Urgency": "high" } } } }
```

The target field name (`fid`) is one constant in `scripts/lib/google.mjs`; the documented fallback is `token`.

In the service worker's `push` event, `event.data.json()` is
`{ data: { title, body, tag, url }, from, fcmMessageId, ... }`: the four strings are under `data`.
The handler must always call `showNotification` inside `event.waitUntil`:

```
showNotification(title, { body, tag, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
                          data: { url } })
```

If the payload is missing or unreadable, or the signed-out flag of section 6 is set: title `Habit Tally`, body
`Time to check your habits.`, tag `habit-tally`, url `/`. `notificationclick` closes the notification, focuses an open app window if there is one, otherwise opens
`url`. The service worker contains no Firebase code.

Precache: the build puts one line at the top of the built `sw.js`:
`self.__BUILD = { version: '<hash of the build>', files: ['/', '/assets/...', ...] };` (every built file except
`sw.js` itself). In dev there is no such line: the worker must treat a missing `self.__BUILD` as "precache
nothing". A demo build leaves Firebase chunks out of `files`. Service worker checks are run on the demo build
(or with `?demo`), since the real build needs a sign-in. Icons live in `public/icons/`: `icon-192.png`,
`icon-512.png`, `maskable-512.png`, `badge-96.png`.

## 8. Security rules and the invite list (`firestore.rules`)

- The invite list is one line, exactly in this form, which the emulator tests replace with test ids:
  `function invited() { return ['uid1', 'uid2']; } // @invite-list`
- `allowed()` = signed in and `request.auth.uid in invited()`.
- `users/{uid}`, `users/{uid}/habits/{id}`, `users/{uid}/logs/{month}`: only `allowed()` and
  `request.auth.uid == uid`. Habit writes need exactly the ten stored fields with the types and ranges of
  section 4, including every reminder time (each item `HH:MM` on :00 or :30, no duplicates, at most 48). The
  habit id must be 20 letters or digits and a log document id `YYYY-MM`. Rules cannot check sorting, what is
  inside `days`, or the 50-habit limit; the stores do. User writes need exactly
  `tz`, `createdAt`, `updatedAt`. Log writes may only contain `days` (a map).
- `devices/{fid}`: create and update only when `allowed()`, the new data is exactly `{ uid, ua, updatedAt }` and
  `uid == request.auth.uid`; get and delete only when the stored `uid == request.auth.uid` (so a get or delete of a missing or taken-over
  record is refused, and the store treats that as done); no list.
- Size limits so one account cannot bloat what others' reminders depend on: `days` has at most 31 keys; a
  device id is 1 to 64 characters of `[A-Za-z0-9_-]`; `ua` at most 500 characters; `tz` 1 to 64.
- Everything else is denied, including collection-group queries and `system/**`.

## 9. Reminder job (`scripts/send-reminders.mjs`, `scripts/lib/google.mjs`)

- Input: environment variable `FIREBASE_SERVICE_ACCOUNT` (the JSON key). Optional overrides for tests and the
  emulator: `FIRESTORE_EMULATOR_HOST` (then Firestore calls go to `http://<host>/v1/...` with
  `Authorization: Bearer owner` and no token is requested for Firestore), `FCM_BASE_URL` (stand-in push
  service), `GCLOUD_PROJECT` (default: the key's `project_id`).
- `send-reminders.mjs` exports `run({ google, now, log, force }): Promise<{ slot, sent, skipped, failed, removed }>`
  for tests, and when executed directly builds `google` from the environment, calls `run`, prints a short
  summary and exits 0, or 1 if anything failed or the key is missing or malformed.
- Order of a run (architecture section 4): read `system/reminders`; `planRun`; **read everything first**: list
  users; per user `dueWindows(from, slot, tz)`, then habits, logs, and for each window entry
  `dueHabits(habits, logs, entry.day, entry.times)`; a habit due in more than one entry is sent once, with the
  text of the latest day; then devices. Only then **claim** the slot with a precondition
  (`ifUpdateTime`, or `ifMissing` on the first run), and send. The claim is written even when there is nothing
  to send. A failed read before the claim fails the run without claiming, so the next run retries the slot.
- Only a `PreconditionError` means "another run has the slot" (success, nothing sent). Any other error on the
  claim, including a timeout, fails the run without sending.
- `force: true` (environment `REMINDERS_FORCE=1`, set by the workflow's manual-run checkbox): ignore the
  bookmark, use the window of the current slot only, send without claiming and without changing the bookmark.
  For testing on a real phone.
- A user record without a valid `tz` is treated as `UTC`. Per user the job considers at most 100 habits and the
  10 most recently updated devices.
- FCM 404 UNREGISTERED: delete that device record, count it as `removed`, not as a failure.
- The Actions log of a public repository is public. The job never prints a key, token, email, uid, device or
  installation ID, habit name, or any response body: only counts, the slot time, HTTP statuses and error codes.

## 10. UI rules every screen follows

- User text (habit names, units, emails) reaches HTML only through the one `esc()` helper in `src/ui/common.js`.
- System font stack; no request to any other origin; colours as CSS custom properties with light and dark values.
- Touch targets at least 44 px; no sideways scrolling at 360 px wide.
- Screens never talk to Firebase; they use the store and push interfaces only.
- How a screen plugs into the shell (exports, `ctx`, re-rendering with `patch()`, sheets, toasts, the CSS class and
  colour-token vocabulary) is defined by the header comment of `src/ui/common.js`. Screen CSS files are linked
  from `index.html`, not imported by the modules, so the modules can be loaded by Node tests.
- `index.html` belongs to the shell (A2). The install package (A6) may edit only the block marked for the
  manifest and icon links.
- In demo and emulator builds the shell exposes the `ctx` object as `window.habitTally` for browser tests; it is
  absent in the real build.

## 11. Time-zone prompt

Owned by the Settings package (A5), shown by the app shell above any screen. When the status is `ready` and the
device zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) differs from `state.user.tz`, a notice asks
"Your reminders use <old zone> time. Switch to <device zone>?" with Switch and Keep. Switch calls
`store.setTimeZone(deviceZone)`. Keep stores the declined zone in `localStorage['habit-tally:tz-declined']`, and
the notice stays away until the device reports yet another zone. Settings always shows the reminder zone with a
button to switch to the device's zone. The shell asks `src/ui/settings.js` for the notice through an exported
`notice(state, ctx): string` (empty string = nothing to show) and attaches its clicks once at start-up through an
exported `bindNotice(root, ctx)`.
