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
| B1 | Firebase store | Dev B | in review | On `wp/B1`; `npm run test:emulator` 98 of 98 |
| B4 | Reminder job | Dev B | merged | Reviewed, 4 findings fixed; `npm test` 92 of 92 on main |
| B5 | Push registration | Dev B | in review | On `wp/B5`; 30 push tests |
| B6 | Workflows and owner setup guide | Dev B | in review | CI workflow and `docs/owner-setup.md` on main; `reminders.yml` stays on `wp/B6` until the owner has saved the secret (a schedule without the key would fail every 30 minutes) |
| L1 | Local integration on the emulator | Lead | not started | |
| L2 | Go live: deploy, sign-in, sync | Lead | not started | Needs owner |
| L3 | Reminders on the owner's phone | Lead | not started | Needs owner |
| L4 | Final review and handover | Lead | not started | |

Demo build published at https://habit-tally.web.app/?demo=sample on 14 Nov 2026 (from `wp/app`, hosting only; rules not yet deployed).
