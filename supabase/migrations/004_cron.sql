-- Scheduler: runs the queue worker and housekeeping every minute.
-- Requires pg_cron and pg_net (enable in Dashboard > Database > Extensions if this fails).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Before the worker job can succeed, store two Vault secrets (see README step 5):
--   project_url   e.g. https://abcd1234.supabase.co
--   worker_secret same value as the WORKER_SECRET Edge Function secret

select cron.schedule('campaign-housekeeping', '* * * * *', $$ select public.campaign_housekeeping(); $$);

select cron.schedule('queue-worker', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/queue-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);

-- Keep the free-tier database small: cron history is not needed for long.
select cron.schedule('cron-history-cleanup', '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '3 days'; $$);
