# Sentryline — Alarm Response Dispatch

A control room / manager / patrolman dispatch board. Data is stored in a
Supabase (Postgres) table so every device sees the same live data.

Nothing below needs the command line — everything is done through web
pages (Supabase, GitHub, Vercel).

## 1. Set up the database (Supabase)

You've likely already done this — skip to step 2 if so. If your table
already exists but predates the `search` column above, run this once
instead (safe, additive, doesn't touch any existing data):

```sql
alter table kv_store add column if not exists search jsonb;
create index if not exists kv_store_search_idx on kv_store using gin (search);
```

1. At [supabase.com](https://supabase.com), create a new project (any name,
   region closest to your team, e.g. `Asia-Pacific (Southeast)`).
2. Open **SQL Editor** in the left sidebar → paste this → **Run**:

   ```sql
   create table if not exists kv_store (
     key text primary key,
     value text not null,
     search jsonb,
     updated_at timestamptz default now()
   );

   create index if not exists kv_store_search_idx on kv_store using gin (search);

   alter table kv_store enable row level security;
   ```

   `search` holds a small, indexed snapshot of a few fields (job number,
   site name, date) for archived jobs only — everything else in this
   table leaves it empty. It's what lets Control Room find and open an
   old job by number, and lets Reports pull in a chosen date range,
   without ever having to fetch the entire job archive at once (see
   section 11).

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

## 4. Daily email report (optional) — and the job board's daily cleanup

Every morning, a scheduled job can email a Brief and Detailed report PDF
(covering the previous 06:00–06:00 shift day) to whoever you choose,
sent from a Gmail account.

This same daily job also does something unrelated to email: it sweeps
jobs closed 48+ hours ago off the live board (see section 9). That
sweep runs every time this endpoint fires, whether or not you set up
email at all — but it still needs `CRON_SECRET` below configured, since
that's what lets Vercel's daily trigger call this endpoint in the first
place. **If you skip this section entirely, set `CRON_SECRET` anyway**
so the board keeps itself tidy — the email variables (`GMAIL_USER`
etc.) can stay unset.

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

**Mid-job reassignment:** if Control Room changes the attending
patrolman on a job that's already dispatched, the *previous* patrolman
gets their own push (with its own Acknowledge button) telling them the
job's been given to someone else — and an in-app "reassignment notice"
banner as a fallback if they don't have push turned on. Either way,
their acknowledgement is timestamped and shown to Control Room on the
job, and recorded in the job's activity log alongside the reassignment
itself. Uses the same VAPID config above — nothing extra to set up.

## 7. Location names on photos, onsite/offsite, and the activity log

No setup needed — these work out of the box.

- **Attendance photos** are watermarked with a resolved street address
  (not just raw GPS coordinates) using OpenStreetMap's free Nominatim
  reverse-geocoding service via `api/reverse-geocode.js`. If the lookup
  fails or times out (e.g. no signal), it falls back to plain
  coordinates so photo capture never gets blocked.
- **Onsite / offsite locations** are captured the moment a patrolman
  marks onsite or submits an outcome, shown in Control Room as a
  clickable Google Maps pin with the resolved address, and included on
  the attendance PDF.
- **Activity log**: every Control Room action on a job — dispatch,
  reassign, cancel, delay reason, edited/saved results, marked
  reviewed, client email sent — is timestamped with who did it, visible
  via "Show activity log" on the job detail screen.

## 8. Live Location for Control Room (optional, no setup needed)

Control Room has a "Live Location" tab showing every patrolman who's on
today's roster on a live map (free OpenStreetMap tiles via
[Leaflet](https://leafletjs.com/), no API key), with a name label and an
online/offline status list alongside it — so Control Room can see who's
actually signed in and judge who's closest to a given site.

How it works, and what is and isn't kept:
- A patrolman's browser only reports their position while they're
  **signed in and rostered for that day** — not outside their shift, and
  never for managers/operators.
- Each report **overwrites** the same record; there's no location
  history, just "where they are right now."
- The record is deleted the moment they sign out, and Control Room's
  view treats anyone who hasn't reported in the last 3 minutes as
  offline (covers a closed tab/app without a proper sign-out) — so a
  patrolman never lingers on the map after their shift ends.
- The current position does pass through the same database as the rest
  of the app's live data (there's no way to relay a live position
  between two browsers without a server in between) — but nothing about
  it is ever logged or archived; it's overwritten and deleted, not
  accumulated.

The map also drops a red pin for every site currently out on a job, so
Control Room can judge at a glance who's nearest to respond. A site's
coordinates are geocoded from its address the first time it's needed
(same free OpenStreetMap lookup used elsewhere) and cached on the site
record so it's never looked up twice.

**Stationary alerts.** If a patrolman stays within about 50 metres of
the same spot for 30 minutes or more (a welfare-check nudge, not a
punctuality check — 50m absorbs normal GPS drift so someone genuinely
standing still doesn't get flagged for wandering a few metres), their
marker turns red on the map, their sidebar entry shows "⚠️ Stationary
N min", and Control Room gets a push notification — repeated every 30
minutes for as long as they remain in the same spot. It clears itself
the moment they move on. Push notifications are opt-in per device (a
"Turn on stationary alerts" banner at the top of the Live Location tab,
same mechanism as the job-dispatch alerts in section 6) but the red
marker and sidebar badge work for everyone viewing the map regardless.
Like the rest of Live Location, nothing here is stored as history —
it's just the current position plus "since when," overwritten in
place.

## 9. Attendance photos are stored apart from the job board

Every signed-in device (Control Room, each patrolman) polls the job
board every 8 seconds so everyone sees new dispatches and status
changes promptly. Attendance photos used to be embedded right in
each job's record, which meant that poll was re-downloading every
photo of every job, on every device, all day — expensive on mobile
data and battery, and it meant the whole board risked hitting a
platform size limit (Vercel caps a single request/response at 4.5MB)
once enough jobs with photos had piled up.

Photos now live in their own record per job, fetched only when that
job's own detail view, PDF, or client email actually needs them — never
as part of the board poll. A job's record on the board just carries a
small photo count. Jobs saved before this change are migrated
automatically and transparently the first time the board is loaded
after deploying it — nothing to run by hand.

This keeps the board's poll small for photos specifically — see
section 10 for how the job records themselves are kept small too.

## 10. Old jobs are archived off the board automatically

Even without photos, a job's own record (site details, description,
activity log, results) adds up — at even moderate daily volume, the
board's poll would eventually risk that same 4.5MB platform ceiling
from section 9, just on a slower timescale (months, not days).

The same daily job described in section 4 sweeps jobs that have been
**closed out (emailed) or cancelled for 48+ hours** off the live board
and into their own archived record — plenty of buffer for Control Room
to amend a result or re-send a client email before it moves. This
means:
- The **"Closed jobs"** and **"Cancelled jobs"** tabs only *list* what's
  still on the live board — recent history, not everything ever. Jobs
  still being worked (dispatched, submitted, reviewed) are never
  archived regardless of age.
- The job's own details aren't lost: **searching by job number or
  site** on any board still finds an archived job and opens it —
  shown read-only with an "Archived" label, since edits there have
  nowhere live to save back to. Its attendance photos are a separate
  story — see section 12.
- The Manager's **"Reset test data"** button clears archived jobs too,
  not just what's currently on the board.

This needs `CRON_SECRET` configured (section 4) — without it, Vercel's
daily trigger can't reach the endpoint that runs the sweep, and the
board will grow unchecked. The email report itself is still optional.

## 11. How archived jobs are searched and reported on

**Logs & analysis** covers the live board plus the **last 30 days** of
archived history automatically — that's a fixed, small window, not
"everything ever," and the page says so.

**Reports** covers just the live board until you set a "Date from" —
once you do, it pulls in matching archived jobs for that range too (to
today, or to a "Date to" you also set). No date filter at all means no
archive lookup, by design.

**Board's search box** reaches into the whole archive regardless of
age — that one's a real, indexed lookup by job number or site name
(via the `search` column from section 1), not a date-bounded window,
so it always finds a specific old job however far back it is.

None of these ever ask the database for "the whole archive" in one go
— every one of them is scoped, by date range or by search term, no
matter how many years of jobs pile up. That's the difference between
this and the original problem in section 9/10: it's not just that
old jobs move out of the way, it's that nothing ever has to read all
of them back at once again either.

## 12. Attendance photos are backed up by email, then deleted

Photos are by far the largest thing this app stores — a job's text
(result, activity log, times) stays tiny forever, but photos add up
fast, and it's what actually risks the database's storage/transfer
limits over months and years, not the text.

So right before a job is archived (the same 48-hours-after-closed-or-
cancelled sweep from section 10), if it has attendance photos, this
app:

1. Emails them as attachments to `PHOTO_BACKUP_EMAIL` (or, if that's
   not set, whatever `REPORT_RECIPIENTS` is already configured to —
   see section 4), along with the job's result and outcome notes as
   the email body.
2. Deletes them from Supabase.

The archived job record itself is untouched — its text, result, and
activity log stay searchable forever (section 11). Only the photo
bytes are gone; opening an old archived job that had photos shows a
small note that they were emailed as a backup and removed, instead of
just silently looking like there never were any.

If sending that email fails for any reason (bad credentials, Gmail
hiccup, `GMAIL_USER`/`GMAIL_APP_PASSWORD`/recipient not configured
yet), the photos are simply left in place and it's retried
automatically on the next day's cron — a failed send can never lose
the only copy.

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
- Only one browser/device can be signed in on a given login at a time —
  signing in again (same login name, same role) immediately signs the
  previous one out, with a message explaining why. This also keeps the
  same person from accidentally leaving several tabs open all polling
  the board at once.
- Supabase's row-level security has no policies at all (see step 1) — the
  public "anon" key has zero access. Only the server-only service role
  key, which is never sent to the browser, can read or write data.
