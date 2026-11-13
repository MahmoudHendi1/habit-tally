# Review of architecture draft 1

**Verdict.** The overall shape (PWA, Firestore, FCM, cron job) is sound, but the push design rests on an FCM API Google has deprecated, R10 leaks reminders across accounts on a shared device, and the reminder flow can both silently swallow and double-send. Fix the two Blockers and switch D10 to a scan before writing code; the rest is cheap to correct now.

## Findings

**1. Blocker. D7, §3 `devices`, §4.6: built on deprecated FCM registration tokens.** In the installed SDK (firebase 12.19.0) `getToken` and `deleteToken` are `@deprecated`; the docs say the token method "will be removed in a future release" and warn against mixing it with the replacement, `register()` + `onRegistered` (Firebase installation ID, FID). https://firebase.google.com/docs/cloud-messaging/js/client, https://firebase.google.com/docs/cloud-messaging/manage-tokens. *Change:* store `fid`, not `token`; use `register`/`onRegistered`/`onUnregistered`/`unregister`. Spike on a real Android phone first: REST send to an FID (field name not verified) and the plain `push` handler under the FID flow.

**2. Blocker. §5, R10: sign-out leaves the registration behind.** Nothing removes `users/{A}/devices/*` on sign-out, so B signing in on that browser gets A's habit names, and a signed-out device keeps buzzing. A client-side delete alone fails offline. *Change:* top-level `devices/{registrationId} { uid, updatedAt }`, so a device has exactly one owner and the last sign-in overwrites it; rule `request.resource.data.uid == request.auth.uid`, owner-only read/delete. Sign-out also deletes the doc and calls `unregister()`.

**3. Major. §4.6–4.7: later reminders are silent.** `tag: habitId` with default `renotify: false` means the 13:30 reminder silently replaces an undismissed 09:00 one: no sound, no vibration. https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification. *Change:* `renotify: true`. Repeats then buzz again, so finding 4 becomes mandatory.

**4. Major. §4.3, §4.7: overlap, replay and first run.** No concurrency guard: a delayed :26 run and the :56 run (or a manual re-run) read the same `lastSlot` and both send. `lastSlot` is written once at the end, so a crash replays every user. Error policy per send is unspecified. First run replays four slots (`slotsToProcess(0, now)`), and a 90-minute-old reminder breaks the "5 to 20 minutes late" constraint. *Change:* `concurrency: { group: reminders, cancel-in-progress: false }`; checkpoint after each slot; missing `system/reminders` (REST 404) means current slot only; catch-up limited to one missed slot; retry a send once on 429/5xx, then continue and exit non-zero; delete a registration only on 404 UNREGISTERED, never on 400.

**5. Major. §4.4, §8 "Time zone or DST": exact `HH:MM` match drops reminders.** Slots are UTC half-hours; in Asia/Kathmandu, Australia/Eucla and Pacific/Chatham they land on :15/:45 and never match a stored time, so those users get nothing (checked with `localParts`). Half-hour zones are fine. Spring-forward skips two times (London 01:00, 01:30); autumn sends them twice. *Change:* a habit time is due when it falls in the local window (previous slot, this slot]. Accept one duplicate a year.

**6. Major. D10, §3 `system/zones`, habit `tz` copy.** Any signed-in account can append strings rules cannot validate as real zones; entries are never removed; each costs at least one query per slot forever. That is a quota and run-time attack on the job, for an optimisation one user does not need. The automatic `tz` rewrite also ping-pongs when two devices sit in different zones, and day keys (device zone) then disagree with the job's "today". *Change:* delete `system/zones`, the index and `habits.tz`; scan (see Q1). Change `users.tz` only after an explicit prompt.

**7. Major. §5: one over-privileged key.** The Admin SDK key in a repo secret can read every user's data and is also used to deploy. *Change:* two service accounts: `reminder-job` (`roles/datastore.user`, `roles/firebasecloudmessaging.admin`) and `deploy` (`roles/firebasehosting.admin`, `roles/serviceusage.apiKeysViewer`, plus rules and index-admin roles; exact names unverified). Never export the `firebase-adminsdk` key. Prefer Workload Identity Federation later.

**8. Major. Constraints, §8: Actions budget and open sign-up have no margin.** Free is now a $12 credit; at $0.006/min (Linux 2-core) that is 2,000 minutes, and 1,488 cron runs in a 31-day month take 74%. D12's emulator and Playwright deploy shares the rest; at zero "usage is blocked" and reminders stop silently. https://docs.github.com/en/billing/concepts/product-billing/github-actions. Separately, anyone can sign up and burn 20k writes/day on a plan with no card. *Change:* run the job on `ubuntu-slim` ($0.002/min, about 25% of the credit; confirm Node is on the image), `timeout-minutes: 2`, path-filter the deploy. For v1 allow only the owner's uid in rules; deleting that line opens sign-up.

**9. Minor. §3 delete (R1).** Hard delete loses name and target, with no undo; an offline `merge` edit from a second device resurrects a ghost `{order: 2}` (reproduced). *Change:* soft-delete (`deletedAt`) with undo; rules require the full habit shape.

**10. Minor. R4–R6 gaps.** Cap of 12 times rejects hourly 07:00–22:00 quick-fill (16); raise to 48. Back-filling before `created` counts in `total` but not in streaks; move `created` back. Editing a target rewrites history (13-day streak becomes 0): owner decision. Concurrent undo stores −1 and the next tap shows 0; clamp on read-back.

**11. Minor. §7 service worker.** Always call `showNotification` inside `waitUntil`, even on a parse failure. Set `webpush.headers` `TTL: "1800"` and `Urgency: "high"`. Precache lazy chunks at install (R12). Never `await` Firestore writes: they do not resolve offline.

## Verified claims

- **a. Confirmed from SDK source only; undocumented.** Payload is `{ data: { title, body, tag, url }, from, fcmMessageId, collapse_key }`; custom keys sit under `data`. `@firebase/messaging/dist/src/interfaces/internal-message-payload.d.ts`. Docs describe only `firebase-messaging-sw.js`: https://firebase.google.com/docs/cloud-messaging/web/receive-messages
- **b. Confirmed, but deprecated (finding 1).** `serviceWorkerRegistration` is accepted by `getToken` and `register`. `vapidKey` is optional in code, but "Chrome Push Service require[s] a non-default VAPID key": treat as required. `index-public.d.ts`.
- **c. Partly confirmed.** Collection-group scope index is required, one array field allowed: https://firebase.google.com/docs/firestore/query-data/index-overview. Client queries would need `rules_version = '2'` and `match /{path=**}/habits/{id}`: https://firebase.google.com/docs/firestore/security/rules-query. REST `allDescendants` and service-account bypass of rules: could not verify (reference pages unreadable); believed correct.
- **d. Could not verify.** Rules see only the resulting document (https://firebase.google.com/docs/firestore/security/rules-fields), not the transform. "Old list plus one regex-valid string" looks expressible; real-zone validation is not.
- **e. Confirmed, one correction.** $12 credit, not "minutes"; per-job round-up (https://docs.github.com/en/billing/reference/actions-runner-pricing); 5-minute minimum, delays and dropped runs, 60-day disable in public repos only (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
- **f. Could not verify the default roles** (https://firebase.google.com/support/guides/service-accounts lists none). From memory: Admin SDK service agent plus token creator, enough for (i) and (ii), not (iii). Documented roles: https://firebase.google.com/docs/projects/iam/roles-predefined-product
- **g. Confirmed client-side by experiment** (firebase 12.19.0, network disabled): queued `setDoc`-merge increments on `days.2026-11-13.<id-with-hyphen>` sum correctly locally. Server replay not tested.
- **h. Confirmed.** Firestore 1 GiB, 50k reads, 20k writes, 20k deletes a day; Hosting 10 GB and 360 MB/day; FCM no-cost. https://firebase.google.com/pricing

## Recommendations on the open questions

1. **Scan in v1.** One unfiltered collection-group read of `habits` per run, filter in memory with `dueHabits`. Ten habits cost 480 reads a day; the ceiling is about 1,000 habits. Adding the indexed query later is a backfill, not a redesign.
2. **Keep monthly documents.** Listen live to the current and previous month only; fetch older months once for Progress.
3. **Plain JS is fine for four screens,** but HTML-string rendering must escape habit names and units. Revisit at a fifth screen.
4. **Yes, both:** findings 3, 4 and 5.

**Cut for v1:** `system/zones`, the composite index, `habits.tz`, Google sign-in, multi-slot catch-up, Playwright in CI.
