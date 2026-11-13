# Habit Tally: delivery plan (v2, 13 Nov 2026)

Written by the project manager against architecture draft 1; revised by the lead after the architecture review (architecture draft 2). What changed: the Firebase project and the GitHub repository already exist; the app is deployed through the Firebase connection, not from GitHub; the job scans users instead of using a zone list and an index; devices are top-level records keyed by installation ID; sign-up is by invite list in the rules; the repository is public.

Read with `docs/requirements.md` (R1 to R14) and `docs/architecture.md`. The work runs on two tracks, app (Developer A) and backend (Developer B), after the lead fixes the things both tracks share. Nothing before milestone M3 needs the real Firebase project or the owner's phone.

Progress is tracked by the project manager in `docs/status.md`: one line per package with its state (not started, in progress, in review, changes requested, merged) and a link to the evidence.

## 1. Milestones

| # | Goal | Exit criteria (all can be checked) | Needs owner |
|---|---|---|---|
| M0 | The shared rules are fixed, so two developers can work without colliding | Every comment from the architecture review is closed or accepted by the lead. `docs/contracts.md` is merged and tagged `contract-v1`, with "I can build from this" recorded from A, B and the reviewer. From a clean clone, `npm ci && npm test && npm run build` pass. | No |
| M1 | **Shown working, level 1:** the whole app works in demo mode at phone size | A1 to A7 merged. `npm run test:e2e` passes on `main` at 390x844 and 1280x800. `docs/screenshots/demo/` holds the screenshots listed in A7, each tagged with requirement ids. The reviewer has walked the A7 flow by hand in a phone-size window and no defect against a Must requirement is open. | No |
| M2 | The whole system works locally against the Firebase emulator | B1 to B6 and L1 merged. `npm test`, `npm run test:emulator` and `npm run test:e2e:emulator` pass on `main`. The run shows two accounts kept apart, sync between two windows, an offline tap syncing later, and the reminder job sending exactly the due reminders to a stand-in push service. The owner setup guide has been sent to the owner. | No |
| M3 | Live: deployed, with real sign-in and sync | All L2 checks pass on the real project, on the owner's phone and a desktop browser. | **Yes** |
| M4 | **Shown working, level 2:** a reminder arrives on the owner's Android phone; final review | All L3 and L4 checks pass. The owner confirms. | **Yes** |

M1 and M2 are worked on at the same time; M1 is expected first.

## 2. Work packages

**Rules for working in parallel**

- One branch per package, `wp/<id>`, each in its own git worktree (`git worktree add ../ht-<id> -b wp/<id> main`), so two agents never share a checkout. Only the lead merges into `main`.
- A package edits only the files it owns (table below). If it needs a change elsewhere, it asks that file's owner.
- Lead-only files for the whole project: `package.json`, `package-lock.json`, `.gitignore`, `vite.config.js`, `shared/logic.js`, `test/logic.test.mjs`, `src/store.js`, `src/firebase-config.js`, `docs/contracts.md`, `docs/architecture.md`. A developer who needs a new dependency, a new shared function or a change to the store interface asks the lead; the lead changes it on `main` and tells both tracks.
- "Placeholder" means a few lines that let the app build. L0 and A2 create placeholders; the package named in the table then owns that file.

| Id | Title | Owner | Files or folders owned | Depends on | Can run alongside | Size (lines, rough) |
|---|---|---|---|---|---|---|
| L0 | Contracts and project skeleton | Lead | The lead-only files above; placeholders for `src/store-local.js`, `src/store-firebase.js`, `src/push.js` | architecture review | nothing (everyone waits) | 250 |
| A1 | Demo store | Dev A | `src/store-local.js`, `test/store-local.test.mjs`, `test/store-contract.mjs`, `test/fixtures/` | L0 | B2, B3 | 350 |
| A2 | App skeleton and Today screen | Dev A | `index.html`, `src/main.js`, `src/styles.css`, `src/ui/common.js`, `src/ui/today.js`; placeholders for the other `src/ui/*.js` and `src/pwa.js` | A1 | B1, B4 | 500 |
| A3 | Habit editor with reminder times | Dev A | `src/ui/editor.js`, `src/ui/editor.css`, `test/editor.test.mjs` | A2 | A4, A5, A6, B5, B6 | 300 |
| A4 | Progress screen and 15-week calendar | Dev A | `src/ui/progress.js`, `src/ui/progress.css` | A2 | A3, A5, A6, B5, B6 | 200 |
| A5 | Sign-in and Settings screens | Dev A | `src/ui/signin.js`, `src/ui/settings.js`, `src/ui/account.css` | A2 | A3, A4, A6, B5, B6 | 300 |
| A6 | Install and offline shell, notification display | Dev A | `public/` (manifest, `sw.js`, icons), `src/pwa.js` | A2 | A3, A4, A5, B5, B6 | 200 |
| A7 | Demo walk-through test and screenshots | Dev A | `e2e/demo.spec.js`, `playwright.config.js`, `docs/screenshots/demo/` | A3, A4, A5, A6 | L1 | 200 |
| B2 | Security rules | Dev B | `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `test/emulator/rules.test.mjs` | L0 | A1, B3 | 350 |
| B3 | Google API client for the job | Dev B | `scripts/lib/google.mjs`, `test/google.test.mjs` | L0 | A1, B2 | 400 |
| B1 | Firebase store | Dev B | `src/store-firebase.js`, `test/emulator/store-firebase.test.mjs` | A1 (reads its contract tests), B2 | A2, B4 | 400 |
| B4 | Reminder job | Dev B | `scripts/send-reminders.mjs`, `test/reminders.test.mjs` | B3 | A2, B1 | 450 |
| B5 | Push registration | Dev B | `src/push.js`, `test/push.test.mjs` | B1 | A3 to A6, B6 | 250 |
| B6 | Workflows and owner setup guide | Dev B | `.github/workflows/`, `docs/owner-setup.md` | B2, B4 | A3 to A6, B5 | 200 |
| L1 | Local integration on the emulator | Lead | `e2e/emulator.spec.js`, `playwright.emulator.config.js`, `scripts/dev/`, `docs/screenshots/emulator/` | A5, A6, B1, B2, B4, B5 | A7 | 250 |
| L2 | Go live: deploy, sign-in, sync | Lead with Dev B, **needs owner** | `src/firebase-config.js`, the invite list in `firestore.rules`, `docs/screenshots/live/` | M1, M2, owner items 1 and 2 | nothing | 30 |
| L3 | Reminders on the owner's phone | Lead with Dev B, **needs owner** | `docs/screenshots/live/` (fixes go back to the owning package) | L2, owner items 3 to 5 | nothing | 0 |
| L4 | Final review and handover | Lead | `README.md` | L3 | nothing | 100 |

Sizes include tests. If a package passes 500 lines while being built, the developer stops and asks for it to be split (A2 is the likely one: skeleton and styles, then Today).

**Order of work.** Packages on one line can run at the same time; they own different files.

```
1.  L0
2.  A1 | B2 | B3
3.  A2 | B1 | B4
4.  A3 | A4 | A5 | A6 | B5 | B6     (A3 to A6 in this order if there is one app agent)
5.  A7 | L1                          -> M1 after A7, M2 after L1
6.  L2   (owner)                     -> M3
7.  L3   (owner)  then L4            -> M4
```

## 3. Acceptance checks

Script names (`test:emulator`, `test:e2e`, `test:e2e:emulator`) are set by the lead in L0. UI checks are done in demo mode in Chrome at 390x844 unless stated. Every package must also meet the definition of done in section 4.

| Id | Checks | Covers |
|---|---|---|
| L0 | 1. Clean clone: `npm ci && npm test && npm run build` exit 0, including the existing streak, week and reminder-slot tests; `git status` is clean afterwards.<br>2. `npm run dev` opens the app in demo mode with no Firebase settings and no console errors.<br>3. `docs/contracts.md` has no "to be decided" on: every store call (inputs, result, error codes); the exact shape of the state, including which months of logs are loaded; who sets a habit's id, start date, order and time zone; what `src/push.js` offers the Settings screen; the fields of a push message; how demo mode and emulator mode are switched on; the habit limits (name length, target 1 to 50, most reminder times).<br>4. `shared/logic.js` has one habit-validation function using those limits and the helper for the 15-week calendar, both with tests.<br>5. Playwright is pinned to the version whose browser is already installed on the build machine, so nothing is downloaded. | Groundwork for all; R5 (logic) |
| A1 | 1. `npm test`: the contract tests pass against the demo store: add, edit, delete and restore a habit; a log before the start date counts from that day without changing the habit; +1 and -1 today; +1 on a day 7 days back; a shown count is never below 0; every change reaches listeners.<br>2. A new store on the same browser storage sees the earlier data; empty or damaged storage starts clean without an error.<br>3. Sign up, sign in and sign out move the state between signed-out and ready, so the sign-in screen can be shown in demo mode.<br>4. A fixture with 16 weeks of sample data for one daily and one weekly habit loads into the store; its expected totals and streaks are written next to it.<br>5. `grep -n firebase src/store-local.js` finds nothing. | R1, R2, R6, R12 |
| A2 | 1. One tap on + raises the count and tally by one at once; the undo button takes one back and is disabled at 0.<br>2. The top of Today shows "N of M habits done". A daily habit shows today's count against its target; a weekly one shows this week's total, Monday to Sunday.<br>3. The day picker offers today and each of the previous 7 days; logging on a past day changes that day only.<br>4. No sideways scrolling at 360 px wide; buttons are at least 44 px; the same page is usable at 1280x800.<br>5. A habit named `<img src=x onerror=alert(1)>` shows as plain text.<br>6. Colours follow the system light or dark setting.<br>7. The network log shows no request to any other website (fonts are bundled or system fonts).<br>8. Today, Progress and Settings tabs and the signed-out gate work with placeholders. | R2, R3, R6, R7, R14 |
| A3 | 1. Add a habit with a name, "per day" or "per week", a target and an optional unit: it appears on Today with that target. Edit changes it. Delete removes it and offers Undo, which brings it back.<br>2. An empty name or a target outside 1 to 50 cannot be saved, and a message says why.<br>3. Several reminder times can be added and removed; only :00 and :30 can be chosen.<br>4. "Every 2 hours between 09:00 and 21:00" fills 09:00, 11:00 ... 21:00 (7 times). "Every hour between 07:00 and 22:00" (16 times) is accepted. Going over the limit of 48 gives a clear message and saves nothing invalid. A range that ends before it starts runs past midnight (22:00 to 06:00 every 4 hours gives 22:00, 02:00, 06:00).<br>5. `npm test`: a saved habit passes the shared validation. | R1, R4 |
| A4 | Using the A1 fixture:<br>1. Each habit shows total times done, periods hit out of periods, current streak and best streak, equal to the fixture's expected numbers.<br>2. A weekly habit is counted and labelled in weeks; a log on a Sunday counts in the week that began on Monday.<br>3. The calendar has 15 week columns ending this week, Monday at the top; future days are blank; days the target was hit are darkest.<br>4. With no habits there is a friendly empty state. | R5, R13 |
| A5 | 1. Signed out, only the sign-in screen can be reached: sign up with email and password, sign in, "forgot password".<br>2. Wrong password, weak password, email already used and "offline" each show a plain message.<br>3. Settings shows the account email and Sign out, which returns to sign-in and hides all data.<br>4. "Turn on reminders" asks for permission only after the tap, and shows each state: on, blocked, not supported, demo.<br>5. Theme choice (system, light, dark) is kept after a reload.<br>6. Demo mode is clearly labelled as saved in this browser only.<br>7. An account that is not on the invite list sees a "waiting for approval" screen with its account id and Sign out, and no data screens.<br>8. When the device's time zone differs from the account's, a prompt offers to switch; nothing changes without a yes. | R10, R4, R14 |
| A6 | On the production build (`npm run build && npm run preview`):<br>1. Chrome DevTools > Application shows the manifest with no errors and the app as installable (name, full-screen display, icons at 192, 512 and maskable).<br>2. After one visit, an offline reload opens the app and logging works.<br>3. A new build is picked up on the next launch.<br>4. A simulated push with the contract's fields shows a notification with the habit name as title, the body text, and the habit id as tag; a second one with the same tag replaces the first and alerts again; tapping it opens or focuses the app.<br>5. A push with missing or broken data still shows a generic notification and no error.<br>6. `grep -n firebase public/sw.js` finds nothing. | R9, R12, R4 |
| A7 | 1. `npm run test:e2e` passes at 390x844 and 1280x800: add a daily and a weekly habit, log, undo, log for yesterday, check the Progress numbers, edit, delete, reload and the data is still there.<br>2. The run fails on any console error.<br>3. It saves screenshots of: sign-in, Today, a past day, the editor with reminder times, Progress with calendar, Settings, dark mode, desktop width. An index file lists each with requirement ids. | R1 to R3, R5 to R7, R13, R14 |
| B2 | `npm run test:emulator`:<br>1. An invited, signed-in user can read and write their own account record, habits and logs; every read and write on another user's data is refused; signed-out visitors are refused everywhere; a signed-in account that is not on the invite list is refused everywhere.<br>2. A client query across all users' habits is refused.<br>3. Invalid habits are refused: target 0 and 51, over-long name, 49 times, wrong types, unknown fields, missing fields (a partial write cannot create a habit).<br>4. Devices: a user can create or take over a device record only with their own uid, and can read or delete only a record they own. `system/**` cannot be read or written by clients.<br>5. `firestore.indexes.json` stays empty; `firebase.json` serves the built app and never caches `index.html` or `sw.js`. The invite list is one clearly marked line that the tests replace with test ids. | R10, R1 |
| B3 | `npm test`, with a stand-in for the network:<br>1. The sign-in token request is signed correctly: the test verifies the signature with the matching public key and checks scopes and expiry.<br>2. Firestore values convert both ways (text, numbers, lists, nested maps).<br>3. Listing users, habits and devices, reading logs, and the slot claim with its precondition match the contract; the push is data-only, addressed by installation ID, lives 30 minutes, high urgency.<br>4. HTTP errors surface with their status; "device no longer registered" (404) and "precondition failed" are reported separately; a send is retried once on 429 or 5xx.<br>5. `scripts/` imports only `node:` modules and its own files; service addresses can be overridden (for the emulator); the private key never appears in output (asserted). | R4, R11 |
| B4 | `npm test`, with a stand-in for the network:<br>1. A habit due at the slot, for a user with two devices, sends two messages carrying the habit name, progress text and habit id.<br>2. Target already hit (daily and weekly): no message.<br>3. The same slot run twice: the second run sends nothing. Two runs racing for one slot: exactly one sends (the other fails the claim and exits 0). The slot is claimed before the first send.<br>4. One missed run is caught up; older slots are not replayed; the first ever run (no bookmark) sends the current slot only.<br>5. The same local time in two time zones fires at the right moment for each, including a zone with a 45-minute offset; a time skipped by spring-forward is sent at the next slot.<br>6. A device reported as unregistered (404) is deleted and the run still succeeds; no device is deleted on any other error; one user's failure does not stop the others, and the run then exits 1.<br>7. Missing or malformed key: exit code 1, a clear message, no key printed.<br>8. Runs from a clean checkout with only `node` (no install) and finishes in under 5 seconds against the stand-in. | R4, R11 |
| B1 | `npm run test:emulator`:<br>1. The same contract tests as A1 pass against the emulator with the real rules loaded.<br>2. Two stores signed in as one user: a change in one reaches the other within 2 seconds.<br>3. Both add +1 at the same moment: the count is 2.<br>4. Sign-up creates the user record with its time zone; `setTimeZone` changes only the user record. An account the rules refuse ends in the "waiting" state, not an error.<br>5. In demo mode the page loads without downloading any Firebase code (network log).<br>6. The offline cache is switched on for browsers (read in review; proven in L1.3). | R1, R2, R6, R8, R10, R12 |
| B5 | 1. Demo mode or an unsupported browser: the status says so; no permission prompt, no error.<br>2. Permission is asked only inside the "enable" call; if refused the status is "blocked".<br>3. `npm test` with a stand-in messaging service: enabling registers by installation ID and saves one device record owned by the signed-in user; enabling twice keeps one; a new ID replaces the old record; disabling deletes the record and unregisters. Only `register`, `onRegistered`, `onUnregistered` and `unregister` are used (no deprecated token calls).<br>4. A real registration on the real project cannot be checked before L3 and is listed there. | R4 |
| B6 | 1. Both workflow files pass a workflow syntax check.<br>2. Reminder workflow: runs at minutes 26 and 56, has a manual "Run workflow" button, one job, no install step, a time limit of 3 minutes or less, runs cannot overlap (`cancel-in-progress: false`), the key is read only from the `FIREBASE_SERVICE_ACCOUNT` secret, and once a week it re-enables itself so the 60-day rule for public repositories never pauses it.<br>3. CI workflow: a push or pull request runs `npm ci`, `npm test` and `npm run build`; it uses no secrets and does not deploy.<br>4. The README section "If reminders stop" explains the 60-day rule and the Enable button.<br>5. `docs/owner-setup.md`: numbered steps, each with how to tell it worked; the reviewer follows it cold with no questions. No secret value anywhere in the repo. | R4, R11 |
| L1 | `npm run test:e2e:emulator`:<br>1. User 1 signs up in a phone-size window, adds a habit and logs. The same user signs in in a second window and sees the same data; a tap in one shows in the other without a reload.<br>2. User 2 signs up and sees an empty app.<br>3. Window 1 goes offline; two taps show at once; back online, window 2 shows them.<br>4. The reminder job, run against the emulator with a stand-in push service: one message per device for a due habit; none after the target is hit; none on a rerun of the same slot.<br>5. Screenshots of 1 to 3 are saved. | R4, R8, R10, R12 |
| L2 | **Needs owner.**<br>1. The lead deploys the build, rules and indexes through the Firebase connection; the app opens at `https://habit-tally.web.app`; CI is green on `main`.<br>2. The owner signs up with email on the phone and signs in on a desktop: a habit added on one appears on the other within 10 seconds, both ways.<br>3. A second account that is not invited sees the waiting screen and none of the owner's data; a request to the database without sign-in is refused.<br>4. Phone in airplane mode: a tap is logged; after reconnecting, the desktop shows it.<br>5. Chrome on Android offers "Install"; the installed app opens full screen from the home screen.<br>6. Firebase console: Spark plan, no billing account. | R7 to R12 |
| L3 | **Needs owner.**<br>0. First, before anything else: one manual run proves that a message addressed by installation ID reaches the phone and is shown by our own notification code. If it does not, switch the one constant in `scripts/lib/google.mjs` to the fallback field and repeat.<br>1. The owner taps "Turn on reminders" and allows; a device record appears.<br>2. With a reminder set for the current half hour, a manual run of the workflow puts a notification on the phone with the habit name as title; tapping it opens the app.<br>3. A scheduled (not manual) reminder arrives between 5 minutes before and 20 minutes after its time.<br>4. With the target hit before the reminder time, no notification arrives and the job log says it was skipped.<br>5. Over 24 hours of scheduled runs: none failed and each took under 30 seconds. | R4, R11 |
| L4 | 1. On `main`: `npm test`, `npm run test:emulator`, `npm run test:e2e`, `npm run test:e2e:emulator` all pass.<br>2. Every row of the table below has an evidence link in `docs/status.md` (test name, screenshot, or dated note of a live check).<br>3. `git log -p \| grep -c "BEGIN PRIVATE KEY"` prints 0.<br>4. `README.md` says how to run, test and deploy, and what to do if reminders stop.<br>5. The lead signs off; the owner confirms both levels of "shown working". | All |

**Requirement to packages**

| Req | Level | Packages | Checks that prove it | First shown at |
|---|---|---|---|---|
| R1 habits: add, edit, delete | Must | A1, A3, B1, B2, A7 | A3.1, A3.2, A1.1, B2.3, A7.1 | M1 |
| R2 one-tap log, undo | Must | A1, A2, B1, A7 | A2.1, A1.1, A7.1 | M1 |
| R3 Today screen | Must | A2, A7 | A2.2, A7.1 | M1 |
| R4 phone notifications | Must | A3, A5, A6, B3, B4, B5, B6, L1, L3 | A3.3, A3.4, A6.4, B4.1 to B4.5, L1.4, L3.2 to L3.4 | M2 (simulated), M4 (phone) |
| R5 history and streaks | Must | L0, A4, A7 | L0.1, A4.1, A4.2 | M1 |
| R6 fix a missed day | Must | A1, A2, B1, A7 | A2.3, A1.1, A7.1 | M1 |
| R7 phone and desktop browsers | Must | A2, A7, L2 | A2.4, A7.1, L2.2 | M1, M3 |
| R8 sync | Must | B1, L1, L2 | B1.2, B1.3, L1.1, L2.2 | M2, M3 |
| R9 installs on Android | Must | A6, L2 | A6.1, L2.5 | M1 (installable), M3 (phone) |
| R10 email sign-up, private data | Must | A5, B1, B2, L1, L2 | A5.1 to A5.3, B2.1, B2.2, L1.2, L2.3 | M2, M3 |
| R11 free to run | Should | B3, B4, B6, L2, L3 | B3.5, B4.8, B6.4, L2.6, L3.5 | M4 |
| R12 offline logging | Should | A1, A6, B1, L1, L2 | A6.2, L1.3, L2.4 | M1 (demo), M2, M3 |
| R13 15-week calendar | Should | A4, A7 | A4.3, A7.3 | M1 |
| R14 light and dark | Could | A2, A5, A7 | A2.6, A5.5 | M1 |

## 4. Review process

**Handing over.** The developer gives the reviewer the branch name, the output of each acceptance check, and anything left undone. A package is not "in review" without all three.

**What the reviewer does, in this order**

1. Confirms the diff touches only the package's own files (`git diff --stat main...wp/<id>`).
2. Runs every acceptance check personally. The developer's report is not evidence.
3. Reads the whole diff against `docs/contracts.md`: correct behaviour, edge cases (week and month boundaries, time zones, zero and maximum values), and tests that would fail if the behaviour broke.
4. Security: no keys or tokens in code, logs or tests; text typed by users is escaped before it is shown; rules refuse by default; nothing is loaded from another website.

**"Changes requested" means any one of:** an acceptance check fails or cannot be run; a file outside the package's ownership is touched; a listed check has no test where one is possible; the code departs from the contract without the lead's agreement; any security finding; unrelated changes mixed in. Matters of taste do not block: the reviewer lists them and the developer fixes or declines them.

After two rounds of changes on one package the lead decides: fix, split, or merge with a follow-up recorded in `docs/status.md`.

**Definition of done.** All of: every acceptance check passes on the branch brought up to date with `main`; the reviewer has approved; the lead has merged; `npm test` and `npm run build` pass on `main` after the merge; `docs/status.md` is updated with the evidence.

## 5. Needed from the owner

| # | What only the owner can do | Needed by | Blocked until then |
|---|---|---|---|
| 1 | Sign up in the live app with email and password, then tell the lead (the lead adds the account to the invite list) | L2.2 | L2, L3, L4 |
| 2 | Have the Android phone and a desktop browser to hand for about 30 minutes | L2.2 to L2.5 | M3 |
| 3 | Create the `reminder-job` service account and its key, and paste the key into the repository as the secret `FIREBASE_SERVICE_ACCOUNT`. It must not be sent to the team or put in chat | L3 | The reminder job |
| 4 | Generate the Web Push key pair in the Firebase console and tell the lead the public key (it is public by design) | L3.1 | Push registration on the real project |
| 5 | Install the app on the phone, allow notifications, and stay reachable for about an hour; reply the next day for the 24-hour check | L3 | M4 |

Already done by the owner: the Firebase and GitHub connections, the repository `MahmoudHendi1/habit-tally`. Already done by the lead: the Firebase project `habit-tally` on the free plan, the database in `europe-west2`, email sign-in, the web app registration.

Nothing in M0, M1 or M2 waits for the owner. `docs/owner-setup.md` (B6) gives the exact steps; it is sent as soon as it passes review so items 3 and 4 can be done while development continues.

Points the lead settles in L0, with the default this plan assumes: "last 7 days" in R6 means today plus the 7 days before; sign-up is by invite list in the rules (the owner is asked to confirm); Google sign-in is not in v1.

## 6. Risks to the schedule

| Risk | What we do about it |
|---|---|
| The architecture changes after parallel work has started | L0 does not close until the architecture review is closed. Packages are cut by module, so a change to how data is stored or how due reminders are found touches B1, B2 and B4 only. Any contract change goes through the lead, gets a new version tag, and the shared contract tests show which store has fallen behind. |
| The owner's setup arrives late | M0 to M2 need nothing from the owner. The setup guide goes out early. L2 and L3 are small because everything else was proven on the emulator first. |
| Something works on the emulator but not live (push delivery to the phone by installation ID, GitHub's timer) | L1 narrows this to the parts that cannot be simulated. The reminder workflow has a manual run button so L3 does not wait on the timer. One fix-and-retest round is planned into L3; fixes go back through the owning package and the reviewer. |
| GitHub pauses the schedule (public repositories: after 60 days without activity) | The workflow re-enables itself weekly (B6.2); the README says what to do; standard runners are free for public repositories, so minutes are not a limit. Emulator and browser tests still run locally. |
| Two agents overwrite each other's work | One worktree and branch per package, the ownership table, lead-only shared files, and review step 1 rejecting any diff outside ownership. |
| A2 or the single reviewer becomes a queue (four app packages wait on A2; six packages can land together in step 4) | A2 is kept to the skeleton and one screen and is split if it grows. The reviewer takes packages that unblock others first (L0, A1, A2, B2, B3). Packages stay under 500 lines. |
