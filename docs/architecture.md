# Habit Tally: architecture (draft 1, for review)

Read `docs/requirements.md` first. This document says how the app is built and why.

## 1. Shape of the system

Three parts, all on free tiers, no server of our own:

1. **Web app (PWA)** in the browser / installed on Android. Static files on Firebase Hosting. Talks straight to
   Firebase with the Firebase JS SDK. Holds all UI and all habit logic.
2. **Firebase project** (Spark plan): Authentication (email + password, Google), Cloud Firestore (data, offline
   cache, live sync between devices), Cloud Messaging (FCM, delivers web push to Chrome on Android), Hosting.
3. **Reminder job**: a GitHub Actions workflow on a 30-minute schedule that runs one dependency-free Node script.
   It reads Firestore and sends FCM messages through Google's REST APIs, authenticated as a service account whose
   key is a GitHub Actions secret. A second workflow builds and deploys the app on every push to `main`.

There are no Cloud Functions and no custom backend. Everything the client may do is enforced by Firestore
security rules; the reminder job is the only privileged actor.

## 2. Key decisions

| # | Decision | Choice | Why | Rejected |
|---|---|---|---|---|
| D1 | App type | PWA (manifest + service worker) | Installs on Android without a store, same code on desktop | Native APK: no desktop version |
| D2 | UI stack | Vite + plain JavaScript ES modules, no UI framework, hand-written CSS | Four screens; smallest bundle and fewest moving parts; pure logic lives in a separate tested module | React/Preact: more tooling than the UI needs today |
| D3 | Language | JavaScript with JSDoc types, `// @ts-check` in logic modules | No compile step for the Node job; shared code runs unchanged in browser and Node | TypeScript: revisit if the codebase grows |
| D4 | Data | Cloud Firestore with persistent local cache | Offline logging (R12) and cross-device sync (R8) for free | Realtime Database: weaker queries and offline story |
| D5 | Sign-in | Firebase Auth: email + password, plus Google | R10; Google is one tap on Android | Email-link sign-in: awkward inside an installed PWA |
| D6 | Counting taps | One document per user per month, a map of day to habit to count, written with `increment()` | Atomic across devices, works offline, about 12 small documents a year per user, cheap to read for history | One document per tap: unbounded reads for stats |
| D7 | Push transport | FCM web push, **data-only** messages, shown by our own service worker `push` handler | We control title, body, tag and click behaviour; no Firebase SDK inside the service worker | FCM `notification` messages: less control, double-display risks |
| D8 | Reminder scheduler | GitHub Actions cron at minutes 26 and 56, script processes every half-hour slot since the last one it handled (state in Firestore) | Free, no card. Starting 4 minutes early centres typical GitHub delay around the slot. Catch-up makes skipped runs harmless | Cloud Functions: needs the Blaze plan |
| D9 | Reminder script | Plain Node 22, zero npm dependencies: signs a JWT with `node:crypto`, calls Firestore REST and FCM HTTP v1 with `fetch` | No `npm install` in the job keeps each run near 15 seconds, so it bills as 1 minute and stays inside 2,000 free minutes | `firebase-admin`: install time risks 2 billed minutes a run |
| D10 | Finding due reminders | Collection-group query on `habits` by `tz` and `times array-contains slot`, one query per time zone in use | Reads only the habits that are due, so cost grows with reminders sent, not with users | Scanning every user every run: 48 reads a user a day, hits the free quota near 1,000 users |
| D11 | Hosting and deploy | Firebase Hosting; GitHub Actions builds and deploys on push to `main`, also deploys Firestore rules and indexes | One place, free TLS, PWA-friendly headers | GitHub Pages: not available for private repos on the free plan |
| D12 | Tests | `node --test` for the shared logic and the reminder job (with fake HTTP); Firestore rules tests with the emulator in CI; Playwright smoke test of the built app in demo mode | Logic is where the bugs would hurt (streaks, weeks, time zones, slots) | Heavy end-to-end suite against real Firebase |
| D13 | Demo mode | With no Firebase config the app runs on a localStorage store behind the same store interface | Lets us develop, test and screenshot the whole UI without a Firebase project | Mocking the Firebase SDK |

## 3. Data model (Firestore)

```
users/{uid}                      { tz: "Europe/London", createdAt, updatedAt }
users/{uid}/habits/{habitId}     { name, period: "day" | "week", target: 1..50, unit: "" , times: ["09:00","13:30"],
                                   tz: "Europe/London"  (copy of the user's zone, for the reminder query),
                                   created: "YYYY-MM-DD", archived: false, order: number, updatedAt }
users/{uid}/logs/{YYYY-MM}       { days: { "YYYY-MM-DD": { [habitId]: count } } }
users/{uid}/devices/{deviceId}   { token: <FCM registration token>, ua, updatedAt }
system/reminders                 { lastSlot: <ms since epoch of the newest slot handled> }   (job only)
system/zones                     { list: ["Europe/London", ...] }  (clients arrayUnion their zone; job reads)
```

Rules of the model:
- A "day" is the user's **local** calendar day (`YYYY-MM-DD`), written by the client. A week is Monday to Sunday.
- `count` changes only through `increment(+1 / -1)` with `setDoc(..., { merge: true })`; the UI never shows below 0.
- `times` are `HH:MM` in the user's local time, snapped to half hours, at most 12 per habit.
- When the device's time zone differs from `users/{uid}.tz`, the client updates the user doc, every habit's `tz`,
  and `system/zones`.
- Deleting a habit deletes the habit document only; old counts stay in the logs (harmless, tiny).
- Index: collection group `habits` on (`tz` ASC, `times` ARRAY_CONTAINS), in `firestore.indexes.json`.

## 4. Reminder flow

1. GitHub starts the workflow at :26 or :56 (often several minutes late).
2. The script gets an access token for the service account (JWT, scopes `datastore` and `firebase.messaging`).
3. It reads `system/reminders.lastSlot` and computes the slots to handle: every half-hour slot after `lastSlot` up
   to `floor(now + 5 min)`, capped at the last 90 minutes. Normally that is exactly one slot.
4. It reads `system/zones`. For each zone and slot it converts the slot instant to that zone's local day and
   `HH:MM`, then runs the collection-group query for habits with that `tz` and that time.
5. For each user with matching habits it reads the one or two month logs that cover the current week, and drops
   habits whose target is already hit (and weekly habits already logged today).
6. For each remaining habit it sends one FCM data message per device token of that user:
   `{ title: habit name, body: "2 of 8 done today", tag: habitId, url: "/" }`, TTL 30 minutes.
   Tokens that FCM reports as unregistered are deleted.
7. It writes the new `lastSlot` **after** sending. If the run crashes midway the next run repeats that slot; the
   notification `tag` makes a repeat replace the earlier one on the phone rather than stack.
8. On the phone, Chrome wakes the service worker, which shows the notification. Tapping it opens or focuses the app.

## 5. Security and privacy

- Firestore rules: a signed-in user can read and write only under `users/{their uid}/**`, with field validation on
  habits (types, lengths, `target` range, `times` format and count). `system/zones`: signed-in users may only
  `arrayUnion` one valid zone string; no client read. `system/reminders`: no client access.
- The service account key lives only in GitHub Actions secrets (`FIREBASE_SERVICE_ACCOUNT`). It is never in the
  repo, the app or chat. The owner pastes it into GitHub themselves.
- The Firebase web config (apiKey, projectId, ...) is public by design and is committed.
- FCM tokens are stored under the owning user and readable only by them and the job.
- No analytics, no third-party scripts. All assets are served from our own Hosting origin.
- Email + password accounts: Firebase's email-enumeration protection stays on; password reset by email.

## 6. Code layout

```
index.html, src/           app shell and UI
  main.js                  boot, routing between Today / Progress / Settings, sign-in gate
  ui/*.js                  one module per screen + the habit editor sheet; render functions return HTML strings
  store.js                 the store interface + factory (picks firebase or local)
  store-firebase.js        Auth + Firestore implementation (lazy-loaded)
  store-local.js           localStorage implementation (demo mode, tests)
  push.js                  notification permission, FCM token registration, device doc
  firebase-config.js       public web config, or null for demo mode
  styles.css
shared/logic.js            pure functions used by BOTH the app and the job: dates, weeks, counts, streaks,
                           stats, time snapping, slot maths, which habits are due, reminder text
public/                    manifest.webmanifest, sw.js (cache + push), icons
scripts/send-reminders.mjs the reminder job (no dependencies)
scripts/lib/google.mjs     service-account token, Firestore REST helpers, FCM send
test/                      node:test suites
firestore.rules, firestore.indexes.json, firebase.json
.github/workflows/         deploy.yml (build, test, deploy), reminders.yml (cron)
docs/                      requirements.md, architecture.md, plan.md
```

The store interface (the seam between UI and backend):

```
store.subscribe(listener)            -> state = { status: "loading"|"signedOut"|"ready", user, habits, logs, mode }
store.signInGoogle(), signInEmail(email, pw), signUpEmail(email, pw), resetPassword(email), signOut()
store.saveHabit(habit), store.deleteHabit(id)
store.addCount(dayKey, habitId, delta)     // +1 or -1
store.setTimeZone(tz)
```

## 7. Offline and PWA behaviour

- Service worker: network-first for the HTML shell with cache fallback; cache-first for hashed build assets.
  A new version activates on the next launch.
- Firestore persistent cache (multi-tab) makes reads and writes work offline; writes sync when back online.
- Install: manifest with name, icons (192, 512, maskable), `display: standalone`, theme colours.
- Notifications need the user to tap "Turn on reminders" (permission prompt must follow a tap).

## 8. Known limits and risks

| Risk | Handling |
|---|---|
| GitHub cron is late or skips a run | Run 4 minutes early; catch-up of missed slots within 90 minutes; times in half-hour steps |
| GitHub disables schedules after 60 days without repo activity (public repos) | Repo is private, where this does not apply; documented in the README |
| Free Actions minutes (2,000 a month) | Zero-dependency job, about 15 seconds a run, about 1,460 runs a month; deploys add a few minutes |
| Android battery saver delays or drops web push | High-urgency FCM messages; documented tip to exempt Chrome/the app |
| Time zone or DST change | Slots are computed per zone at send time with `Intl`, never stored in UTC |
| Two devices tapping at once | `increment()` is atomic on the server |
| A user travels | Client rewrites `tz` on next open |
| iPhone users later | Web push works only for installed PWAs on iOS 16.4+; out of scope for v1 |

## 9. Open questions for review

1. Is the collection-group + `system/zones` design (D10) worth its complexity now, or should v1 scan users?
2. Is one log document per month the right grain (D6)?
3. Is plain JS without a framework (D2) going to hurt as screens are added?
4. Anything in the reminder flow that can double-send or silently drop?
