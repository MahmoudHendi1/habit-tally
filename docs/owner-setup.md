# Habit Tally: owner setup guide

These are the few things only you, the owner, can do. Everything else is done by the team.

- Steps 2 and 3 can be done today, in either order, from a desktop browser. Allow about 15 minutes.
- Step 1 comes when the lead tells you sign-in is switched on (until then the site only runs the demo).
- Steps 4 and 5 come last, when the lead tells you the app is live. Allow about 15 minutes, with your Android
  phone to hand.
- Step 6 is for later: what to check if reminders ever stop.

Use the Google account you connected Firebase with, and the GitHub account that owns the repository
`MahmoudHendi1/habit-tally`.

**One rule above all: the key file from step 2 is a password. It goes into GitHub and nowhere else. Never send
it to anyone: not to the lead, not by email, and not in this chat either.** Nobody on the team needs it and
nobody will ask you for it.

What to send the lead, and nothing more:

| From step | What | Secret? |
|---|---|---|
| 1 | Your account id | No |
| 2 | Only the words "the secret is saved" | The key itself is secret: never send it |
| 3 | The Web Push **public** key | No, it is public by design |

---

## Step 1. Create your account in the app

The app is invite-only: an account can use it only after the lead has added it to the invite list.

1. Open <https://habit-tally.web.app> in a desktop browser.
2. Choose the option to sign up (create an account), enter your email address and a password, and confirm.
3. You land on a screen that says you are **waiting for approval**. It shows your **account id**, a string of
   about 28 letters and digits.
4. Copy the account id and send it to the lead.

How to tell it worked: you see the "waiting for approval" screen with the account id on it. That screen is
the expected result for now; you are not locked out by mistake. The lead will tell you when your account is
approved.

The account id is not a secret. Your password is: do not send it to anyone.

---

## Step 2. Create the key for the reminder job and store it in GitHub

The reminder job runs on GitHub every half hour. It needs its own small account in your Google project, with
permission to do two things only: read the habit data and send notifications. You create that account, make a
key for it, and paste the key into GitHub.

### 2a. Create the service account

1. Open <https://console.cloud.google.com/iam-admin/serviceaccounts?project=habit-tally>.
   At the top of the page, the project selector must say **habit-tally**.
2. Click **Create service account** (near the top of the page).
3. In **Service account name**, type `reminder-job`. The field **Service account ID** below fills in by
   itself with `reminder-job`. Leave the description empty.
4. Click **Create and continue**.
5. You are now asked which roles (permissions) to give it. Click **Select a role**, type
   `Cloud Datastore User` in the filter box, and click the result with exactly that name.
6. Click **Add another role**, type `Firebase Cloud Messaging Admin`, and click the result with exactly that
   name.
7. Check that there are exactly two roles: **Cloud Datastore User** and **Firebase Cloud Messaging Admin**.
   Do not add Owner, Editor or anything else.
8. Click **Continue**, then **Done**. Skip the last, optional part of the form.

How to tell it worked: the list now has a row with the email
`reminder-job@habit-tally.iam.gserviceaccount.com`. To check the roles, open
<https://console.cloud.google.com/iam-admin/iam?project=habit-tally>: the row for `reminder-job` shows the
two roles above and no others.

### 2b. Create the JSON key

1. Back in the service account list
   (<https://console.cloud.google.com/iam-admin/serviceaccounts?project=habit-tally>), click the email
   `reminder-job@habit-tally.iam.gserviceaccount.com`.
2. Click the **Keys** tab.
3. Click **Add key**, then **Create new key**.
4. Choose **JSON** and click **Create**.

How to tell it worked: your browser downloads a file with a name like `habit-tally-1a2b3c4d5e6f.json`, and the
Keys tab shows one key with today's date.

If you see a message that creating service account keys is disabled or not allowed: stop here and tell the
lead exactly what the message says. Do not look for a way around it.

### 2c. Paste the key into GitHub

1. Open the downloaded file with a plain text editor (Notepad on Windows, TextEdit on a Mac). It starts with
   `{` and ends with `}`.
2. Select everything (Ctrl+A, or Cmd+A on a Mac) and copy it (Ctrl+C, or Cmd+C).
3. Open <https://github.com/MahmoudHendi1/habit-tally/settings/secrets/actions>.
   (By hand: the repository page, then **Settings**, then **Secrets and variables** in the left menu, then
   **Actions**.)
4. Click **New repository secret**.
5. In **Name**, type exactly `FIREBASE_SERVICE_ACCOUNT`.
6. Click in the **Secret** box and paste (Ctrl+V, or Cmd+V). The whole file must be in the box, from the
   first `{` to the last `}`.
7. Click **Add secret**.

How to tell it worked: under **Repository secrets** there is a row `FIREBASE_SERVICE_ACCOUNT` that says it was
updated just now. GitHub never shows the value again, to you or to anyone else. That is normal.

### 2d. Delete the downloaded file

1. Close the text editor without saving.
2. Delete the `.json` file from your Downloads folder, then empty the Recycle Bin (Windows) or the Trash (Mac).
3. Copy any other word or sentence, so that the key is no longer on your clipboard.

How to tell it worked: searching your computer for the file name finds nothing.

Then tell the lead "the secret is saved". Send nothing else from this step.

If the key ever ends up somewhere it should not be (an email, a chat, a shared folder): go back to the
**Keys** tab from 2b, click the bin icon next to the key to delete it, and then repeat 2b, 2c and 2d. In 2c
the secret already exists: click the pencil icon next to `FIREBASE_SERVICE_ACCOUNT` and paste the new key.
A deleted key stops working at once.

---

## Step 3. Create the Web Push key pair and send the public key

This key lets browsers check that notifications really come from Habit Tally.

1. Open <https://console.firebase.google.com/project/habit-tally/settings/cloudmessaging>.
   (By hand: the Firebase console, project **habit-tally**, the gear icon at the top left,
   **Project settings**, then the **Cloud Messaging** tab.)
2. Scroll down to **Web configuration**. It has a part named **Web Push certificates**.
3. Click **Generate key pair**.
4. A row appears with a long string in the column **Key pair**: 87 characters, starting with the letter `B`.
   Copy that string.
5. Send it to the lead.

How to tell it worked: the row with the long string stays there when you reload the page.

This string is the **public** key. It is safe to share, and it will be visible in the app's code. The
three-dot menu on that row has an entry to show the private key: you never need it, so do not open it and do
not send it.

Click **Generate key pair** once only. If a key pair is already listed, do not create another one: send the
one that is there.

---

## Step 4. Install the app on your phone and turn on reminders

Wait until the lead tells you the app is live and your account is approved.

1. On your Android phone, open **Chrome** and go to <https://habit-tally.web.app>.
2. Tap the three dots at the top right of Chrome, then **Add to Home screen**, then **Install**.
3. Open **Habit Tally** from its new icon on the home screen (not from Chrome).
4. Sign in with the email address and password from step 1.
5. Open **Settings** in the app and turn reminders on.
6. Android asks whether Habit Tally may send you notifications. Tap **Allow**.

How to tell it worked: the app has its own icon and opens without Chrome's address bar, and the Settings screen
shows reminders as on.

If Settings says notifications are blocked: on the phone, press and hold the Habit Tally icon, tap the
**(i)** (App info), then **Notifications**, and switch them on. Then go back to the app's Settings and turn
reminders on again.

---

## Step 5. Send yourself a test notification

A normal run sends each reminder once. A run with **force** ticked sends the reminders of the current half
hour again, without changing anything else, so it is the way to test on a real phone.

First, make sure there is something to send:

1. In the app, pick a habit you have **not** completed today (or add one).
2. Give it a reminder time equal to the half hour that has **just passed**. Example: if it is 14:10 now, set
   14:00. If it is 14:40, set 14:30.
3. Avoid the five minutes before a half hour (14:25 to 14:30, 14:55 to 15:00): wait until the half hour has
   passed, then use that one.

Then start the run:

1. Open <https://github.com/MahmoudHendi1/habit-tally/actions/workflows/reminders.yml>.
   (By hand: the repository page, the **Actions** tab, then **Send reminders** in the left list.)
2. Click **Run workflow** (a grey button on the right, above the list of runs).
3. Leave the branch on `main`, tick the box **force**, and click the green **Run workflow** button.
4. After a few seconds a new run appears at the top of the list. Wait until its yellow circle turns into a
   green tick, usually in less than a minute.

How to tell it worked: your phone shows a notification with the name of the habit within about a minute. To
see what the job did, click the run, then **Send reminders**, then open the step **Send reminders**: the last
line reads `Done: 1 sent, ...`.

If it did not work:

- **Green tick but no notification, and the line says `0 sent`**: the job found nothing due. Check the reminder
  time against the rule above, check that the habit is not already complete, and run it again.
- **Green tick, `1 sent`, but nothing on the phone**: see "On the phone" in step 6.
- **Red cross**: tell the lead and send the link to the run. The run's log is public and contains no secrets,
  so the link is safe to share. Do not send the key.

When the test has passed, set the habit's reminder back to the time you really want.

---

## Step 6. If reminders stop

What is normal: reminders are sent on the half hour and can arrive several minutes late, because GitHub
often starts scheduled jobs late. Now and then GitHub skips a run; the next run then also sends what the
skipped one missed, up to one half hour back.

If reminders stay away for more than an hour, check these in order.

### 6a. Is the job still running?

Open <https://github.com/MahmoudHendi1/habit-tally/actions/workflows/reminders.yml>.

- **Green ticks about every half hour**: the job is fine. Go to 6c.
- **A notice at the top that the workflow is disabled, with a button "Enable workflow"**: go to 6b.
- **Red crosses**: the job runs but fails. GitHub also emails you about this. Tell the lead and send the
  link to one red run. A common cause is the key: it was deleted in the Google console, or the secret was
  not pasted completely. The fix is to repeat step 2b, 2c and 2d with a new key.
- **No runs at all in the last hours and no notice**: GitHub may be having a problem. Check
  <https://www.githubstatus.com> and look again later.

### 6b. The Enable button and the 60-day rule

GitHub switches off scheduled jobs in a public repository after 60 days in which nothing has changed in
the repository. It does not ask first, and the app shows no error: reminders simply stop.

The job protects itself against this: once a week it asks GitHub to keep it switched on. If that ever
fails and the job is switched off anyway:

1. On the page from 6a, click **Enable workflow**.
2. Click **Run workflow**, leave **force** unticked, and click the green **Run workflow** button.

How to tell it worked: the notice is gone, the new run ends with a green tick, and new runs appear by
themselves within the hour. Then tell the lead, so the team can find out why the weekly protection failed.

### 6c. On the phone

1. **Notification permission.** Press and hold the Habit Tally icon, tap **(i)** (App info), then
   **Notifications**: they must be on. Also open Chrome, tap the three dots, **Settings**, **Site settings**,
   **Notifications**: `habit-tally.web.app` must be listed under allowed, not under blocked.
2. **Battery settings.** Android can stop apps it thinks you do not use. Open the phone's **Settings**,
   **Apps**, **Chrome**, **Battery** (on some phones **App battery usage**), and choose **Unrestricted**.
   Do the same for **Habit Tally** if it is in the list. On Samsung phones, also make sure neither app is
   under **Sleeping apps** or **Deep sleeping apps** (Settings, Battery, Background usage limits).
3. **Do Not Disturb.** Swipe down from the top of the screen and check that Do Not Disturb, Bedtime mode
   and Battery saver are off.
4. **Reminders in the app.** Open Habit Tally, go to **Settings**, turn reminders off and then on again.
   This registers the phone again. Do this also after you have signed out and in, reinstalled the app, or
   cleared Chrome's data.
5. **The habit itself.** A reminder is sent only for a habit that has a reminder time and is not yet
   complete for the day (or, for a weekly habit, for the week).

Then repeat the test from step 5. If it still fails, tell the lead what you saw in 6a and what the last
line of the test run says.
