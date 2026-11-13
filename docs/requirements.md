# Habit Tally: requirements (agreed with the owner, 13 Nov 2026)

A personal habit tracker for one person now, with other people able to sign up later. English only.
Used mostly on an Android phone (installed from the browser, no Play Store) and sometimes in a desktop browser.

## Must
- R1  Add, edit, delete a habit: name, target as times per day OR times per week (e.g. gym 3 times a week), optional unit label.
- R2  Log one completion with one tap; undo a mistaken tap. Taps only, no amounts.
- R3  Today screen: each habit's progress against its target, and how many habits are done.
- R4  Phone notifications at one or more chosen times a day per habit, skipped once the target is hit.
      Times are in half-hour steps. "Every N hours between X and Y" quick-fill.
- R5  History per habit: total times done, periods the target was hit, current streak, best streak.
      Weekly habits are counted by week, Monday to Sunday.
- R6  Fix a missed day: log for any of the last 7 days.
- R7  Works in a phone browser and a desktop browser.
- R8  Same data on phone and computer (sync).
- R9  Installs to the Android home screen (PWA).
- R10 Sign up with email; each person sees only their own data.
## Should
- R11 Free to run: Firebase free (Spark) plan, no payment card. No Cloud Functions.
- R12 Logging works offline and syncs later.
- R13 Calendar-style view of the last 15 weeks per habit.
## Could
- R14 Light and dark mode.

## Decided constraints
- Backend: Firebase Spark plan (Auth, Firestore, Hosting, Cloud Messaging).
- Reminder sender: a scheduled GitHub Actions job every 30 minutes in a PRIVATE repo. GitHub Free gives 2,000
  Actions minutes a month for private repos and bills each job rounded up to a whole minute, so the job must
  finish in well under 60 seconds (about 1,460 runs a month).
- Reminders may arrive 5 to 20 minutes late (GitHub does not guarantee schedule timing).

## Later (not in the first version)
Evening summary nudge, habits on chosen weekdays only, archive, export, notes, monthly charts.
