# Habit Tally: architecture (draft 2, after review)

Read `docs/requirements.md` first. This document says how the app is built and why. Exact interfaces (store calls,
state shape, push message, limits, switches) are in `docs/contracts.md`. What changed since draft 1 and why is in
section 10; the full review is `docs/review-architecture.md`.

## 1. Shape of the system

Three parts, all on free tiers, no server of our own:

1. **Web app (PWA)** in the browser / installed on Android. Static files on Firebase Hosting
   (`https://habit-tally.web.app`). Talks straight to Firebase with the Firebase JS SDK. Holds all UI and habit logic.
2. **Firebase project `habit-tally`** (Spark plan, no card): Authentication (email + password), Cloud Firestore
   (`europe-west2`: data, offline cache, live sync), Cloud Messaging (web push to Chrome on Android), Hosting.
3. **Reminder job**: a GitHub Actions workflow on a 30-minute schedule in the public repo
   `MahmoudHendi1/habit-tally`. It runs one dependency-free Node script that reads Firestore and sends FCM messages
   through Google's REST APIs, signed in as a least-privilege service account whose key is a GitHub Actions secret.

There are no Cloud Functions and no custom backend. Everything a client may do is enforced by Firestore security
rules; the reminder job is the only privileged actor. The app is deployed from the lead's machine through the
Firebase connection, so no deploy credential is stored anywhere.

## 2. Key decisions

| # | Decision | Choice | Why | Rejected |
|---|---|---|---|---|
| D1 | App type | PWA (manifest + service worker) | Installs on Android without a store, same code on desktop | Native APK: no desktop version |
| D2 | UI stack | Vite + plain JavaScript ES modules, no UI framework, hand-written CSS, system fonts | Four screens; smallest bundle. All user text goes through one `esc()` helper before it reaches HTML | React/Preact: revisit at a fifth screen |
| D3 | Language | JavaScript with JSDoc types, `// @ts-check` in logic modules | No compile step for the Node job; shared code runs unchanged in browser and Node | TypeScript |
| D4 | Data | Cloud Firestore with persistent local cache (multi-tab) | Offline logging (R12) and cross-device sync (R8) for free | Realtime Database |
| D5 | Sign-in | Firebase Auth, email + password only in v1 | R10. Google sign-in needs a public support email; add later if the owner wants it | Email-link sign-in: awkward in an installed PWA |
| D5b | Who may use it (v1) | Anyone can create an account, but only accounts whose uid is listed in `firestore.rules` can read or write data. Others see a "waiting for approval" screen showing their id | The repo and web config are public, so open sign-up would let a stranger exhaust the free quota and stop reminders. Adding a person is one line in the rules and a deploy; deleting the check opens sign-up | Open sign-up now; an allowlist collection (one extra billed read per request) |
| D6 | Counting taps | One document per user per month, a map of day to habit to count, written with `increment()` and `setDoc(merge)` using nested objects (no field paths) | Atomic across devices, works offline, 12 small documents a year per user. The app listens to the whole `logs` collection | One document per tap: unbounded reads for stats |
| D7 | Push transport | FCM web push, **data-only** messages, shown by our own service worker `push` handler. Devices are identified by **Firebase installation ID (FID)** via `register()` + `onRegistered()` | We control title, body, tag and click behaviour; no Firebase SDK in the service worker. `getToken`/`deleteToken` are deprecated in the installed SDK (12.19) | Registration tokens (deprecated); FCM `notification` messages |
| D8 | Reminder scheduler | GitHub Actions cron at minutes 26 and 56 with a concurrency group; the script claims one half-hour slot per run in Firestore **before** sending | Free on a public repo. Claim-first means a slot is never sent twice, even if runs overlap or are re-run | Cloud Functions: needs the Blaze plan |
| D9 | Reminder script | Plain Node 22, zero npm dependencies: signs a JWT with `node:crypto`, calls Firestore REST and FCM HTTP v1 with `fetch` | No install step; a run takes seconds | `firebase-admin` |
| D10 | Finding due reminders | The job lists users, then each user's habits, and filters in memory with the shared logic | About 12 reads per run for one user with 10 habits, 15 when a reminder is due (measured: about 580 a day; free quota is 50,000). Good to roughly 80 active users; an indexed query can be added later without changing stored data | Collection-group query plus a client-written zone list (draft 1): clients could poison the list, and it optimised for users we do not have |
| D11 | Hosting and deploy | Firebase Hosting; the lead builds and deploys app, rules and indexes through the Firebase connection (`firebase deploy`) | No deploy key to store or leak | Deploy from GitHub Actions: needs a second, more powerful key |
| D12 | Tests | `node --test` for shared logic, demo store, the job (fake HTTP) and push module; Firestore rules and the Firebase store against the local emulator; Playwright walk-through of the demo build, run locally. A small CI workflow runs `npm test` and the build on push (free on a public repo, no secrets) | Logic is where bugs would hurt | Playwright or emulators in CI |
| D13 | Demo mode | `VITE_BACKEND=demo` (or `?demo` in the address) runs the app on a localStorage store behind the same store interface, without loading any Firebase code | Develop, test and screenshot the whole UI without the real project | Mocking the Firebase SDK |

## 3. Data model (Firestore)

```
users/{uid}                    { tz: "Europe/London", createdAt, updatedAt }
users/{uid}/habits/{habitId}   { name, period: "day" | "week", target: 1..50, unit: "", times: ["09:00","13:30"],
                                 created: "YYYY-MM-DD", archived: false, deletedAt: null | <ms>, order: number,
                                 updatedAt: <ms> }
users/{uid}/logs/{YYYY-MM}     { days: { "YYYY-MM-DD": { [habitId]: count } } }
devices/{fid}                  { uid, ua, updatedAt: <ms> }           (top level: one owner per browser install)
system/reminders               { lastSlot: <ms since epoch of the newest slot claimed>, updatedAt }   (job only)
```

Rules of the model:
- A "day" is the device's **local** calendar day (`YYYY-MM-DD`), written by the client. A week is Monday to Sunday.
- `count` changes only through `increment(+1 / -1)`. Readers clamp negative values to 0, and the app does not send
  `-1` when the shown count is 0.
- `times` are `HH:MM` in the user's reminder time zone (`users/{uid}.tz`), on half hours, at most 48 per habit.
- `users/{uid}.tz` is set at sign-up from the device. If a device later reports a different zone, the app asks
  "Use Africa/Cairo for reminders?" and changes it only on a yes. Nothing else stores a zone.
- Deleting a habit sets `deletedAt` (soft delete, with Undo in the app); counts stay in the logs. Rules require the
  full habit shape on every write, so a stale partial write cannot create a ghost habit.
- A habit's first day is derived: its `created` date, or the earliest back-filled day with a count. Nothing is
  rewritten when a past day is logged, so undoing a mistaken tap leaves no trace.
- A device document belongs to whoever signed in last on that browser. Sign-out deletes it and unregisters from
  FCM; if that cannot finish (offline), a local flag makes the service worker show only a generic reminder text
  until someone signs in again.
- No composite indexes. The job's `devices where uid == X` query uses the automatic single-field index.

## 4. Reminder flow

1. GitHub starts the workflow at :26 or :56 (often several minutes late). `concurrency: { group: reminders,
   cancel-in-progress: false }` and `timeout-minutes: 3`.
2. The script gets an access token for the service account (JWT, scopes `datastore` and `firebase.messaging`).
3. It reads `system/reminders` and plans the run with `planRun(lastSlot, now)`: the slot is
   `floor(now + 5 min)` to the half hour. If that slot is already claimed, it exits. The window it covers starts at
   the previous slot, or one slot earlier if one or more runs were missed (catch-up is limited to one missed
   slot, so nothing older than 60 minutes is ever sent). If the document does not exist (first run), the window is
   the current slot only.
4. It reads what it needs **before** claiming, so a failed read does not cost the slot. It lists `users`. For each
   user, `dueWindows(from, slot, tz)` gives, per local day, the half-hour times that fall in the local window
   (previous slot, this slot]. Matching a window instead of an exact `HH:MM` makes zones with 45-minute offsets
   work, sends times skipped by spring-forward at the next slot, and limits the autumn change to one duplicate
   reminder a year. A catch-up window that crosses the user's midnight is judged day by day.
5. For users with any time in the window it lists their habits, keeps those with a matching time, reads the one or
   two month logs that cover the current week, and applies `dueHabits` (drops archived and deleted habits, habits
   whose target is hit, and weekly habits already logged today). For users with a due habit it reads their
   devices (`devices where uid == X`).
6. It **claims** the slot: writes `lastSlot` with a precondition on the document's last update time (or "must not
   exist" on the first run). If the precondition fails another run got there first, and it exits cleanly. Any
   other error on the claim fails the run without sending.
7. It sends one FCM data message per due habit per device:
   `data: { title, body, tag: habitId, url: "/" }`, web push headers `TTL: 1800`, `Urgency: high`.
   A send that fails with 429 or 5xx is retried once. A device FCM reports as 404 UNREGISTERED is deleted; nothing
   is deleted on any other error.
8. One user's failure does not stop the others. If any send or read failed, the script finishes the rest and exits
   non-zero, so the run shows red and GitHub emails the owner. Its log never names a person, a device or a habit.
9. On the phone, Chrome wakes the service worker, which always shows a notification (`tag: habitId`,
   `renotify: true`, so a later reminder for the same habit replaces the earlier one and buzzes again). Tapping it
   opens or focuses the app.

Trade-off, stated plainly: because the slot is claimed before sending, a run that crashes while sending drops that
slot's remaining reminders instead of repeating them. The red run makes that visible. A manual run with the
"force" box ticked sends the current slot again without touching the bookmark, for testing on a real phone.

## 5. Security and privacy

- Firestore rules (`rules_version = '2'`):
  - `isAllowed()`: signed in and `request.auth.uid` is in the list in the rules file (D5b).
  - `users/{uid}` and its subcollections: read and write only by that uid, and only if allowed. Habits are
    validated on every write: exact key set, types, name and unit lengths, `target` 1..50, `times` a list of at
    most 48, `period`, `created` format. Logs: only the `days` key.
  - `devices/{fid}`: create or overwrite only with `uid == request.auth.uid`; read and delete only by the current
    owner. Signing in on a shared browser therefore takes the device over; the previous person's reminders stop.
  - `system/**`: no client access. Everything else: denied.
- The job's service account `reminder-job` has only `roles/datastore.user` and
  `roles/firebasecloudmessaging.admin`. Its key lives only in the GitHub Actions secret
  `FIREBASE_SERVICE_ACCOUNT`; the owner creates and pastes it. It is never in the repo, the app or chat. The
  default `firebase-adminsdk` key is never exported. The job never prints the key or any token.
- The Firebase web config and the Web Push public (VAPID) key are public by design and are committed.
- No analytics, no third-party scripts, no cross-origin fonts. All assets come from our own Hosting origin.
- Email + password accounts: Firebase's email-enumeration protection stays on; password reset by email.
- Habit names and units are escaped wherever they are rendered.

## 6. Code layout

```
index.html, src/           app shell and UI
  main.js                  boot, routing between Today / Progress / Settings, sign-in gate, sign-out sequence
  ui/*.js                  one module per screen + the habit editor sheet; render functions return HTML strings
  store.js                 the store factory (picks demo, emulator or firebase) and shared store helpers
  store-firebase.js        Auth + Firestore implementation (lazy-loaded)
  store-local.js           localStorage implementation (demo mode, tests)
  push.js                  notification permission, FCM registration (FID), device document
  pwa.js                   service worker registration, install prompt, update on next launch
  firebase-config.js       public web config and VAPID public key
  styles.css
shared/logic.js            pure functions used by BOTH the app and the job: dates, weeks, counts, streaks, stats,
                           calendar, validation, time snapping, slot planning, due times, due habits, reminder text
public/                    manifest.webmanifest, sw.js (cache + push), icons
scripts/send-reminders.mjs the reminder job (no dependencies)
scripts/lib/google.mjs     service-account token, Firestore REST helpers, FCM send
test/                      node:test suites; test/emulator/ needs the Firestore emulator
e2e/                       Playwright walk-through of the demo build
firestore.rules, firestore.indexes.json, firebase.json
.github/workflows/         reminders.yml (cron), ci.yml (test + build, no secrets)
docs/                      requirements.md, architecture.md, contracts.md, plan.md, status.md, owner-setup.md
```

## 7. Offline and PWA behaviour

- Service worker: network-first for the HTML shell with cache fallback; cache-first for hashed build assets,
  which are all precached at install (including lazy chunks) so the first offline launch works. A new version
  activates on the next launch.
- Firestore persistent cache makes reads and writes work offline. The store never awaits a Firestore write before
  updating the screen; writes are applied optimistically and sync when back online.
- Install: manifest with name, icons (192, 512, maskable), `display: standalone`, theme colours.
- Notifications need the user to tap "Turn on reminders" (the permission prompt must follow a tap).
- The `push` handler always calls `showNotification` inside `waitUntil`, with a generic fallback if the payload
  cannot be read.

## 8. Known limits and risks

| Risk | Handling |
|---|---|
| FID-based send is new: the REST field (`fid`) and delivery through our own `push` handler are proven only on a real phone | First thing checked once the owner's key exists (plan L3). The target field is one constant in `scripts/lib/google.mjs`; the documented fallback is the `token` field, which accepts FIDs during the migration |
| GitHub cron is late or skips a run | Run 4 minutes early; one missed slot is caught up; times in half-hour steps |
| GitHub disables schedules in public repos after 60 days without repository activity | The reminder workflow re-enables itself through the API once a week; the README says how to press "Enable" if it ever stops; any commit also resets the clock |
| Run crashes after claiming a slot | That slot's remaining reminders are dropped; the run is red and the owner is emailed |
| Android battery saver delays or drops web push | High-urgency messages; documented tip to exempt Chrome / the app |
| Time zone or DST change | Local-window matching (section 4); zone changes only on an explicit yes |
| Two devices tapping at once | `increment()` is atomic on the server |
| Editing a habit's target changes past "hit" days | Accepted for v1; the owner may ask for history-preserving targets later |
| Growth past about 80 active users | Add the indexed query for due habits; no change to stored data |
| iPhone users later | Web push works only for installed PWAs on iOS 16.4+; out of scope for v1 |

## 9. Cut from v1

Google sign-in, the client-written zone list and composite index, per-habit time zones, multi-slot catch-up,
deploying from GitHub Actions, Playwright and emulators in CI.

## 10. Review log

Draft 1 was reviewed independently (`docs/review-architecture.md`: 2 blockers, 6 major, 3 minor). Lead decisions:

| # | Finding | Decision |
|---|---|---|
| 1 | Push built on deprecated registration tokens | **Accepted.** FID registration (D7). Real-phone check moved to the front of L3 |
| 2 | Sign-out leaves the device registered to the old account | **Accepted.** Top-level `devices/{fid}` with one owner; sign-out deletes it and unregisters |
| 3 | Later reminders silent | **Accepted.** `renotify: true` |
| 4 | Overlap, replay, first run | **Accepted, with one change.** Concurrency group, first run sends the current slot only, one-slot catch-up, retry once, delete only on 404. Instead of checkpointing after each slot, the job claims the slot before sending with a Firestore precondition: never twice, rarely dropped, and a drop is visible |
| 5 | Exact `HH:MM` match drops reminders in some zones and at DST | **Accepted.** Local-window matching |
| 6 | Zone list and per-habit zone copy | **Accepted.** Removed; the job scans; zone changes need a yes |
| 7 | One over-privileged key | **Accepted, and simplified.** One least-privilege key for the job; no deploy key at all (D11) |
| 8 | Actions budget; open sign-up | **Accepted.** The repo is public, so minutes are free; keepalive for the 60-day rule. Invite list in the rules (D5b), confirmed by the owner |
| 9 | Hard delete | **Accepted.** Soft delete with undo; full-shape rules |
| 10 | Caps, back-fill, undo clamp | **Accepted.** 48 times; `created` moves back; clamped. Target edits rewriting history: accepted for v1 |
| 11 | Service worker details | **Accepted.** All four points |
| Q1-Q4 | Open questions | Scan in v1; monthly log documents kept; plain JS with mandatory escaping; reminder flow fixed as above |
