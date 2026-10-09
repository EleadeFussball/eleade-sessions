# Eleade Sessions

A phone-first web app for Eleade's coaches to log sessions once. Player credits,
session documentation, coach pay and the Monday checks all come from that one entry.

## What's in here

| Folder | What it is |
|---|---|
| `web/` | The app (Next.js). This is what Vercel hosts. |
| `supabase/migrations/0001_init.sql` | The database: tables, business rules and access rules. |
| `supabase/seed/part1.sql` to `part5.sql` | Your players, coaches, starting balances and 2026 documentation history. |
| `supabase/tests/` | Automated checks of the rules (35 tests). |
| `scripts/build_seed.py` | Rebuilds the seed files, including from your confirmed balances workbook. |

## Rules the app enforces

- Attended, cancelled late and no show each use one credit and are paid to the coach. Cancelled in time is free and unpaid.
- 2:1 and 4:1: one entry, one credit from each player, the coach paid the group rate once.
- Game analysis uses an analysis credit. Testing uses nothing.
- Siblings with the same family name share one credit pool.
- Pay-per-session players have no credits. Each session is added to what the family owes for that week, and Jan marks it paid.
- Coaches see all players and their credits, and can log a session for any player under their own name.
- Coaches see only their own pay rate and pay. Only Jan can add credits, change players, set rates and see payments.
- Every credit change needs a reason, and nothing in the credit history can be edited or deleted.
- Coaches can edit or delete their own entries for 7 days.
- History imported from the old files never touches credits or pay.

## Going live (about 30 minutes, once)

### 1. Database (Supabase)
1. In your `eleade` project, open **SQL Editor**, click **New query**, paste the whole of `supabase/migrations/0001_init.sql` and click **Run**.
2. Do the same with `supabase/seed/part1.sql`, then `part2.sql`, `part3.sql`, `part4.sql` and `part5.sql`, in that order.
3. Go to **Project Settings > API** and copy the **Project URL** and the **anon public** key. You need both in step 3.

### 2. Code (GitHub)
1. Create a new **private** repository called `eleade-sessions`.
2. Upload the contents of this folder (drag and drop works). Leave out `node_modules` and `.env.local` if they're present.

### 3. Hosting (Vercel)
1. Click **Add New > Project**, then import `eleade-sessions`.
2. Set **Root Directory** to `web`.
3. Under **Environment Variables**, add:
   - `NEXT_PUBLIC_SUPABASE_URL` = the Project URL from step 1
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the anon public key from step 1
4. Click **Deploy**. Vercel gives you an address like `eleade-sessions.vercel.app`.

### 4. Sign-in links
1. In Supabase, open **Authentication > URL Configuration**.
2. Set **Site URL** to your Vercel address, and add the same address under **Redirect URLs**.

### 5. First sign-in
1. Open the Vercel address on your phone. Sign in with `info@eleadefussball.com`. You'll get an email with a link, and you're the admin.
2. Go to **Team**. Enter each coach's email and 1:1 rate, then save.
3. Send the coaches the address. Each coach signs in with the email you entered.
4. On your phone, use **Add to Home Screen** so the app opens like a normal app.

## After Jan confirms the starting balances

```
python3 scripts/build_seed.py --confirmed Eleade_Opening_Balances_Check.xlsx
```

This regenerates `part1.sql` with the confirmed figures. Run it **before** going live. Once coaches are logging sessions, correct balances on each player page instead (Admin > Add or correct credits).

## Running the tests

The tests need a local Postgres 16 running on port 5433 (socket in `/var/tmp`):

```
supabase/tests/run.sh
```

## Phase 2, not built yet

Parent portal, Stripe purchases, automatic renewal emails, package expiry reminders, voice notes that transcribe automatically, and the trend dashboard. See the Eleade Platform build summary.

## Good to know

- Supabase's built-in email sender only sends a few sign-in emails per hour. That's fine for a handful of coaches, because each person stays signed in. If someone doesn't get their email, wait an hour, or connect your Google Workspace email under **Authentication > Emails > SMTP Settings**.
- `devserver/` runs the whole app locally against a local database for testing. It isn't needed to go live.

## Backup

Nightly (02:30 Sydney) GitHub Actions job `.github/workflows/nightly-backup.yml` runs `scripts/backup/run.mjs`: it reads all tables with the Supabase service key, builds an Excel workbook (`web/lib/backup-workbook.mjs`, shared with the Admin "Download everything" button) and sends it to a Google Apps Script web app (`scripts/backup/drive-receiver.gs`, runs as the Drive owner, no service account key needed) that overwrites one file in Google Drive (Drive keeps earlier versions).
Secrets needed in the GitHub repo: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `APPS_SCRIPT_URL` (the web app URL), `BACKUP_SECRET` (same value as in the script properties).
