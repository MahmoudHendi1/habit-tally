# Habit Tally: status

One line per package. States: not started, in progress, in review, changes requested, merged.

| Id | Title | Owner | State | Evidence |
|---|---|---|---|---|
| L0 | Contracts and project skeleton | Lead | merged | `docs/contracts.md` (tag `contract-v1`); `npm test` 17 of 17; `npm run build` and `npm run build:demo` pass; emulators start |
| A1 | Demo store | Dev A | merged | Reviewer approved; `npm test` 52 of 52 on main |
| A2 | App skeleton and Today screen | Dev A | in review | Built on `wp/A2`; screenshots checked by the lead |
| A3 | Habit editor with reminder times | Dev A | in progress | |
| A4 | Progress screen and 15-week calendar | Dev A | in progress | |
| A5 | Sign-in and Settings screens | Dev A | in progress | |
| A6 | Install and offline shell, notification display | Dev A | in progress | |
| A7 | Demo walk-through test and screenshots | Dev A | not started | |
| B2 | Security rules | Dev B | merged | Reviewed, fix round done; `npm run test:emulator` 63 of 63 on main; headers and rewrite checked on the hosting emulator |
| B3 | Google API client for the job | Dev B | merged | Reviewed, fix round done; `npm test` 65 of 65 on main |
| B1 | Firebase store | Dev B | in progress | |
| B4 | Reminder job | Dev B | in review | Built on `wp/B4`; 24 job tests |
| B5 | Push registration | Dev B | not started | |
| B6 | Workflows and owner setup guide | Dev B | not started | |
| L1 | Local integration on the emulator | Lead | not started | |
| L2 | Go live: deploy, sign-in, sync | Lead | not started | Needs owner |
| L3 | Reminders on the owner's phone | Lead | not started | Needs owner |
| L4 | Final review and handover | Lead | not started | |
