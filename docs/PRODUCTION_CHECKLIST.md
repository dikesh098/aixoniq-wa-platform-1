# Production checklist

## Meta / WhatsApp
- [ ] Business verification complete; display name approved; number registered
- [ ] System-user token (never a temporary token) stored only in Supabase secrets
- [ ] Webhook verified and subscribed to `messages`; test that a STOP reply creates an unsubscribe
- [ ] At least one APPROVED marketing template synced
- [ ] Daily cap in Settings at or below your real messaging tier
- [ ] Graph API version in Settings still supported by Meta

## Compliance
- [ ] Every contact has a lawful, documented opt-in (the consent source field is your audit trail)
- [ ] Opt-out instruction included in marketing templates
- [ ] Privacy policy and data-retention policy published (India: DPDP Act obligations)
- [ ] Only import contacts you are permitted to message; never buy lists

## Security
- [ ] Public sign-ups disabled in Supabase Auth; strong passwords / MFA for staff
- [ ] `service_role` key exists only in Supabase (never in `.env`, git, or hosting variables)
- [ ] `ALLOWED_ORIGIN` set to the dashboard URL
- [ ] Row Level Security enabled on all tables (migration 002); verify in Dashboard > Auth > Policies

## Operations
- [ ] Backups: free Supabase has none. Export regularly (`npx supabase db dump`) or upgrade
- [ ] Project not paused (free tier); consider a weekly login
- [ ] Review the "Needs review" and "Failed" counts after each campaign
- [ ] Rotate the Meta token and WORKER_SECRET periodically
