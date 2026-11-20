// End-to-end check of sign-in, sync and reminders on the local Firebase emulators (work package L1).
// One real browser app (a production build with VITE_BACKEND=emulator, so the service worker and its
// offline shell are in it), the real firestore.rules and the real reminder job, working together.
//
// Run:  npm run test:e2e:emulator
//   = firebase emulators:exec --only firestore,auth --project demo-habit-tally "node e2e/emulator.mjs"
// The emulators start empty each time and stop by themselves, so the run is repeatable.
//
// Nothing leaves this machine: the project id is "demo-habit-tally", the browser can only resolve
// 127.0.0.1 and localhost, Google's token endpoint and FCM are local stand-ins
// (scripts/dev/google-standin.mjs), and the service-account key is made in memory and never written.
// On a failure a screenshot of each page is put in test-results/.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGoogleStandIn } from '../scripts/dev/google-standin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { chromium, expect } = createRequire(join(ROOT, 'package.json'))('@playwright/test');

const PROJECT = 'demo-habit-tally';
const FIRESTORE_HOST = '127.0.0.1:8080'; // fixed in src/firebase-config.js (emulatorConfig)
const FIRESTORE = `http://${FIRESTORE_HOST}`;
const DOCS = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const SLOT_MS = 30 * 60 * 1000, LOOKAHEAD_MS = 5 * 60 * 1000; // shared/logic.js: SLOT_MS, planRun's lookahead
const SYNC_MS = 5000; // a change must reach the other browser within this time
const BROKEN = process.env.L1_BREAK ?? ''; // the name of one expectation to break, to see the test fail

// ---------- small helpers ----------

/** The Firestore emulator's REST API with admin access (`Bearer owner`). 404 gives null. */
async function admin(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: body && JSON.stringify(body) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** A Firestore REST value as plain JSON (only the types this app stores). */
function plain(v) {
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(plain);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, plain(x)]));
  if ('nullValue' in v) return null;
  return v.stringValue ?? v.booleanValue;
}
const fieldsOf = (doc) => plain({ mapValue: doc });
/** @returns {Promise<{ id: string, data: any }[]>} */
const listDocs = async (path) => ((await admin('GET', `${DOCS}/${path}`))?.documents ?? [])
  .map((d) => ({ id: d.name.split('/').pop(), data: fieldsOf(d) }));
const getDoc = async (path) => {
  const doc = await admin('GET', `${DOCS}/${path}`);
  return doc && fieldsOf(doc);
};

const RULES = readFileSync(join(ROOT, 'firestore.rules'), 'utf8');
const INVITE_LINE = /^.*\/\/ @invite-list$/m;
/** Load a copy of firestore.rules with exactly these accounts on the invite list into the emulator. */
async function loadRulesInviting(uids) {
  const content = RULES.replace(INVITE_LINE, `    function invited() { return [${uids.map((u) => `'${u}'`).join(', ')}]; } // @invite-list`);
  assert.notEqual(content, RULES, 'firestore.rules has no "// @invite-list" line to replace');
  await admin('PUT', `${FIRESTORE}/emulator/v1/projects/${PROJECT}:securityRules`, { rules: { files: [{ name: 'firestore.rules', content }] } });
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
    probe.close(() => resolve(port));
  });
});

/** Run a command to its end -> { code, output }. */
function runToEnd(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

const VITE = join(ROOT, 'node_modules/vite/bin/vite.js');
/** Build the app for the emulators into a temporary folder and serve it. */
async function serveApp(outDir) {
  const build = await runToEnd(process.execPath, [VITE, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
    { env: { ...process.env, VITE_BACKEND: 'emulator' } });
  assert.equal(build.code, 0, `vite build failed:\n${build.output}`);
  const port = await freePort();
  const server = spawn(process.execPath, [VITE, 'preview', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let tries = 0; ; tries += 1) {
    if (server.exitCode !== null) throw new Error(`vite preview stopped with code ${server.exitCode}`);
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    if (tries > 100) throw new Error('vite preview did not start');
    await new Promise((done) => { setTimeout(done, 100); });
  }
  return { url, stop: () => server.kill() };
}

/** 'HH:MM' of a moment in a zone, as the reminder times are written. */
const clockTime = (ms, zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
/** The slot the job serves when it runs at `ms` (shared/logic.js planRun). */
const slotAt = (ms) => Math.floor((ms + LOOKAHEAD_MS) / SLOT_MS) * SLOT_MS;
/** A zone whose local time is well away from midnight, so "today" cannot change during the run. One of the
 *  two always is; both are away from UTC, one by a half hour, so a job that ignored the zone would not pass. */
const pickZone = (ms) => ['Asia/Kolkata', 'America/Los_Angeles'].find((zone) => {
  const hour = Number(clockTime(ms, zone).slice(0, 2));
  return hour >= 3 && hour <= 20;
}) ?? 'Asia/Kolkata';

// ---------- the browser side ----------

/** @type {{ label: string, page: import('@playwright/test').Page, errors: string[], offline: boolean }[]} */
const watched = [];
/** What a browser prints while its network is switched off on purpose (step 5): not an app error. */
const OFFLINE_NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|Could not reach Cloud Firestore backend|WebChannelConnection RPC .* transport errored|Failed to fetch/;
const outside = []; // requests to anything but this machine

async function openApp(browser, label, zone, url) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: zone, locale: 'en-GB' });
  const page = await context.newPage();
  const entry = { label, page, errors: [], offline: false };
  watched.push(entry);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (entry.offline && OFFLINE_NOISE.test(msg.text())) return;
    entry.errors.push(`console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => { entry.errors.push(`page error: ${err.message}`); });
  context.on('request', (request) => {
    const { hostname, protocol } = new URL(request.url());
    // The Firestore SDK's connection check fetches Google's 1-pixel image when the network drops; it sends no
    // data and also happens in production, so it is the one outside address allowed.
    const connectionCheck = hostname === 'www.google.com' && new URL(request.url()).pathname === '/images/cleardot.gif';
    if (/^https?:$/.test(protocol) && hostname !== '127.0.0.1' && hostname !== 'localhost' && !connectionCheck) outside.push(`${label}: ${request.url()}`);
  });
  await page.goto(url);
  return { context, page, entry };
}

function assertNoErrors() {
  for (const { label, errors } of watched) assert.deepEqual(errors, [], `browser ${label} reported errors`);
  assert.deepEqual(outside, [], `the app asked for something outside this machine: ${outside.slice(0, 3).join(' ; ')}`);
}

const card = (page, name) => page.locator('li.habit', { has: page.getByRole('button', { name: `Add one: ${name}`, exact: true }) });
const addOne = (page, name) => page.getByRole('button', { name: `Add one: ${name}`, exact: true });
const routineSection = (page, name) => page.locator('section.routine', { has: page.getByRole('button', { name: `${name}, edit routine`, exact: true }) });
/** The card of `name` shows this count. */
const expectCount = (page, name, count, timeout = SYNC_MS) => expect(card(page, name).locator('.habit-progress'))
  .toHaveText(new RegExp(`^${count} of 1 today`), { timeout });

async function fillSignIn(page, email, password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
}

async function addTimes(page, times) {
  for (const time of times) {
    await page.getByLabel('Add a time', { exact: true }).selectOption(time);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove ${time}`, exact: true })).toBeVisible();
  }
}

// ---------- the run ----------

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    assertNoErrors();
  } catch (err) {
    results.push(`FAIL  ${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    throw err;
  }
  results.push(`pass  ${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  console.log(results.at(-1));
}

async function main() {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, FIRESTORE_HOST,
    'Run this through "npm run test:e2e:emulator": the Firestore emulator must be on 127.0.0.1:8080');

  const started = Date.now();
  const zone = pickZone(started);
  // Reminder times: the slot the job serves now and the one after it, so the run may cross a half hour.
  const times = [clockTime(slotAt(started), zone), clockTime(slotAt(started) + SLOT_MS, zone)].sort();
  const email = `l1-${started}@example.com`, password = `pw-${started}`;
  console.log(`Zone ${zone}, reminder times ${times.join(' and ')}, account ${email}`);

  const outDir = mkdtempSync(join(tmpdir(), 'habit-tally-l1-'));
  const cleanup = [() => rmSync(outDir, { recursive: true, force: true })];
  let browser;
  try {
    const app = await serveApp(outDir);
    cleanup.push(app.stop);
    // The browser cannot resolve any name but localhost, so the app cannot reach a real service.
    browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--no-proxy-server'] });
    const one = await openApp(browser, 'one', zone, app.url);
    let two;
    let uid = '';

    await step('1 sign up: waiting screen with the account id', async () => {
      const { page } = one;
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Create account', exact: true })).toBeVisible();
      await fillSignIn(page, email, password);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(page.locator('#screen').getByText('Waiting for approval', { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('#screen').getByText(email, { exact: true })).toBeVisible();
      uid = (await page.locator('#waiting-uid').innerText()).trim();
      assert.match(uid, /^[A-Za-z0-9]{20,40}$/, 'the waiting screen shows an account id');
      assert.equal(await page.evaluate(() => /** @type {any} */ (window).habitTally.store.getState().user.uid), uid);
      assert.equal(await getDoc(`users/${uid}`), null, 'an account that is not invited has no record yet');
    });

    await step('2 invite the id, Check again: Today screen', async () => {
      const { page } = one;
      await page.getByRole('button', { name: 'Check again', exact: true }).click(); // not invited yet
      await expect(page.locator('#screen').getByText('Still waiting for approval.', { exact: true })).toBeVisible({ timeout: 5000 });
      await loadRulesInviting(BROKEN === 'invite' ? ['someone-else'] : [uid]);
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add a habit', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.locator('a[href="#/today"]')).toHaveAttribute('aria-current', 'page');
      // The record is written by the store once the account is allowed; give the write a moment to land.
      let user = null;
      for (let i = 0; i < 50 && !user; i++) { user = await getDoc(`users/${uid}`); if (!user) await new Promise((r) => setTimeout(r, 100)); }
      // Chromium may report an older alias of the same zone (Asia/Calcutta for Asia/Kolkata): compare the clocks.
      const clock = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(started);
      assert.ok(typeof user?.tz === 'string' && clock(user.tz) === clock(zone),
        `the account record has the browser's time zone (stored: ${JSON.stringify(user)})`);
    });

    await step('3 add habit Read, routine Morning with Brush teeth, tap Read once', async () => {
      const { page } = one;
      await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Read');
      await page.getByLabel('Target', { exact: true }).fill('1');
      await addTimes(page, times);
      await page.getByRole('button', { name: 'Save habit', exact: true }).click();
      await expect(addOne(page, 'Read')).toBeVisible();

      await page.getByRole('button', { name: 'Add a routine', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Morning');
      await addTimes(page, times);
      await page.getByRole('button', { name: 'Save routine', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save routine', exact: true })).toBeHidden();

      await page.getByRole('button', { name: 'Add a habit', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Brush teeth');
      await page.getByRole('group', { name: 'Routines', exact: true }).getByRole('checkbox', { name: 'Morning', exact: true }).check();
      await page.getByRole('button', { name: 'Save habit', exact: true }).click();
      await expect(routineSection(page, 'Morning').getByRole('button', { name: 'Add one: Brush teeth', exact: true })).toBeVisible();
      await expect(routineSection(page, 'Morning').getByRole('button', { name: 'Add one: Read', exact: true })).toHaveCount(0);

      await expectCount(page, 'Read', 0);
      await addOne(page, 'Read').click();
      await expectCount(page, 'Read', BROKEN === 'count' ? 2 : 1);
    });

    await step('4 a second browser signs in: same data within 5 s, and its tap reaches the first', async () => {
      two = await openApp(browser, 'two', zone, app.url);
      const { page } = two;
      await fillSignIn(page, email, password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expectCount(page, 'Read', 1);
      await expect(routineSection(page, 'Morning').getByRole('button', { name: 'Add one: Brush teeth', exact: true })).toBeVisible({ timeout: SYNC_MS });
      await expectCount(page, 'Brush teeth', 0);
      await addOne(page, 'Read').click();
      await expectCount(page, 'Read', 2);
      await expectCount(one.page, 'Read', 2);
    });

    await step('5 offline: reload shows the data, an offline tap arrives after going online', async () => {
      const { page, context, entry } = one;
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)); // the offline shell is stored
      entry.offline = true;
      await context.setOffline(true);
      await page.reload();
      await expectCount(page, 'Read', 2, 10000);
      await expect(routineSection(page, 'Morning').getByRole('button', { name: 'Add one: Brush teeth', exact: true })).toBeVisible();
      await addOne(page, 'Read').click();
      await expectCount(page, 'Read', 3);
      await expectCount(two.page, 'Read', 2); // not there yet
      await context.setOffline(false);
      const online = Date.now();
      await expectCount(two.page, 'Read', 3, 30000);
      console.log(`      the offline tap reached the second browser ${((Date.now() - online) / 1000).toFixed(1)} s after going online`);
      entry.offline = false;
    });

    await step('6 the reminder job: one push for the routine, none for Read, none after the slot is claimed', async () => {
      // What the app stored, read with admin access.
      const habits = await listDocs(`users/${uid}/habits`), routines = await listDocs(`users/${uid}/routines`);
      assert.deepEqual(habits.map((h) => h.data.name).sort(), ['Brush teeth', 'Read']);
      assert.equal(routines.length, 1);
      const [routine] = routines;
      const read = habits.find((h) => h.data.name === 'Read'), brush = habits.find((h) => h.data.name === 'Brush teeth');
      assert.deepEqual({ name: routine.data.name, times: routine.data.times, deletedAt: routine.data.deletedAt }, { name: 'Morning', times, deletedAt: null });
      assert.deepEqual(Object.keys(routine.data).sort(), ['deletedAt', 'name', 'order', 'times', 'updatedAt']);
      assert.deepEqual([read?.data.times, read?.data.routine, read?.data.target], [times, '', 1]);
      assert.deepEqual([brush?.data.times, brush?.data.routine], [[], routine.id]);
      for (const h of habits) assert.equal(Object.keys(h.data).length, 11, 'a habit document has eleven fields');

      // The device record, which push registration would have written.
      const fid = `l1-installation-${started}`;
      await admin('PATCH', `${DOCS}/devices/${fid}`, { fields: {
        uid: { stringValue: uid }, ua: { stringValue: 'L1 end-to-end test' }, updatedAt: { integerValue: String(Date.now()) },
      } });

      // Stand-ins for Google's token endpoint and FCM, and a throw-away key that exists only in memory.
      const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const google = await startGoogleStandIn({ publicKey });
      cleanup.push(google.close);
      const serviceAccount = {
        type: 'service_account', project_id: PROJECT, client_email: `l1-test@${PROJECT}.iam.gserviceaccount.com`,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: google.tokenUri,
      };
      const job = (force) => runToEnd(process.execPath, ['scripts/send-reminders.mjs'], { env: {
        PATH: process.env.PATH, FIREBASE_SERVICE_ACCOUNT: JSON.stringify(serviceAccount), FIRESTORE_EMULATOR_HOST: FIRESTORE_HOST,
        FCM_BASE_URL: google.fcmBaseUrl, GCLOUD_PROJECT: PROJECT, ...(force ? { REMINDERS_FORCE: '1' } : {}),
      } });

      // Do not start just before the half hour turns: the three runs must fall in one slot.
      const untilNext = SLOT_MS - ((Date.now() + LOOKAHEAD_MS) % SLOT_MS);
      if (untilNext < 20000) await new Promise((done) => { setTimeout(done, untilNext + 1000); });
      const slot = slotAt(Date.now());
      assert.ok(times.includes(clockTime(slot, zone)), 'the run took so long that the reminder times are no longer due');

      const expected = { message: {
        fid,
        data: { title: BROKEN === 'push' ? 'Evening' : 'Morning', body: '1 left: Brush teeth', tag: routine.id, url: '/' },
        webpush: { headers: { TTL: '1800', Urgency: 'high' } },
      } };
      const checkRun = (run, what) => {
        assert.equal(run.code, 0, `${what}: exit code 0. Output:\n${run.output}`);
        for (const secret of [uid, email, fid, routine.id, 'Morning', 'Brush teeth', 'Read', 'standin-', 'PRIVATE KEY']) {
          assert.ok(!run.output.includes(secret), `${what}: the job's output must not contain "${secret}". Output:\n${run.output}`);
        }
      };
      const checkPushes = (count, what) => {
        assert.equal(google.pushes.length, count, `${what}: ${count} push request(s) in all`);
        for (const push of google.pushes) {
          assert.equal(push.path, `/v1/projects/${PROJECT}/messages:send`);
          assert.equal(push.authorized, true, 'the push carries the token from the token endpoint');
          assert.deepEqual(push.body, expected, `${what}: the request body of contracts section 7`);
        }
      };

      // A forced run: sends, and leaves the bookmark alone (contracts section 9).
      const forced = await job(true);
      checkRun(forced, 'forced run');
      assert.match(forced.output, /Done: 1 sent, 1 skipped, 0 failed, 0 devices removed\./);
      checkPushes(1, 'forced run');
      assert.ok(google.pushes[0].body.message.data.body.startsWith('1 left'));
      assert.equal(await getDoc('system/reminders'), null, 'a forced run does not claim the slot');
      assert.equal(google.tokens.length, 1, 'one token request');
      assert.deepEqual([google.tokens[0].grantType, google.tokens[0].signed, google.tokens[0].claims?.iss, google.tokens[0].claims?.aud],
        ['urn:ietf:params:oauth:grant-type:jwt-bearer', true, serviceAccount.client_email, google.tokenUri]);

      // A normal run: the slot is still open, so it sends the same reminder and claims the slot.
      const normal = await job(false);
      checkRun(normal, 'normal run');
      assert.match(normal.output, /Done: 1 sent, 1 skipped, 0 failed, 0 devices removed\./);
      checkPushes(2, 'normal run');
      assert.equal((await getDoc('system/reminders'))?.lastSlot, slot, 'the normal run claimed the slot');

      // Once more: the slot is claimed, so nothing new is sent.
      const again = await job(false);
      checkRun(again, 'second normal run');
      assert.match(again.output, /Nothing to do/);
      checkPushes(2, 'second normal run');
      assert.equal((await getDoc('system/reminders'))?.lastSlot, slot);
      assert.ok(await getDoc(`devices/${fid}`), 'the device record is still there');
    });

    await step('7 sign out: the sign-in screen, and no habit text left in the page', async () => {
      const { page } = one;
      await page.locator('a[href="#/settings"]').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
      const html = await page.content();
      for (const text of ['Brush teeth', 'Morning', 'Add one', email]) assert.ok(!html.includes(text), `"${text}" is still in the page after sign-out`);
      assert.doesNotMatch(await page.locator('body').innerText(), /\bRead\b/);
      if (BROKEN === 'sign-out') assert.ok(html.includes('Brush teeth'), 'broken on purpose');
      // The other browser is a separate device: it stays signed in and keeps its data.
      await expectCount(two.page, 'Read', 3);
    });
  } catch (err) {
    mkdirSync(join(ROOT, 'test-results'), { recursive: true });
    for (const { label, page } of watched) {
      await page.screenshot({ path: join(ROOT, 'test-results', `emulator-${label}.png`), fullPage: true }).catch(() => {});
    }
    throw err;
  } finally {
    await browser?.close().catch(() => {});
    for (const undo of cleanup.reverse()) await Promise.resolve().then(undo).catch(() => {});
    console.log(`\n${results.join('\n')}\nTotal: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
}

main().then(() => { console.log('PASSED'); }, (err) => {
  console.error(`\nFAILED: ${err?.message ?? err}`);
  process.exitCode = 1;
});
