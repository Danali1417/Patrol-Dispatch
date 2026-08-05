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

   create policy "Allow anon read" on kv_store for select using (true);
   create policy "Allow anon write" on kv_store for insert with check (true);
   create policy "Allow anon update" on kv_store for update using (true);
   create policy "Allow anon delete" on kv_store for delete using (true);
   ```

3. Go to **Settings → API**. Note down:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **Publishable key** (starts `sb_publishable_...`) — NOT the secret key.

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
   | `VITE_SUPABASE_ANON_KEY` | your Publishable key from step 1 |

5. Click **Deploy**. Wait ~1 minute.

You'll get a live URL like `sentryline-dashboard.vercel.app`. Share that
with control room and every patrolman — everyone sees the same live data.

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

## Security note

This uses an open "anon" API key with permissive read/write access to
keep setup simple — anyone with the live URL's page source could
technically read or write the data directly via the API, including
stored passwords (which are also stored in plain text, not hashed).
That's fine for internal testing with a small trusted team, but before
this handles real client data it needs proper authentication tied to
Supabase's row-level security, and password hashing. Worth doing before
wider rollout.
