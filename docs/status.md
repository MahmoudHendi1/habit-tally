# Habit Tally: status

One line per package. States: not started, in progress, in review, changes requested, merged.

| Id | Title | Owner | State | Evidence |
|---|---|---|---|---|
| L0 | Contracts and project skeleton | Lead | merged | `docs/contracts.md` (tag `contract-v1`); `npm test` 17 of 17; `npm run build` and `npm run build:demo` pass; emulators start |
| A1 | Demo store | Dev A | merged | Reviewer approved; `npm test` 52 of 52 on main |
| A2 | App skeleton and Today screen | Dev A | merged | Reviewed on `wp/app`, 8 findings fixed; `npm test` on main; demo walk-through passed |
| A3 | Habit editor with reminder times | Dev A | merged | Reviewed on `wp/app`, 8 findings fixed; `npm test` on main; demo walk-through passed |
| A4 | Progress screen and 15-week calendar | Dev A | merged | Reviewed on `wp/app`, 8 findings fixed; `npm test` on main; demo walk-through passed |
| A5 | Sign-in and Settings screens | Dev A | merged | Reviewed on `wp/app`, 8 findings fixed; `npm test` on main; demo walk-through passed |
| A6 | Install and offline shell, notification display | Dev A | merged | Reviewed on `wp/app`, 8 findings fixed; `npm test` on main; demo walk-through passed |
| A7 | Demo walk-through test and screenshots | Dev A | not started | |
| B2 | Security rules | Dev B | merged | Reviewed, fix round done; `npm run test:emulator` 63 of 63 on main; headers and rewrite checked on the hosting emulator |
| B3 | Google API client for the job | Dev B | merged | Reviewed, fix round done; `npm test` 65 of 65 on main |
| B1 | Firebase store | Dev B | merged | Reviewed, 7 fixes made; `npm run test:emulator` 153 of 153 with routines |
| B4 | Reminder job | Dev B | merged | Reviewed, 4 findings fixed; `npm test` 92 of 92 on main |
| B5 | Push registration | Dev B | merged | Reviewed, fixes made; 30 push tests; owner's Web Push public key in `src/firebase-config.js` |
| B6 | Workflows and owner setup guide | Dev B | in review | CI workflow and `docs/owner-setup.md` on main; `reminders.yml` stays on `wp/B6` until the owner has saved the secret (a schedule without the key would fail every 30 minutes) |
| L1 | Local integration on the emulator | Lead | merged | `npm run test:e2e:emulator`: 7 of 7 steps, repeatable; fails when an expectation is broken |
| L2 | Go live: deploy, sign-in, sync | Lead | not started | Needs owner |
| L3 | Reminders on the owner's phone | Lead | not started | Needs owner |
| L4 | Final review and handover | Lead | not started | |

16 Nov 2026: the real app (sign-in, invite-only) and the new rules are deployed; the demo stays at https://habit-tally.web.app/?demo=sample. Invite list still empty until the owner signs up.
Routines R0 to R3 merged on 16 Nov 2026 (reviewed, 5 fixes). Open follow-up: soft-deleted habits and routines are never purged, so after many deletions the job's read limits (300 habits, 50 routines) could hide live ones.
