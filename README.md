# Sentryline — Alarm Response Dispatch

A control room / manager / patrolman dispatch board. Data is stored in a
Supabase (Postgres) table so every device sees the same live data.

Nothing below needs the command line — everything is done through web
pages (Supabase, GitHub, Vercel).

## 1. Set up the database (Supabase)

You've likely already done this — skip to step 2 if so.

1. At [supabase.com](https://supabase.com), create a new project (any name,
   region closest to your team, e.g. `Asia-Pacific (Southeast)`).
2. Open **SQL Editor** in the left sidebar → paste this → **Run**:

   ```sql
   create table if not exists kv_store (
     key text primary key,
     value text not null,
     updated_at timestamptz default now()
   );

   alter table kv_store enable row level security;
   ```

   Row-level security is turned on with **no policies at all** — deliberately.
   The app never talks to Supabase from the browser; every request goes
   through this project's own `/api/*` functions, which authenticate the
   user and then use Supabase's **service role** key, which bypasses RLS
   entirely. With zero policies, the public "anon" key (the one that used
   to be embedded in the client bundle) has no read or write access to
   anything — even if someone finds it.

3. Go to **Settings → API**. Note down:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **service_role secret key** (under "Project API keys" — click reveal;
     this is different from the Publishable/anon key and must never be put
     in front-end code or a `VITE_`-prefixed variable — it only ever goes
     into a server-only Vercel environment variable, step 4 below).

   If this project previously used the old open-access setup, run this once
   to remove the permissive policies it left behind:

   ```sql
   drop policy if exists "Allow anon read" on kv_store;
   drop policy if exists "Allow anon write" on kv_store;
   drop policy if exists "Allow anon update" on kv_store;
   drop policy if exists "Allow anon delete" on kv_store;
   ```

## 2. Put this project on GitHub

1. Go to [github.com](https://github.com) → sign in (or create a free account).
2. Click **New repository** (green button, or the "+" in the top right).
   Name it e.g. `sentryline-dashboard`. Leave it **empty** (don't add a
   README there — this folder already has one). Create it.
3. On the new repo's page, click **"uploading an existing file"** (or
   **Add file → Upload files**).
4. Drag this entire folder's contents into the browser window (all the
   files and the `src` folder together — GitHub keeps the folder structure).
5. Scroll down, click **Commit changes**.

That's it — no git commands needed.

## 3. Deploy it on Vercel

1. Go to [vercel.com](https://vercel.com) → sign up using your GitHub
   account (this makes step 2 automatic — one click).
2. Click **Add New... → Project**.
3. Find and **Import** the `sentryline-dashboard` repo you just created.
   Vercel will detect it's a Vite project automatically — leave the
   build settings as suggested.
4. Before clicking **Deploy**, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Project URL from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role secret key from step 1 — **server-only**, do not prefix with `VITE_` |
   | `SESSION_SECRET` | any long random string — signs login sessions, e.g. generate one at [random.org/strings](https://www.random.org/strings/) or by running `openssl rand -hex 32` |
   | `MIGRATE_SECRET` | any random string — protects the one-time password migration step below |

5. Click **Deploy**. Wait ~1 minute.

You'll get a live URL like `sentryline-dashboard.vercel.app`. Share that
with control room and every patrolman — everyone sees the same live data.

### One-time step: hash any existing passwords

If this is a brand-new deployment, skip this — the default accounts are
hashed automatically the first time anyone signs in. If you're upgrading
an older deployment that had plain-text passwords, visit this URL once
(with your real `MIGRATE_SECRET`) to hash them in place:

```
https://your-app.vercel.app/api/migrate-passwords?secret=YOUR_MIGRATE_SECRET
```

It's safe to run more than once — it only hashes accounts that still have
a plain-text password and leaves already-hashed ones untouched.

## 4. Daily email report (optional)

Every morning, a scheduled job can email a Brief and Detailed report PDF
(covering the previous 06:00–06:00 shift day) to whoever you choose,
sent from a Gmail account.

1. In the Gmail account you want to send from: turn on **2-Step
   Verification**, then create an **App Password** at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
2. In Vercel → your project → **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `GMAIL_USER` | the Gmail address to send from |
   | `GMAIL_APP_PASSWORD` | the 16-character App Password from step 1 |
   | `REPORT_RECIPIENTS` | recipient email address(es), comma-separated |
   | `CRON_SECRET` | any random string — protects the endpoint from being triggered by anyone who finds the URL |

3. Redeploy (Vercel → Deployments → ⋯ → Redeploy) so the new variables take effect.

That's it — Vercel Cron calls the report job once a day, timed to land
close to 07:00 Australia/Sydney (Vercel's free plan only allows daily
cron jobs, so it's a single fire rather than a poll — see
`REPORT_TIMEZONE` / `REPORT_SEND_HOUR` below to change the target time).

**To test it immediately** without waiting for 7am, visit (with your
real `CRON_SECRET`):

```
https://your-app.vercel.app/api/daily-report?test=1&secret=YOUR_CRON_SECRET
```

This sends a real email right away without affecting the next scheduled
send. It responds with JSON showing what happened (jobs found, recipients,
or any error) — useful for confirming Gmail delivery actually works before
relying on the schedule.

Optional environment variables:

| Name | Default | Purpose |
|---|---|---|
| `REPORT_TIMEZONE` | `Australia/Sydney` | IANA timezone the 06:00 shift-day boundary and send time are evaluated in |
| `REPORT_SEND_HOUR` | `7` | Local hour (0–23) the report goes out |
| `REPORT_SEND_TOLERANCE_MINUTES` | `90` | How far from that hour the single daily cron fire is still accepted — if you change `schedule` in `vercel.json`, keep this comfortably wider than the gap between your chosen UTC time and the target local hour |

## 5. Emailing a client outcome report directly (optional)

Once a job is reviewed, Control Room's "Prepare client email" screen can
either send the outcome straight to the client's inbox (from the same
Gmail account as the daily report) or just be marked as sent/closed if
it was handled another way (phone call, a personal email, etc.) — both
options are on the same screen.

This reuses `GMAIL_USER` / `GMAIL_APP_PASSWORD` from step 4 above. One
more variable is needed:

| Name | Value |
|---|---|
| `VITE_APP_MAIL_SECRET` | any random string |

Add it in Vercel → **Settings → Environment Variables**, then redeploy.
Sites can optionally store a **Monitoring email** (Manager → Sites &
runs, or when adding a site from the New Job screen) so it's pre-filled
every time a job at that site is emailed — otherwise just type it in on
the day.

## 6. Job-dispatch push notifications for patrolmen (optional)

A patrolman can turn on push notifications from their own "My jobs"
screen ("Turn on job alerts"). Once enabled, dispatching or reassigning
a job to them sends a notification straight to their phone's lock
screen — with an **Acknowledge** button on the notification itself, so
they can confirm receipt with one tap while driving, without unlocking
the phone or opening the app.

1. In Vercel → **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `VITE_VAPID_PUBLIC_KEY` | a VAPID public key — see below |
   | `VAPID_PRIVATE_KEY` | the matching VAPID private key — server-only, do not prefix with `VITE_` |
   | `VAPID_SUBJECT` | `mailto:` followed by a contact email address (required by the push standard, not shown to patrolmen) |

   Generate a key pair by running this once, anywhere Node is
   installed (it's a one-line local command, nothing gets sent
   anywhere):

   ```
   npx web-push generate-vapid-keys
   ```

2. Redeploy so the new variables take effect.

**iPhone note:** push notifications only work on iOS if the patrolman
first taps Share → **Add to Home Screen** in Safari and opens the app
from that home screen icon — a normal Safari tab can't receive push at
all on iOS. Android works from a normal browser tab, no install step
needed, though "Add to Home Screen" still gives a nicer full-screen
experience.

## Updating it later

Whenever you want to change something, edit the files in this project and
re-upload them to the same GitHub repo (drag the changed files onto the
repo page the same way, and commit). Vercel automatically redeploys the
live site within about a minute — no need to touch Vercel again.

## Default sign-ins (change these once you're live)

- Manager: `Manager1` / `manager123`
- Control Room: `ControlRoom1` / `ops123`
- Patrolmen: `T13`, `T15`, `T22`, ... / `patrol123`

Sign in as Manager → change every password from there before real use.

## Security

- The browser never talks to Supabase directly and never holds any
  database credentials — every read and write goes through this
  project's own `/api/*` functions, which check a signed session token
  first.
- Passwords are hashed (bcrypt) before they're ever stored — nobody,
  including a Manager, can look up an existing password. Manager can
  **reset** a login's password from Manage logins, which shows the new
  password once (to copy or text to that person) and then it's gone.
- Signing in issues a signed session token (kept in the browser's local
  storage) that expires after 24 hours or 30 minutes of inactivity,
  whichever comes first.
- Supabase's row-level security has no policies at all (see step 1) — the
  public "anon" key has zero access. Only the server-only service role
  key, which is never sent to the browser, can read or write data.
