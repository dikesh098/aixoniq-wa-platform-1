# Aixoniq WhatsApp Marketing Platform

React + TypeScript + Vite dashboard, Supabase (Postgres, Auth, RLS, Edge Functions, pg_cron) and the official Meta WhatsApp Cloud API.

## Quick deploy (recommended)

Prepare three things: a Supabase project (ref, anon key, database password), an admin user created in Supabase Authentication > Users, and a free Vercel account. Then, in PowerShell from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

The script installs dependencies, builds, deploys the dashboard to Vercel with the correct environment variables, applies all migrations, creates your admin role, stores the cron secrets in Vault, sets the server secrets and deploys all four Edge Functions. It is safe to re-run. The manual steps below explain each part.

## How it works

```
Browser (anon key only) ──RLS──► Postgres ◄── pg_cron every minute ──► Edge Function queue-worker ──► Meta Cloud API
                                    ▲                                                                     │
                                    └────── Edge Function whatsapp-webhook (signature verified) ◄─────────┘
```

* The frontend never holds the Meta token or the service-role key. Secrets live in Edge Function secrets.
* **Queue:** launching a campaign inserts one `messages` row per eligible contact (`UNIQUE (campaign_id, contact_id)` makes duplicates impossible). Each minute the worker claims up to `max_per_minute` rows with `FOR UPDATE SKIP LOCKED`, within your rolling 24-hour cap. Nothing is ever sent "all at once".
* **Compliance gates:** only contacts with `consent_status = granted`, `status = active` and not in `suppressions` are queued, and this is re-checked at send time. Only templates with status `approved` can be used. Replies like STOP add the sender to the suppression list automatically.
* **Retries:** Meta rate-limit and temporary errors retry with backoff (2, 10, 30, 120 min, max 5 attempts). Permanent errors (invalid number, template problems) fail immediately. If there is **no response** from Meta (timeout/crash), the outcome is unknown, so the message is set to **Needs review** and is never auto-resent. Meta's send API has no idempotency key, so this is the only way to guarantee no duplicates. You can requeue manually.
* **Test mode:** on by default. The worker simulates sends, writes rows flagged `simulated`, and never calls Meta.

## Prerequisites (Windows)

* Node.js 20 or newer (https://nodejs.org), Git optional
* A Supabase account, a Meta developer account and a Meta Business account

Check:

```powershell
node --version
npm --version
```

## 1. Install and run the dashboard

```powershell
cd C:\path\to\aixoniq-wa-platform
npm install
Copy-Item .env.example .env
notepad .env        # fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (step 2)
npm run dev
```

Open http://localhost:5173. Run `npm run typecheck` and `npm run build` before deploying.

## 2. Create the Supabase project

1. https://supabase.com/dashboard → New project (note the database password and **project ref**, the `abcd1234` part of `https://abcd1234.supabase.co`).
2. Project Settings → API: copy the **Project URL** and the **anon public** key into `.env`. Never copy the `service_role` key anywhere in this project.
3. Authentication → Sign In / Providers → turn **off** "Allow new users to sign up". Access is by invitation only.
4. Database → Extensions: enable `pg_cron` and `pg_net`.

## 3. Apply the database migrations

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

This applies `001` schema, `002` RLS, `003` queue/business functions and `004` cron jobs.

## 4. Create your login

1. Authentication → Users → **Add user** (email + password, tick auto-confirm).
2. Dashboard SQL Editor, run (replace the email):

```sql
insert into public.staff (user_id, full_name, role)
select id, 'Owner', 'admin' from auth.users where email = 'you@aixoniq.example';
```

Roles: `admin` (everything), `editor` (contacts, campaigns), `viewer` (read-only). Add teammates the same way.

## 5. Server secrets and functions

Generate random values (works on Windows PowerShell 5.1 and 7):

```powershell
function New-Secret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join '' }
New-Secret   # run twice: one for WEBHOOK_VERIFY_TOKEN, one for WORKER_SECRET
```

```powershell
Copy-Item supabase\functions\.env.example supabase\functions\.env
notepad supabase\functions\.env     # fill values; leave META_* empty until step 6
npx supabase secrets set --env-file supabase/functions/.env
npx supabase functions deploy queue-worker --no-verify-jwt
npx supabase functions deploy whatsapp-webhook --no-verify-jwt
npx supabase functions deploy sync-templates
npx supabase functions deploy send-test-message
```

Then store two Vault secrets so the cron job can call the worker (SQL Editor; use the same `WORKER_SECRET` value):

```sql
select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co', 'project_url');
select vault.create_secret('YOUR_WORKER_SECRET', 'worker_secret');
```

`ALLOWED_ORIGIN` should be your dashboard's URL (use `http://localhost:5173` while developing) so only your site can call the user-facing functions.

## 6. Configure Meta WhatsApp Cloud API (needed only for live sending)

1. https://developers.facebook.com → Create App → type **Business**. Add the **WhatsApp** product.
2. Complete **Business verification** in Meta Business Settings (required to raise messaging limits).
3. WhatsApp → API Setup: add and verify your business phone number. Copy the **Phone number ID** and **WhatsApp Business Account ID**.
4. Business Settings → Users → **System users** → add a system user (Admin) → assign your app and WABA with full control → **Generate token** with `whatsapp_business_messaging` and `whatsapp_business_management`, no expiry. This is `META_ACCESS_TOKEN`.
5. App Settings → Basic → copy **App Secret** → `META_APP_SECRET`.
6. WhatsApp → Configuration → Webhook: Callback URL `https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`, Verify token = your `WEBHOOK_VERIFY_TOKEN`. Verify, then subscribe to the **messages** field.
7. WhatsApp Manager → Message templates: create **Marketing** templates and wait for approval. Marketing templates should include an opt-out hint such as "Reply STOP to unsubscribe".
8. Put the token and secret into `supabase\functions\.env`, rerun `npx supabase secrets set --env-file supabase/functions/.env`.
9. Dashboard → Settings: enter WABA ID, Phone number ID, check the Graph API version, set the daily cap to your **current Meta tier** and save. The Server configuration panel shows which secrets are present.
10. Templates → **Sync from Meta**.

Messaging limits: Meta caps the unique contacts you may message per 24 hours (new accounts often start at a few hundred, rising with quality and volume). A 15,000-contact list will take several days until your tier is high enough. The queue enforces your configured cap; Meta's actual limit still applies.

## 7. Try it safely first (test mode)

1. Leave **Test mode** on (default).
2. Templates → add a sample template, e.g. name `welcome_offer`, body `Hi {{1}}, our offer is live!`.
3. Import contacts from a small CSV (`phone,name,email,tags`) and tick the consent box.
4. Campaigns → New campaign → Launch. Within a minute the status moves through the queue; rows are marked **simulated**.
5. Only after Meta setup is complete, send one real message to your own number (Settings → Send one test message), then turn test mode off.

## 8. Deploy the dashboard (free)

Cloudflare Pages or Vercel: build command `npm run build`, output `dist`, environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Add a rewrite of all paths to `/index.html` for client-side routing (Pages and Vercel both support this). Set `ALLOWED_ORIGIN` to the final URL and re-run `secrets set`.

## Cost

Supabase Free + Cloudflare Pages/Vercel Hobby is about ₹0/month, excluding Meta's per-message fees. Limits to know: free Supabase projects pause after about a week of inactivity, have no automatic backups, and have small DB/function quotas. Supabase Pro (backups, no pausing) costs well above ₹500/month at current prices. Check current pricing. At 15,000 contacts and several campaigns the free database is comfortable; keep `webhook_events` and cron history trimmed (done automatically).

## What still needs your action before going live

See `docs/PRODUCTION_CHECKLIST.md`. Highlights: Meta business verification, approved templates, a lawful consent record for every imported contact, a privacy policy, your own backups, and monitoring.

## Known limitations

* Templates with media headers, header or button variables, or named parameters are marked unsupported (body variables only).
* Daily cap counts messages, while Meta counts unique recipients; set the cap conservatively.
* Delivery webhooks need a public HTTPS URL; Supabase provides it.
* The code was written without running `npm install` in the build environment, so run `npm run typecheck` first and fix any version-specific type errors that appear. Verify the Graph API version and Meta error codes against current Meta docs.
