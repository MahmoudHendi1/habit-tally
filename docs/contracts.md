# Habit Tally: contracts (v1.3)

The interfaces where two packages meet. Owned by the lead; a developer who needs a change asks the lead. Read
`docs/architecture.md` first. Anything not fixed here is the owning package's choice.

v1.3 (14 Nov 2026) adds **routines** (requirement R15, packages R0 to R3 in `docs/plan.md`). Every bullet, table
row, code line and heading that is new or changed ends with "(v1.3)"; search for it to find them all. (v1.3)

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
`dueWindows`, `dueHabits`, `reminderText`, and for routines `cleanRoutine`, `validateRoutine`, `sortRoutines`,
`routineOf`, `groupHabits`, `routineLeft`, `dueRoutines`, `routineReminderText`, `REMINDER_BODY_MAX` (v1.3).
Their behaviour is defined by the doc comments and `test/logic.test.mjs`.

`LIMITS = { nameMax: 60, unitMax: 20, targetMin: 1, targetMax: 50, timesMax: 48, habitsMax: 50, backDays: 7,
routineNameMax: 40, routinesMax: 20 }` (v1.3).
"Last 7 days" (R6) means today plus the 7 days before it: `recentDays(today)`.

### Routines in the shared logic (v1.3)

- **Membership has one test: `routineOf(habit, routines) -> Routine | null`.** A habit is in a routine only when
  its `routine` is the id of a routine that exists and is not deleted. In every other case (`''`, a missing
  field, an unknown id, a deleted routine) the habit is **loose** and behaves as it did before v1.3. Stores,
  screens and the job never compare `habit.routine` themselves. (v1.3)
- `cleanHabit(input)` now also returns `routine` (`''` unless the input holds a string) and returns `times: []`
  when `routine` is not `''`. `validateHabit(h)` refuses a `routine` that is neither `''` nor 20 letters or
  digits, and a habit with both a routine and reminder times; a missing `routine` counts as `''`. (v1.3)
- `cleanRoutine(input) -> { name, times }` (name trimmed with inner spaces collapsed, times as `cleanTimes`);
  `validateRoutine(r) -> string[]` (name 1 to 40 characters and not blank; times as for a habit). (v1.3)
- `sortRoutines(routines) -> Routine[]`: deleted ones left out; by `order`, then name (plain code-unit
  comparison, so every device agrees), then id. (v1.3)
- `groupHabits(habits, routines) -> [{ routine: Routine | null, habits: Habit[] }]`: one entry per live routine in
  `sortRoutines` order, also when it has no habits; then one `routine: null` entry holding the loose habits,
  present only when there are loose habits or no live routine at all. Habits inside an entry are in
  `sortHabits` order. This is the order of Today and Progress. (v1.3)
- `routineLeft(routine, habits, logs, day) -> Habit[]`: the routine's habits that still have something to do on
  `day`, in `sortHabits` order. It is the same test `dueHabits` applies: not archived or deleted, target not hit
  in the habit's own period (the day, or the Monday-to-Sunday week), and for a weekly habit nothing logged on
  `day` yet (it has had its turn for the day). `[]` for a deleted routine. (v1.3)
- `dueRoutines(routines, habits, logs, day, times) -> [{ routine, left }]`: live routines, in `sortRoutines`
  order, that have one of `times` (one `'HH:MM'` or a list) among their reminder times and a non-empty
  `left = routineLeft(...)`. (v1.3)
- `routineReminderText(routine, left) -> { title, body }`: title is the routine name; body is
  `"2 left: Take pills, Brush teeth"` or `"1 left: Brush teeth"`, names in the order of `left`. The body is never
  longer than `REMINDER_BODY_MAX` (120) characters: names that do not fit are dropped whole and the list ends
  with `", ..."` (`"5 left: Take pills, Brush teeth, ..."`). (v1.3)
- `dueHabits(habits, logs, day, times, routines)` has a fifth, optional argument and leaves out every habit
  that is in a live routine. Without it all habits count as loose, so **any caller that has routines must pass
  them** (the job does, section 9). (v1.3)
- "x of y done" for a routine section is `summary(entry.habits, logs, day)`, the same rule as the line at the
  top of Today. It can differ from the reminder's "left" for a weekly habit that was logged today but has not
  reached its week's target: not done on the screen, not nagged again that day. (v1.3)

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
          order: number,            // set by the store on create: highest existing order + 1;
                                    // changed only by reorderHabits (v1.3)
          updatedAt: number,        // ms since epoch, set by the store on every save
          routine: string }         // '' (loose) or the id of the routine it belongs to; when not '',
                                    // times is []. At most one routine per habit (v1.3)
Routine { id: string,               // set by the store: 20 chars of [A-Za-z0-9] (v1.3)
          name: string,             // 1..40 chars, trimmed, not blank (v1.3)
          times: string[],          // reminder times of the whole routine; same rules as Habit.times (v1.3)
          order: number,            // set by the store on create: highest existing order + 1;
                                    // changed only by reorderRoutines (v1.3)
          deletedAt: null | number, // ms since epoch when soft-deleted (v1.3)
          updatedAt: number }       // ms since epoch, set by the store on every save (v1.3)
Logs    { 'YYYY-MM': { 'YYYY-MM-DD': { [habitId]: number } } }     // all months the user has
User    { uid: string, email: string, tz: string }                 // tz = IANA zone used for reminders
```

Firestore documents (see architecture section 3) store exactly these fields: a habit document has every Habit
field except `id` (the document id); `users/{uid}` is `{ tz, createdAt, updatedAt }` with numbers in ms;
`users/{uid}/logs/{YYYY-MM}` is `{ days: { 'YYYY-MM-DD': { [habitId]: number } } }`;
`devices/{fid}` is `{ uid, ua, updatedAt }`; `system/reminders` is `{ lastSlot, updatedAt }`.
A habit document therefore has **eleven** fields: the ten of v1.2 plus `routine`. A routine is stored at
`users/{uid}/routines/{id}` with exactly the five Routine fields other than `id`:
`{ name, times, order, deletedAt, updatedAt }`. Whatever reads stored data (both stores, the job) reads a habit
without a `routine` field as `routine: ''`, and data without any routines as none. Routines are built before
go-live, so no stored data is converted. (v1.3)
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
        routines: Routine[],        // sortRoutines(): deleted ones left out (v1.3)
        logs: Logs,
        lastError: null | { code: string, message: string } }   // a write the backend refused later
```

- `waiting` = signed in, but the rules refuse this account (not on the invite list). Never happens in demo mode.
- State is replaced, never mutated: every change produces a new `State` object (unchanged parts may be shared).
- `habits`, `routines` and `logs` are empty unless status is `ready`. (v1.3)
- Screens get their sections from `groupHabits(state.habits, state.routines)`; `state.habits` itself stays one
  flat list in `sortHabits` order, routine members included. (v1.3)

### Calls

| Call | Behaviour |
|---|---|
| `getState(): State` | Current state |
| `subscribe(fn): () => void` | Calls `fn(state)` at once and after every change; returns an unsubscribe function |
| `signUp(email, password): Promise<void>` | Creates the account and signs in. Resolves once the status is `ready` or `waiting` |
| `signIn(email, password): Promise<void>` | Resolves once the status is `ready` or `waiting` |
| `resetPassword(email): Promise<void>` | Always resolves for a well-formed email (no account enumeration) |
| `signOut(): Promise<void>` | Status becomes `signedOut`; habits, routines and logs are cleared from state (v1.3) |
| `retry(): void` | In `waiting`: checks again whether the account is now allowed |
| `saveHabit(input): string` | `input` is editor data, with `id` to edit or without to create. The store runs `cleanHabit` and `validateHabit`; on problems it throws `StoreError('invalid', problems[0], problems)`. On create it sets `id`, `created` (device today), `order`, `archived: false`, `deletedAt: null`. Editing never changes `id`, `created`, `order`. Creating beyond `LIMITS.habitsMax` live habits throws `StoreError('too-many', ...)`. Returns the id. Before cleaning, an `input.routine` that is not the id of a routine in `state.routines` (missing, unknown, deleted) is taken as `''`, so such a habit keeps the reminder times it was given; with a live routine, `cleanHabit` empties `times`. `input` is the whole editor data: a missing `routine` means `''`, as a missing `times` means none (v1.3) |
| `deleteHabit(id): void` | Soft delete: sets `deletedAt`. The habit leaves `state.habits`; its counts stay in `logs` |
| `restoreHabit(id): void` | Clears `deletedAt` (Undo). Throws `StoreError('too-many', ...)` if that would exceed `LIMITS.habitsMax` live habits |
| `saveRoutine(input): string` | `input` is `{ name, times }`, with `id` to edit or without to create. The store runs `cleanRoutine` and `validateRoutine`; on problems it throws `StoreError('invalid', problems[0], problems)`. On create it sets `id`, `order`, `deletedAt: null`. Editing never changes `id` or `order`. Creating beyond `LIMITS.routinesMax` live routines throws `StoreError('too-many', ...)`. Returns the id, and the routine is in `state.routines` before the call returns, so `saveHabit({ ..., routine: id })` can follow at once (v1.3) |
| `deleteRoutine(id): void` | Soft delete: sets `deletedAt`, as `deleteHabit` does for a habit. The routine leaves `state.routines`. Its habits are not written: they keep their `routine` value and are loose (with no reminder times) until the routine is restored (v1.3) |
| `restoreRoutine(id): void` | Clears `deletedAt` (Undo); the habits that still name it are its members again. Throws `StoreError('too-many', ...)` if that would exceed `LIMITS.routinesMax` live routines (v1.3) |
| `reorderHabits(ids: string[]): void` | Takes the ids that name a live habit, in the given sequence, each id once (unknown, deleted and repeated ids are dropped); gives the first `order` 1, the second 2, and so on; writes only the habits whose `order` changes, each with a new `updatedAt`. Habits not named keep their `order`. Anything but an array does nothing (v1.3) |
| `reorderRoutines(ids: string[]): void` | The same for live routines (v1.3) |
| `addCount(dayKey, habitId, delta): void` | `delta` is `+1` or `-1`. Ignored when `delta` is `-1` and `countOn` is 0, when `dayKey` is in the future, or older than `LIMITS.backDays` days before today. Never changes the habit itself: a count on a day before `created` is picked up by `startDay()` |
| `setTimeZone(tz): void` | Changes `user.tz` (only called after the person says yes) |
| `saveDevice(fid): Promise<void>` | Writes `devices/{fid}` for the signed-in user. Demo: resolves, does nothing |
| `removeDevice(fid): Promise<void>` | Deletes `devices/{fid}`. Demo: resolves, does nothing |

- `saveHabit`, `deleteHabit`, `restoreHabit`, `addCount`, `setTimeZone`, `saveRoutine`, `deleteRoutine`,
  `restoreRoutine`, `reorderHabits`, `reorderRoutines` are synchronous and optimistic: state
  changes and listeners fire before they return, and they never wait for the network (offline must feel the
  same). If the backend later refuses a write, the store sets `lastError`. One call changes state once and
  calls listeners once, however many records it writes. (v1.3)
- Counts are written with `increment(delta)` through `setDoc(..., { merge: true })` with nested objects
  (`{ days: { [dayKey]: { [habitId]: increment(delta) } } }`), never with dotted field paths.
- "Today" is always the device's local day: `keyOf(now())`.
- The user record: whenever an allowed account has no `users/{uid}` record (first sign-in, or the first time it
  is let in after being invited, including after `retry()`), the store creates it with the device's zone before
  the status becomes `ready`. Sign-up alone cannot create it, because a new account is not invited yet.
- The object passed to listeners is the same object `getState()` returns at that moment.
- While the status is not `ready`: `saveHabit` and `saveRoutine` throw `StoreError('not-ready', ...)`;
  `deleteHabit`, `restoreHabit`, `addCount`, `setTimeZone`, `deleteRoutine`, `restoreRoutine`, `reorderHabits`
  and `reorderRoutines` do nothing. (v1.3)
- Unknown ids and bad input: `saveHabit` with an `id` that does not exist throws `StoreError('not-found', ...)`;
  editing a soft-deleted habit is allowed and it stays deleted. `deleteHabit`, `restoreHabit` and `addCount` on an
  unknown id do nothing, as does `addCount` on a deleted habit, with a delta other than `+1`/`-1`, or with a
  malformed day key. `setTimeZone` ignores an invalid or unchanged zone.
- Routines follow the same pattern: `saveRoutine` with an `id` that does not exist throws
  `StoreError('not-found', ...)`; editing a soft-deleted routine is allowed and it stays deleted;
  `deleteRoutine` and `restoreRoutine` on an unknown id do nothing, as does deleting a deleted routine or
  restoring a live one. (v1.3)
- `order`: the first habit gets 1; deleted habits count towards the highest. The rule for habits is unchanged
  in v1.3 and routines use the same one: the first routine gets 1, a new one gets the highest existing `order`
  (deleted routines included) + 1. Habits and routines are numbered separately. (v1.3)
- Deleting a routine never deletes or changes a habit, and `deleteHabit`, `restoreHabit` and `addCount` do not
  look at routines. Moving a habit into or out of a routine is a `saveHabit`; it keeps its `order`. (v1.3)
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
- Sample data (`src/sample-data.js`) gains one routine, `{ id: 'sampleMorningRoutine', name: 'Morning',
  times: ['07:00'], order: 1 }`, with two daily habits of target 1 and no unit, in this order:
  `sampleVitaminsHabit1` "Take vitamins" (`order: 3`) and `sampleTeethHabit0001` "Brush teeth" (`order: 4`), both
  with history over the 16 weeks. On the fixture's `today`, "Take vitamins" is done and "Brush teeth" is not
  ("1 of 2 done"; the reminder would read "1 left: Brush teeth"). The two existing habits stay loose and
  nothing about them changes: ids, `order` 1 and 2, times, counts and the expected numbers in the fixture. The
  fixture gains the expected numbers of the two new habits. (v1.3)
- Stored demo data from before v1.3 (no `routines`, habits without `routine`) loads as no routines and loose
  habits, without an error. (v1.3)
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
               // for a routine (v1.3): "title": "<routine name>", "body": "<routineReminderText body>",
               //                       "tag": "<routineId>", "url": "/"; nothing else differs
               "webpush": { "headers": { "TTL": "1800", "Urgency": "high" } } } }
```

The comment lines above are not part of the request. A routine reminder needs no change in the service worker:
it shows whatever `title`, `body` and `tag` arrive, so a later reminder of the same routine replaces the earlier
one. (v1.3)

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
  `request.auth.uid == uid`. Habit writes need exactly the eleven stored fields with the types and ranges of
  section 4, including every reminder time (each item `HH:MM` on :00 or :30, no duplicates, at most 48). The
  habit id must be 20 letters or digits and a log document id `YYYY-MM`. Rules cannot check sorting, what is
  inside `days`, or the 50-habit limit; the stores do. User writes need exactly
  `tz`, `createdAt`, `updatedAt`. Log writes may only contain `days` (a map). (v1.3)
- The eleventh habit field: `routine` is a string that is `''` or 20 letters or digits, and
  `h.routine == '' || h.times.size() == 0`. A habit write without `routine` is refused. (v1.3)
- `users/{uid}/routines/{id}`: the same access and the same operations as `users/{uid}/habits/{id}` (only
  `allowed()` and `request.auth.uid == uid`). The id must be 20 letters or digits. Writes need exactly
  `name`, `times`, `order`, `deletedAt`, `updatedAt`: `name` a string of 1 to 40 characters that is not only
  spaces; `times` checked exactly like a habit's; `order` a number; `deletedAt` null or a number; `updatedAt`
  a number. (v1.3)
- Rules cannot check that a habit's `routine` names an existing routine, nor the 20-routine limit. That is why
  membership is always decided by `routineOf` (section 3), never by the field alone. (v1.3)
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
  users; per user `dueWindows(from, slot, tz)`, then habits and routines, logs, and for each window entry
  `dueHabits(habits, logs, entry.day, entry.times, routines)` and
  `dueRoutines(routines, habits, logs, entry.day, entry.times)`; a habit or routine due in more than one entry
  is sent once, with the text of the latest day; then devices (for a user with a due habit or a due
  routine). (v1.3) Only then **claim** the slot with a precondition
  (`ifUpdateTime`, or `ifMissing` on the first run), and send. The claim is written even when there is nothing
  to send. A failed read of one user's habits, routines (v1.3), logs or devices is tried once more (one retry per user, time
  permitting); if it fails again, that user gets nothing for this slot and counts as `failed` (exit 1), while
  the other users are served and the slot is claimed. Only when the bookmark, the user list or every user
  cannot be read is nothing claimed, so the next run retries the slot.
- Only a `PreconditionError` means "another run has claimed". The job then reads the bookmark again: if it
  holds this run's slot or a later one, the run ends as a success with nothing sent; if it holds an older slot
  (a late run got in first), the run plans, reads and claims again, once. Any other error on the claim,
  including a timeout, fails the run without sending.
- Time: the default deadline is 120 s. Nothing is claimed when reading ends less than 30 s before the deadline
  (the run fails and the next one retries the slot), so a push started at the last moment still ends inside
  the workflow's 3-minute limit.
- The command's entry point is exported for tests: `main({ env, log, makeGoogle, now })` resolves the exit
  code; `run()` also takes an injectable `sleep`.
- `force: true` (environment `REMINDERS_FORCE=1`, set by the workflow's manual-run checkbox): ignore the
  bookmark, use the window of the current slot only, send without claiming and without changing the bookmark.
  For testing on a real phone.
- A user record without a valid `tz` is treated as `UTC`. Per user the job considers at most 100 habits and the
  10 most recently updated devices.
- Routines (v1.3). Per user the job lists `users/{uid}/routines` with a read limit of 50 records (20 live ones
  plus room for soft-deleted ones), in the same step as the habits and under the same one-retry rule.
  - A stored routine is used only when its id is a non-empty string and `validateRoutine` passes; any other
    record is ignored, so its habits are loose. The habit the job hands to the shared logic carries
    `routine` (the stored string, or `''` when the field is missing or not a string). (v1.3)
  - Logs are read when a habit **or a routine** has a reminder time in the window, and for the same months as
    before (the weeks of the window's days), which also covers a weekly habit inside a routine. (v1.3)
  - One push per due routine per device, with the envelope of section 7 and
    `data: { title, body, tag: <routine id>, url: "/" }`, where `{ title, body }` is
    `routineReminderText(routine, left)` with the `left` of the latest day the routine is due on. The job's own
    title and body length caps apply as for a habit. (v1.3)
  - A habit in a live routine never gets a push of its own (`dueHabits` with `routines` sees to it). (v1.3)
  - Counting: a routine reminder is one reminder, exactly like a habit reminder, in `sent`, `failed` and the
    log. A routine with a reminder time in the window, at least one live habit and nothing left counts as one
    `skipped`; a routine without live habits counts as nothing. (v1.3)
- FCM 404 UNREGISTERED: delete that device record, count it as `removed`, not as a failure.
- The Actions log of a public repository is public. The job never prints a key, token, email, uid, device or
  installation ID, habit name, routine name or id (v1.3), or any response body: only counts, the slot time,
  HTTP statuses and error codes.

## 10. UI rules every screen follows

- User text (habit names, routine names (v1.3), units, emails) reaches HTML only through the one `esc()` helper in `src/ui/common.js`.
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

### Routines on the screens (v1.3)

The screens are packages of their own (R3); this fixes only what tests and the other packages rely on.

- **Today** shows the entries of `groupHabits(state.habits, state.routines)` in order. A routine entry is a
  section with a heading: the routine name, "x of y done" (`summary` of the entry's habits on the shown day)
  and a button that opens the routine editor. An empty routine shows its heading and a short hint. The loose
  entry has the heading "Other habits" only when at least one routine exists; with no routines Today looks as
  it did in v1.2. The line at the top still counts every habit. (v1.3)
- **Reorder mode.** A "Reorder" button on Today (shown when there is anything to reorder) switches the mode on;
  "Done reordering" switches it off. In the mode every habit has Move up and Move down, which move it one
  place inside its own section, and every routine heading has Move up and Move down, which move the whole
  section. The first item's Move up and the last item's Move down are disabled. A habit changes section only
  in the habit editor. (v1.3)
- A move calls the store with **every** live id in the new display order, so `order` stays 1..n without ties:
  `reorderHabits(ids)` with the ids of `groupHabits(...)` flattened (all entries, loose last) after swapping
  the two neighbours; `reorderRoutines(ids)` with `state.routines` ids after the swap. (v1.3)
- **Habit editor** gains a "Routine" choice: "None", each routine of `state.routines` by name, and
  "New routine...". The choice shown for a habit is `routineOf(habit, state.routines)`, so a habit of a deleted
  routine shows "None". While a routine is chosen the reminder times and the quick-fill are hidden and a line
  says that reminders come from the routine. "New routine..." asks for a name and, on Save, calls
  `saveRoutine({ name, times: [] })` and then `saveHabit` with the new id. The editor always passes `routine`
  (`''` for None) to `saveHabit`. (v1.3)
- **Routine editor** (`src/ui/routine.js`, a sheet): name, reminder times with the same picker and
  "Every N hours" quick-fill as the habit editor, Save, and for an existing routine Delete, which calls
  `deleteRoutine` and shows a toast with Undo (`restoreRoutine`). It opens from a section heading (edit) and
  from an "Add a routine" button on Today (create). Problems from `StoreError('invalid' | 'too-many')` are
  shown as in the habit editor. (v1.3)
- **Progress** lists the habits in the same grouped order, with the same section headings (name only). (v1.3)
- Accessible names (exact, for tests): `Add a routine`, `<routine name>, edit routine`, `Save routine`,
  `Delete routine`, `Reorder`, `Done reordering`, `Move up: <habit or routine name>`,
  `Move down: <habit or routine name>`. The habit editor's choice is a control named `Routine` with the
  options `None`, the routine names and `New routine...`. (v1.3)

## 11. Time-zone prompt

Owned by the Settings package (A5), shown by the app shell above any screen. When the status is `ready` and the
device zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) differs from `state.user.tz`, a notice asks
"Your reminders use <old zone> time. Switch to <device zone>?" with Switch and Keep. Switch calls
`store.setTimeZone(deviceZone)`. Keep stores the declined zone in `localStorage['habit-tally:tz-declined']`, and
the notice stays away until the device reports yet another zone. Settings always shows the reminder zone with a
button to switch to the device's zone. The shell asks `src/ui/settings.js` for the notice through an exported
`notice(state, ctx): string` (empty string = nothing to show) and attaches its clicks once at start-up through an
exported `bindNotice(root, ctx)`.
