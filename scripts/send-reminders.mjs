// The reminder job: run every 30 minutes by GitHub Actions, sends habit reminders as web push messages.
// Zero npm dependencies. Contract: docs/contracts.md section 9; flow: docs/architecture.md section 4.
// Everything about dates, zones and what is due is decided by shared/logic.js.
//
// run({ google, now, log, force }) -> { slot, sent, skipped, failed, removed }
//   google  the client of scripts/lib/google.mjs (or a stand-in with the same calls)
//   now     ms since epoch
//   log     function taking one line of text. The Actions log of a public repository is public, so a line holds
//           only counts, the slot time in UTC, HTTP statuses and error codes: never a key, token, email, uid,
//           device id, habit name or anything a server answered.
//   force   true = a manual test run: the bookmark is neither read nor written, the window is the current
//           slot only, and the reminders are sent even if the slot was already handled.
//
//   Order: read the bookmark `system/reminders` and plan the run; read everything (users, then per user habits,
//   logs and devices, one user after another); claim the slot; send. The claim is written even when there is
//   nothing to send, and always before the first push.
//
//   Result:
//     slot     the slot (ms) this run handled; null when it did nothing: the slot was already claimed, another
//              run won the claim, or no user could be read (the slot is then left for the next run)
//     sent     push messages FCM accepted (one per due habit per device)
//     skipped  habits with a reminder time in the window that got no reminder because the logs show them done:
//              target hit for the day or week, or a weekly habit already logged today. Not counted: habits
//              without a time in the window, archived, deleted or invalid habits, habits over the per-user
//              limit, and due habits of a user who has no device
//     failed   users whose data could not be read + pushes that failed + device records that could not be deleted
//     removed  device records deleted because FCM reported them as unregistered
//
//   Failures:
//     - Reading the bookmark, listing the users or the claim fails (anything but a PreconditionError): run()
//       rejects with that error. Nothing was sent, and unless the claim itself went wrong the slot is unclaimed.
//     - Reading one user's habits, logs or devices fails: that user is counted in `failed` and gets nothing for
//       this slot; the others are still served. If no user at all could be read (a Firestore outage, or the
//       only user), nothing is claimed, so the next run catches the slot up.
//     - A lost claim (PreconditionError) is a success: every count is 0, the other run reports its own.
//
// Executed directly (`node scripts/send-reminders.mjs`): builds `google` from the environment
// (FIREBASE_SERVICE_ACCOUNT; optional FIRESTORE_EMULATOR_HOST, FCM_BASE_URL, GCLOUD_PROJECT, REMINDERS_FORCE=1),
// calls run(), prints a summary and exits 0, or 1 if anything failed or the key is missing or malformed.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readServiceAccount, createGoogle, ConfigError, GoogleError, PreconditionError } from './lib/google.mjs';
import { planRun, dueWindows, dueHabits, reminderText, validateHabit, weekKeys, monthId } from '../shared/logic.js';

const BOOKMARK = 'system/reminders';
const MAX_HABITS = 100; // per user and run
const MAX_DEVICES = 10; // per user: the most recently updated ones
const TITLE_MAX = 60;
const BODY_MAX = 120;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/; // what the security rules accept as a device id

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cap = (text, max) => Array.from(String(text)).slice(0, max).join('');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** '2026-11-13T09:00Z' */
function utc(ms) {
  const d = new Date(ms);
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

/** The `logs` shape of shared/logic.js, holding only whole positive counts of the given habits on the given
 *  days: whatever else a client wrote into `days` never reaches the logic. */
function cleanLogs(daysByMonth, dayKeys, habitIds) {
  const logs = {};
  for (const k of dayKeys) {
    const stored = daysByMonth[monthId(k)]?.[k];
    if (!isMap(stored)) continue;
    for (const id of habitIds) {
      const n = Object.hasOwn(stored, id) ? stored[id] : 0;
      if (Number.isSafeInteger(n) && n > 0) ((logs[monthId(k)] ??= {})[k] ??= {})[id] = n;
    }
  }
  return logs;
}

/** Reads what one user needs. Returns the messages to send and the devices to send them to. */
async function readUser(google, user, plan, stats) {
  const uid = user.id;
  const tz = typeof user.data?.tz === 'string' && user.data.tz ? user.data.tz : 'UTC'; // an unknown zone is UTC too
  const windows = dueWindows(plan.from, plan.slot, tz);
  if (!windows.length) return null; // no local time in the window (the hour the clocks go back): no reads

  const docs = await google.listDocs(`users/${uid}/habits`);
  const habits = docs.map(toHabit).filter(Boolean);
  stats.invalidHabits += docs.length - habits.length;
  // Live habits with a reminder time in the window: the same test as dueHabits, before any count is known.
  const inWindow = new Set(windows.flatMap((w) => dueHabits(habits, {}, w.day, w.times)));
  const candidates = habits.filter((h) => inWindow.has(h)).slice(0, MAX_HABITS);
  stats.overLimit += inWindow.size - candidates.length;
  if (!candidates.length) return null;

  const dayKeys = [...new Set(windows.flatMap((w) => weekKeys(w.day)))];
  const daysByMonth = {};
  for (const month of new Set(dayKeys.map(monthId))) {
    const days = (await google.getDoc(`users/${uid}/logs/${month}`))?.data?.days;
    daysByMonth[month] = isMap(days) ? days : {};
  }
  const logs = cleanLogs(daysByMonth, dayKeys, candidates.map((h) => h.id));

  const due = new Map(); // habit -> the latest local day it is due on
  for (const w of windows) for (const h of dueHabits(candidates, logs, w.day, w.times)) due.set(h, w.day);
  stats.skipped += candidates.length - due.size;
  if (!due.size) return null;
  stats.due += due.size;

  const found = await google.queryEqual('devices', 'uid', uid);
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

export async function run({ google, now, log = () => {}, force = false }) {
  if (!Number.isFinite(now)) throw new TypeError('run() needs `now` in ms since epoch');
  const result = { slot: null, sent: 0, skipped: 0, failed: 0, removed: 0 };
  const failures = new Map(); // what failed -> how often, so a bad run still logs only a few lines
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

  // 1. Plan
  let bookmark = null;
  let plan;
  if (force) {
    plan = planRun(null, now);
  } else {
    try { bookmark = await google.getDoc(BOOKMARK); } catch (err) { throw stop('reading the bookmark', err); }
    const lastSlot = bookmark?.data?.lastSlot;
    plan = planRun(lastSlot, now);
    if (!plan) {
      log(`Nothing to do: the newest claimed slot is ${utc(lastSlot)}.`);
      return result;
    }
  }

  // 2. Read everything
  let users;
  try { users = await google.listDocs('users'); } catch (err) { throw stop('listing the users', err); }
  const stats = { due: 0, skipped: 0, devices: 0, noDevice: 0, invalidHabits: 0, badDevices: 0, overLimit: 0 };
  const jobs = [];
  let unread = 0;
  for (const user of users) {
    try {
      const job = await readUser(google, user, plan, stats);
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
  ].filter(Boolean).map((part) => `, ${part}`).join('');
  log(`Slot ${utc(plan.slot)}, window ${(plan.slot - plan.from) / 60000} min: ${plural(users.length, 'user')}, `
    + `${plural(stats.due, 'reminder')} due, ${stats.skipped} skipped (already done), `
    + `${plural(stats.devices, 'device')}${extra}.`);
  if (unread && unread === users.length) {
    logFailures();
    log('No user could be read: the slot is not claimed, so the next run retries it. Nothing was sent.');
    return result;
  }

  // 3. Claim, before the first push
  if (force) {
    log('Forced run: the bookmark was not read and is not changed.');
  } else {
    try {
      await google.setDoc(BOOKMARK, { lastSlot: plan.slot, updatedAt: now },
        bookmark ? { ifUpdateTime: bookmark.updateTime } : { ifMissing: true });
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw stop('claiming the slot', err);
      log('Another run claimed this slot: nothing sent.');
      return { ...result, failed: 0 };
    }
  }
  result.slot = plan.slot;
  result.skipped = stats.skipped;

  // 4. Send
  for (const { messages, devices } of jobs) {
    const gone = new Set();
    for (const data of messages) {
      for (const fid of devices) {
        if (gone.has(fid)) continue;
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
  return result;
}

/** The command: returns the exit code. */
async function main(env = process.env, print = console.log) {
  let google;
  try {
    google = createGoogle({
      serviceAccount: readServiceAccount(env), projectId: env.GCLOUD_PROJECT,
      firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST, fcmBaseUrl: env.FCM_BASE_URL,
    });
  } catch (err) {
    print(`Reminder job cannot start: ${describe(err)}.`);
    return 1;
  }
  let result;
  try {
    result = await run({ google, now: Date.now(), log: print, force: env.REMINDERS_FORCE === '1' });
  } catch (err) {
    print(`Reminder run failed: ${describe(err)}.`);
    return 1;
  }
  print(`Done: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed, `
    + `${plural(result.removed, 'device')} removed.`);
  return result.failed ? 1 : 0;
}

function executedDirectly() {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
}

if (executedDirectly()) process.exitCode = await main();
