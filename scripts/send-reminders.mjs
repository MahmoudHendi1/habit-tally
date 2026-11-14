// The reminder job: run every 30 minutes by GitHub Actions, sends habit reminders as web push messages.
// Zero npm dependencies. Contract: docs/contracts.md section 9; flow: docs/architecture.md section 4.
// Everything about dates, zones and what is due is decided by shared/logic.js.
//
// run({ google, now, log, force, deadlineMs, clock, sleep }) -> { slot, sent, skipped, failed, removed }
//   google  the client of scripts/lib/google.mjs (or a stand-in with the same calls)
//   now     ms since epoch: decides the slot
//   log     function taking one line of text. The Actions log of a public repository is public, so a line holds
//           only counts, the slot time in UTC, HTTP statuses and error codes: never a key, token, email, uid,
//           device id, habit name or anything a server answered.
//   force   true = a manual test run: the bookmark is neither read nor written, the window is the current
//           slot only, and the reminders are sent even if the slot was already handled.
//   deadlineMs, clock   the time the run may take, measured with clock(), a function returning ms (default: the
//           process's monotonic clock; tests pass a fake). Default 120 s: no push is started after it, and one
//           started just before it (at worst about 25 s) still ends inside the workflow's 3-minute limit.
//   sleep   function waiting the given ms before a failed read is tried again (tests pass one that does not wait).
//
//   Order: read the bookmark `system/reminders` and plan the run; read everything (users, then per user habits,
//   logs and devices, one user after another); claim the slot; send. The claim is written even when there is
//   nothing to send, and always before the first push.
//
//   Result:
//     slot     the slot (ms) this run handled; null when it did nothing: the slot was already claimed, another
//              run won the claim, the bookmark is ahead of the clock, or the slot is left for the next run (no
//              user could be read, reading left too little time to send, or two claims in a row were lost)
//     sent     push messages FCM accepted (one per due habit per device)
//     skipped  habits with a reminder time in the window that got no reminder because the logs show them done:
//              target hit for the day or week, or a weekly habit already logged today. Not counted: habits
//              without a time in the window, archived, deleted or invalid habits, habits over the per-user
//              limit, and due habits of a user who has no device
//     failed   users whose data could not be read + pushes that failed or were not sent for lack of time + device
//              records that could not be deleted; 1 more when reading left too little time to send; 1 for a
//              bookmark ahead of the clock or a slot left unclaimed after two lost claims
//     removed  device records deleted because FCM reported them as unregistered
//
//   Failures:
//     - Reading the bookmark, listing the users or the claim fails (anything but a PreconditionError): run()
//       rejects with that error. Nothing was sent, and unless the claim itself went wrong the slot is unclaimed.
//     - Reading one user's habits, logs or devices fails: the read is tried once more (one retry per user, after
//       1 s, and only while there is still time to claim). If that fails too, the user is counted in `failed` and
//       gets nothing for this slot; the others are still served and the slot is claimed. If no user at all could
//       be read (a Firestore outage, or the only user), nothing is claimed, so the next run catches the slot up.
//     - A lost claim (PreconditionError): the bookmark is read again. If it now holds this slot (or a newer one),
//       that is a success: every count is 0, the other run reports its own. If it holds an older slot (a late run
//       for the slot before), this run starts again from the new bookmark: it plans, reads and claims once more,
//       so nothing the other run sent is sent twice. If that claim is lost to an older slot too, the run fails
//       having sent nothing, and the slot is left for the next run.
//     - The bookmark is more than one slot ahead of the slot this run would take (a wrong clock, a manual edit):
//       reminders would silently stop, so the run fails. Nothing is sent, the bookmark is not touched.
//     - Out of time: when the reading ends less than 30 s before the deadline, nothing is claimed or sent (the
//       next run retries the slot) and the run fails; while sending, no further push is started after the
//       deadline and each one left over counts as failed.
//
// main({ env, log, makeGoogle, now }) -> exit code. Executed directly (`node scripts/send-reminders.mjs`) it runs
// with its defaults: builds `google` from the environment (FIREBASE_SERVICE_ACCOUNT; optional
// FIRESTORE_EMULATOR_HOST, FCM_BASE_URL, GCLOUD_PROJECT), calls run() (forced only when REMINDERS_FORCE is exactly
// '1'), prints a summary and exits 0, or 1 if anything failed or the key is missing or malformed. Tests pass
// their own environment, log, clock time and `makeGoogle(env) -> google`.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readServiceAccount, createGoogle, ConfigError, GoogleError, PreconditionError } from './lib/google.mjs';
import {
  planRun, dueWindows, dueHabits, reminderText, validateHabit, weekKeys, monthId, SLOT_MS,
} from '../shared/logic.js';

const BOOKMARK = 'system/reminders';
const MAX_HABIT_DOCS = 300; // habit records read per user: 50 live ones plus room for soft-deleted ones
const MAX_HABITS = 100; // habits with a reminder time in the window considered per user and run
const MAX_DEVICES = 10; // per user: the most recently updated ones
const TITLE_MAX = 60;
const BODY_MAX = 120;
const DEADLINE_MS = 120 * 1000;
const SEND_RESERVE_MS = 30 * 1000; // no claim when less than this is left before the deadline
const RETRY_WAIT_MS = 1000; // before a failed read is tried again
const TIMEOUT_MS = 10 * 1000; // one HTTP request
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/; // what the security rules accept as a device id

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cap = (text, max) => Array.from(String(text)).slice(0, max).join('');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** '2026-11-13T09:00Z' */
function utc(ms) {
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? 'an unreadable time' : `${d.toISOString().slice(0, 16)}Z`;
}

/** What may be printed about an error: never its message (except our own ConfigError texts) or `detail`. */
function describe(err) {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof GoogleError) {
    const code = /^[A-Za-z0-9_]{1,40}$/.test(String(err.code)) ? err.code : 'UNKNOWN';
    return `HTTP ${Number(err.status) || 0} ${code}`;
  }
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
}

/** A stored habit as shared/logic.js wants it, or null when it is not a valid habit (hostile or broken data). */
function toHabit(doc) {
  const d = isMap(doc.data) ? doc.data : {};
  const habit = {
    id: doc.id, name: d.name, period: d.period, target: d.target, unit: d.unit, times: d.times,
    archived: Boolean(d.archived), deletedAt: d.deletedAt || null,
  };
  return typeof doc.id === 'string' && doc.id && validateHabit(habit).length === 0 ? habit : null;
}

/** One stored month as shared/logic.js wants it: `days` must be a map and each day a map. What a count is worth
 *  is for the shared logic to decide, so the job and the app agree on "done". */
function monthOf(days) {
  return Object.fromEntries(Object.entries(isMap(days) ? days : {}).filter(([, counts]) => isMap(counts)));
}

/** Reads what one user needs. Returns the messages to send and the devices to send them to.
 *  `mayRetry()` says whether there is time to try a failed read again; one read per user gets a second try. */
async function readUser(google, user, plan, stats, mayRetry, sleep) {
  let retries = 1;
  const read = async (call) => {
    try { return await call(); } catch (err) {
      if (!retries || !mayRetry()) throw err;
      retries -= 1;
      stats.retried += 1;
      await sleep(RETRY_WAIT_MS);
      return call();
    }
  };
  const uid = user.id;
  const tz = typeof user.data?.tz === 'string' && user.data.tz ? user.data.tz : 'UTC'; // an unknown zone is UTC too
  const windows = dueWindows(plan.from, plan.slot, tz);
  if (!windows.length) return null; // no local time in the window (the hour the clocks go back): no reads

  const docs = await read(() => google.listDocs(`users/${uid}/habits`, { limit: MAX_HABIT_DOCS }));
  if (docs.length >= MAX_HABIT_DOCS) stats.atReadLimit += 1;
  const habits = docs.map(toHabit).filter(Boolean);
  stats.invalidHabits += docs.length - habits.length;
  // Live habits with a reminder time in the window: the same test as dueHabits, before any count is known.
  const inWindow = new Set(windows.flatMap((w) => dueHabits(habits, {}, w.day, w.times)));
  const candidates = habits.filter((h) => inWindow.has(h)).slice(0, MAX_HABITS);
  stats.overLimit += inWindow.size - candidates.length;
  if (!candidates.length) return null;

  const logs = {};
  for (const month of new Set(windows.flatMap((w) => weekKeys(w.day)).map(monthId))) {
    logs[month] = monthOf((await read(() => google.getDoc(`users/${uid}/logs/${month}`)))?.data?.days);
  }

  const due = new Map(); // habit -> the latest local day it is due on
  for (const w of windows) for (const h of dueHabits(candidates, logs, w.day, w.times)) due.set(h, w.day);
  stats.skipped += candidates.length - due.size;
  if (!due.size) return null;
  stats.due += due.size;

  const found = await read(() => google.queryEqual('devices', 'uid', uid));
  const usable = found.filter((d) => typeof d.id === 'string' && DEVICE_ID.test(d.id) && d.data?.uid === uid);
  const newest = (d) => (Number.isFinite(d.data.updatedAt) ? d.data.updatedAt : 0);
  const devices = usable.sort((a, b) => newest(b) - newest(a)).slice(0, MAX_DEVICES).map((d) => d.id);
  stats.badDevices += found.length - usable.length;
  stats.overLimit += usable.length - devices.length;
  stats.devices += devices.length;
  if (!devices.length) {
    stats.noDevice += due.size;
    return null;
  }
  const messages = [...due].map(([h, day]) => {
    const text = reminderText(h, logs, day); // a valid habit stays well inside the caps; they hold whatever comes
    return { title: cap(text.title, TITLE_MAX), body: cap(text.body, BODY_MAX), tag: h.id, url: '/' };
  });
  return { messages, devices };
}

export async function run({
  google, now, log = () => {}, force = false, deadlineMs = DEADLINE_MS, clock = () => performance.now(),
  sleep = (ms) => new Promise((done) => { setTimeout(done, ms); }),
}) {
  if (!Number.isFinite(now)) throw new TypeError('run() needs `now` in ms since epoch');
  const started = clock();
  const elapsed = () => clock() - started;
  const late = () => elapsed() > deadlineMs;
  const tooLateToClaim = () => elapsed() > deadlineMs - SEND_RESERVE_MS;
  let result;
  let failures; // what failed -> how often, so a bad run still logs only a few lines
  const fail = (what, err) => {
    result.failed += 1;
    const line = `${what}, ${describe(err)}`;
    failures.set(line, (failures.get(line) ?? 0) + 1);
  };
  const logFailures = () => { for (const [line, n] of failures) log(`Failed ${n} x: ${line}.`); };
  const stop = (what, err) => {
    logFailures();
    log(`Run stopped, ${what} failed: ${describe(err)}. Nothing was sent.`);
    return err;
  };
  const unclaimed = 'the slot is not claimed, so the next run retries it. Nothing was sent.';

  let bookmark = null;
  let plan;
  let users;
  let stats;
  let jobs;
  // One pass plans, reads and claims. A second pass follows only when the claim was lost to a run for an older slot.
  for (let pass = 1; ; pass += 1) {
    result = { slot: null, sent: 0, skipped: 0, failed: 0, removed: 0 };
    failures = new Map();

    // 1. Plan
    if (force) {
      plan = planRun(null, now);
    } else {
      try { bookmark = await google.getDoc(BOOKMARK); } catch (err) { throw stop('reading the bookmark', err); }
      const lastSlot = bookmark?.data?.lastSlot;
      plan = planRun(lastSlot, now);
      if (!plan && pass > 1) {
        log(`Another run claimed slot ${utc(lastSlot)}: nothing sent.`);
        return result;
      }
      if (!plan) {
        const current = planRun(null, now).slot;
        if (lastSlot > current + SLOT_MS) {
          log(`The bookmark (${utc(lastSlot)}) is ahead of the clock (slot ${utc(current)}): reminders are on hold `
            + 'until it is corrected. Nothing was sent, the bookmark is unchanged.');
          result.failed = 1;
        } else {
          log(`Nothing to do: the newest claimed slot is ${utc(lastSlot)}.`);
        }
        return result;
      }
      if (pass > 2) {
        log(`Two claims in a row were lost to other runs and slot ${utc(plan.slot)} is still open: ${unclaimed}`);
        result.failed = 1;
        return result;
      }
      if (pass > 1) {
        log(`The claim was lost to a run for another slot (newest claimed slot: ${utc(lastSlot)}): starting again.`);
      }
    }

    // 2. Read everything
    if (!users) {
      try { users = await google.listDocs('users'); } catch (err) { throw stop('listing the users', err); }
    }
    stats = {
      due: 0, skipped: 0, devices: 0, noDevice: 0, invalidHabits: 0, badDevices: 0, overLimit: 0, atReadLimit: 0,
      retried: 0,
    };
    jobs = [];
    let unread = 0;
    for (const user of users) {
      if (tooLateToClaim()) break;
      try {
        const job = await readUser(google, user, plan, stats, () => !tooLateToClaim(), sleep);
        if (job) jobs.push(job);
      } catch (err) {
        unread += 1;
        fail('reading a user', err);
      }
    }
    const extra = [
      stats.noDevice && `${stats.noDevice} due without a device`,
      stats.invalidHabits && `${plural(stats.invalidHabits, 'invalid habit')} ignored`,
      stats.badDevices && `${plural(stats.badDevices, 'unusable device record')} ignored`,
      stats.overLimit && `${stats.overLimit} over the per-user limits ignored`,
      stats.retried && `${plural(stats.retried, 'failed read')} tried again`,
    ].filter(Boolean).map((part) => `, ${part}`).join('');
    log(`Slot ${utc(plan.slot)}, window ${(plan.slot - plan.from) / 60000} min: ${plural(users.length, 'user')}, `
      + `${plural(stats.due, 'reminder')} due, ${stats.skipped} skipped (already done), `
      + `${plural(stats.devices, 'device')}${extra}.`);
    if (stats.atReadLimit) {
      log(`Habit records: ${plural(stats.atReadLimit, 'user')} reached the read limit of ${MAX_HABIT_DOCS}; `
        + 'anything beyond it was not looked at.');
    }
    if (tooLateToClaim()) {
      logFailures();
      log(`Reading ended less than ${SEND_RESERVE_MS / 1000} s before the time limit (${deadlineMs / 1000} s), `
        + `too late to send: ${unclaimed}`);
      result.failed += 1;
      return result;
    }
    if (unread && unread === users.length) {
      logFailures();
      log(`No user could be read: ${unclaimed}`);
      return result;
    }

    // 3. Claim, before the first push
    if (force) {
      log('Forced run: the bookmark was not read and is not changed.');
      break;
    }
    try {
      await google.setDoc(BOOKMARK, { lastSlot: plan.slot, updatedAt: now },
        bookmark ? { ifUpdateTime: bookmark.updateTime } : { ifMissing: true });
      break;
    } catch (err) {
      // Lost to another run. Which slot it took decides what happens next: the bookmark is read again above.
      if (!(err instanceof PreconditionError)) throw stop('claiming the slot', err);
    }
  }
  result.slot = plan.slot;
  result.skipped = stats.skipped;

  // 4. Send
  let unsent = 0;
  for (const { messages, devices } of jobs) {
    const gone = new Set();
    for (const data of messages) {
      for (const fid of devices) {
        if (gone.has(fid)) continue;
        if (unsent || late()) { unsent += 1; continue; } // out of time: nothing more is started
        let outcome;
        try { outcome = await google.sendPush(fid, data); } catch (err) { fail('a push', err); continue; }
        if (outcome !== 'unregistered') { result.sent += 1; continue; }
        gone.add(fid);
        try {
          await google.deleteDoc(`devices/${fid}`);
          result.removed += 1;
        } catch (err) { fail('deleting an unregistered device', err); }
      }
    }
  }
  logFailures();
  if (unsent) {
    result.failed += unsent;
    log(`Time limit (${deadlineMs / 1000} s) reached while sending. Pushes not sent: ${unsent}.`);
  }
  return result;
}

/** `google` for the command, from the environment. */
function googleFromEnv(env) {
  return createGoogle({
    serviceAccount: readServiceAccount(env), projectId: env.GCLOUD_PROJECT,
    firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST, fcmBaseUrl: env.FCM_BASE_URL, timeoutMs: TIMEOUT_MS,
  });
}

/** The command: returns the exit code. Only `REMINDERS_FORCE=1` makes a forced run. */
export async function main({
  env = process.env, log = console.log, makeGoogle = googleFromEnv, now = Date.now(),
} = {}) {
  let google;
  try {
    google = makeGoogle(env);
  } catch (err) {
    log(`Reminder job cannot start: ${describe(err)}.`);
    return 1;
  }
  let result;
  try {
    result = await run({ google, now, log, force: env.REMINDERS_FORCE === '1' });
  } catch (err) {
    log(`Reminder run failed: ${describe(err)}.`);
    return 1;
  }
  log(`Done: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed, `
    + `${plural(result.removed, 'device')} removed.`);
  return result.failed ? 1 : 0;
}

function executedDirectly() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}

if (executedDirectly()) process.exitCode = await main();
