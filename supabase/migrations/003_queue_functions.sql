-- Business logic in SQL: import, launch, queue claiming, status updates, stats.

-- ---------- Suppression triggers ----------
create or replace function public.on_suppression_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.contacts set status = 'unsubscribed', unsubscribed_at = now()
    where phone_e164 = new.phone_e164 and status <> 'unsubscribed';
  update public.messages set status = 'skipped', skip_reason = 'unsubscribed', updated_at = now()
    where phone_e164 = new.phone_e164 and status = 'queued';
  return new;
end $$;
create trigger trg_supp_insert after insert on public.suppressions
  for each row execute function public.on_suppression_insert();

-- Removing a suppression never restores consent: fresh consent must be recorded.
create or replace function public.on_suppression_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.contacts set status = 'active', consent_status = 'none', consent_at = null,
    consent_note = 'Removed from suppression list; fresh consent required'
    where phone_e164 = old.phone_e164;
  return old;
end $$;
create trigger trg_supp_delete after delete on public.suppressions
  for each row execute function public.on_suppression_delete();

-- ---------- CSV import (runs with caller's RLS) ----------
create or replace function public.import_contacts(
  p_rows jsonb, p_consent_source text, p_consent_confirmed boolean, p_batch_id uuid default null
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_inserted int; v_updated int; v_suppressed int;
begin
  if not public.can_edit() then raise exception 'forbidden'; end if;
  if p_consent_confirmed and coalesce(trim(p_consent_source), '') = '' then
    raise exception 'A consent source is required';
  end if;

  with src as (
    select distinct on (x.phone)
      x.phone,
      nullif(trim(x.name), '') as name,
      nullif(lower(trim(x.email)), '') as email,
      array(select distinct lower(trim(t)) from jsonb_array_elements_text(coalesce(x.tags, '[]'::jsonb)) t
            where trim(t) <> '') as tags
    from jsonb_to_recordset(p_rows) as x(phone text, name text, email text, tags jsonb)
    where x.phone ~ '^\+[1-9][0-9]{7,14}$'
    order by x.phone
  ), up as (
    insert into public.contacts as c
      (phone_e164, name, email, tags, status, consent_status, consent_at, consent_source, unsubscribed_at, import_batch_id)
    select s.phone, s.name, s.email, s.tags,
      case when z.phone_e164 is not null then 'unsubscribed' else 'active' end,
      case when p_consent_confirmed and z.phone_e164 is null then 'granted' else 'none' end,
      case when p_consent_confirmed and z.phone_e164 is null then now() end,
      case when p_consent_confirmed then p_consent_source end,
      case when z.phone_e164 is not null then now() end,
      p_batch_id
    from src s left join public.suppressions z on z.phone_e164 = s.phone
    on conflict (phone_e164) do update set
      name = coalesce(c.name, excluded.name),
      email = coalesce(c.email, excluded.email),
      tags = (select coalesce(array_agg(distinct u), '{}') from unnest(c.tags || excluded.tags) u),
      consent_at = case when c.status = 'active' and c.consent_status = 'none' and excluded.consent_status = 'granted'
                        then now() else c.consent_at end,
      consent_source = case when c.status = 'active' and c.consent_status = 'none' and excluded.consent_status = 'granted'
                        then excluded.consent_source else c.consent_source end,
      consent_status = case when c.status = 'active' and c.consent_status = 'none' and excluded.consent_status = 'granted'
                        then 'granted' else c.consent_status end
    returning (xmax = 0) as is_insert, c.status as st
  )
  select count(*) filter (where is_insert), count(*) filter (where not is_insert),
         count(*) filter (where st = 'unsubscribed')
    into v_inserted, v_updated, v_suppressed from up;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'suppressed', v_suppressed);
end $$;

create or replace function public.audience_count(p_tags text[]) returns int
language sql stable security invoker set search_path = public as $$
  select count(*)::int from public.contacts ct
  where ct.status = 'active' and ct.consent_status = 'granted'
    and (cardinality(coalesce(p_tags, '{}')) = 0 or ct.tags && p_tags)
    and not exists (select 1 from public.suppressions z where z.phone_e164 = ct.phone_e164)
$$;

-- ---------- Launch / control ----------
create or replace function public.launch_campaign(p_campaign_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c public.campaigns%rowtype; t public.templates%rowtype; s public.business_settings%rowtype; n int;
begin
  if not public.can_edit() then raise exception 'forbidden'; end if;
  select * into c from public.campaigns where id = p_campaign_id for update;
  if not found then raise exception 'Campaign not found'; end if;
  if c.status <> 'draft' then raise exception 'Only draft campaigns can be launched'; end if;
  select * into t from public.templates where id = c.template_id;
  select * into s from public.business_settings where id = 1;
  if t.status <> 'approved' then raise exception 'Template is not approved by Meta'; end if;
  if not t.supported then raise exception 'Template uses features this platform does not support'; end if;
  if not s.test_mode and t.source <> 'meta' then raise exception 'Sample templates can only be used in test mode'; end if;
  if jsonb_array_length(c.variable_mapping) <> t.variable_count then
    raise exception 'Variable mapping does not match the template (% variables)', t.variable_count;
  end if;

  insert into public.messages (campaign_id, contact_id, phone_e164)
  select c.id, ct.id, ct.phone_e164 from public.contacts ct
  where ct.status = 'active' and ct.consent_status = 'granted'
    and (cardinality(c.audience_tags) = 0 or ct.tags && c.audience_tags)
    and not exists (select 1 from public.suppressions z where z.phone_e164 = ct.phone_e164)
  on conflict (campaign_id, contact_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No eligible recipients (need active contacts with recorded consent)'; end if;

  update public.campaigns set
    status = case when scheduled_at is not null and scheduled_at > now() then 'scheduled' else 'running' end,
    total_recipients = n, launched_at = now()
  where id = c.id;
  return n;
end $$;

create or replace function public.set_campaign_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.campaigns%rowtype;
begin
  if not public.can_edit() then raise exception 'forbidden'; end if;
  select * into c from public.campaigns where id = p_id for update;
  if not found then raise exception 'Campaign not found'; end if;
  if p_status = 'paused' and c.status in ('running','scheduled') then
    update public.campaigns set status = 'paused' where id = p_id;
  elsif p_status = 'running' and c.status = 'paused' then
    update public.campaigns set status =
      case when scheduled_at is not null and scheduled_at > now() then 'scheduled' else 'running' end where id = p_id;
  elsif p_status = 'cancelled' and c.status in ('running','scheduled','paused') then
    update public.messages set status = 'skipped', skip_reason = 'campaign_cancelled', updated_at = now()
      where campaign_id = p_id and status = 'queued';
    update public.campaigns set status = 'cancelled', completed_at = now() where id = p_id;
  else
    raise exception 'Invalid status change from % to %', c.status, p_status;
  end if;
end $$;

create or replace function public.requeue_message(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.messages%rowtype;
begin
  if not public.can_edit() then raise exception 'forbidden'; end if;
  select * into m from public.messages where id = p_id for update;
  if not found or m.status not in ('needs_review','failed') then
    raise exception 'Only failed or needs-review messages can be requeued';
  end if;
  update public.messages set status = 'queued', next_attempt_at = now(), attempts = least(attempts, 3),
    skip_reason = null, updated_at = now() where id = p_id;
  update public.campaigns set status = 'running', completed_at = null
    where id = m.campaign_id and status = 'completed';
end $$;

-- ---------- Queue (service role only) ----------
create or replace function public.claim_messages(p_limit int)
returns table (
  message_id uuid, campaign_id uuid, contact_id uuid, phone_e164 text, attempts int,
  template_name text, template_language text, template_source text, variable_mapping jsonb,
  contact_name text, contact_email text, contact_status text, consent_status text, suppressed boolean
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select m.id from public.messages m
    join public.campaigns c on c.id = m.campaign_id
    where m.status = 'queued' and m.next_attempt_at <= now() and c.status = 'running'
    order by m.next_attempt_at, m.created_at
    limit greatest(p_limit, 0)
    for update of m skip locked
  ), upd as (
    update public.messages m set status = 'sending', claimed_at = now(), attempts = m.attempts + 1, updated_at = now()
    from picked where m.id = picked.id
    returning m.*
  )
  select u.id, u.campaign_id, u.contact_id, u.phone_e164, u.attempts,
         t.name, t.language, t.source, c.variable_mapping,
         ct.name, ct.email, ct.status, ct.consent_status,
         exists (select 1 from public.suppressions z where z.phone_e164 = u.phone_e164)
  from upd u
  join public.campaigns c on c.id = u.campaign_id
  join public.templates t on t.id = c.template_id
  left join public.contacts ct on ct.id = u.contact_id;
end $$;

-- ---------- Webhook status application (service role only) ----------
create or replace function public.apply_message_status(
  p_wa_id text, p_status text, p_ts timestamptz, p_code text, p_msg text
) returns boolean language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  select status into cur from public.messages where wa_message_id = p_wa_id for update;
  if not found then return false; end if;

  if p_status = 'failed' then
    if cur not in ('delivered','read') then
      update public.messages set status = 'failed', failed_at = p_ts, error_code = p_code,
        error_message = p_msg, updated_at = now() where wa_message_id = p_wa_id;
    end if;
  elsif p_status = 'sent' then
    if cur in ('queued','sending','needs_review','failed') then
      update public.messages set status = 'sent', sent_at = coalesce(sent_at, p_ts), updated_at = now()
        where wa_message_id = p_wa_id;
    end if;
  elsif p_status = 'delivered' then
    if cur <> 'read' then
      update public.messages set status = 'delivered', delivered_at = coalesce(delivered_at, p_ts),
        sent_at = coalesce(sent_at, p_ts), updated_at = now() where wa_message_id = p_wa_id;
    end if;
  elsif p_status = 'read' then
    update public.messages set status = 'read', read_at = coalesce(read_at, p_ts),
      delivered_at = coalesce(delivered_at, p_ts), sent_at = coalesce(sent_at, p_ts), updated_at = now()
      where wa_message_id = p_wa_id;
  end if;
  return true;
end $$;

-- ---------- Housekeeping (cron, every minute) ----------
create or replace function public.campaign_housekeeping() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update public.campaigns set status = 'running' where status = 'scheduled' and scheduled_at <= now();

  -- A worker that died mid-send leaves rows in 'sending'. We cannot know whether Meta accepted
  -- the request, so flag for human review instead of risking a duplicate.
  update public.messages set status = 'needs_review', updated_at = now(),
    error_message = 'Worker stopped while sending; outcome unknown. Check before retrying.'
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  update public.campaigns c set status = 'completed', completed_at = now()
  where c.status = 'running' and not exists (
    select 1 from public.messages m where m.campaign_id = c.id and m.status in ('queued','sending'));

  -- Re-apply webhook events that arrived before we stored the message id.
  for r in select id, wa_message_id, status, event_ts, error_code, error_message
           from public.webhook_events where not processed and received_at > now() - interval '2 days'
           order by id limit 500 loop
    if public.apply_message_status(r.wa_message_id, r.status, r.event_ts, r.error_code, r.error_message) then
      update public.webhook_events set processed = true where id = r.id;
    end if;
  end loop;

  delete from public.webhook_events where received_at < now() - interval '30 days';
  delete from public.rate_limits where window_start < now() - interval '1 day';
end $$;

-- ---------- Rate limiter for Edge Functions ----------
create or replace function public.rl_hit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare h int;
begin
  insert into public.rate_limits (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then 1 else rate_limits.hits + 1 end,
    window_start = case when rate_limits.window_start < now() - make_interval(secs => p_window_seconds) then now() else rate_limits.window_start end
  returning hits into h;
  return h <= p_limit;
end $$;

-- ---------- Reporting ----------
create view public.campaign_stats with (security_invoker = true) as
select campaign_id,
  count(*)::int as total,
  count(*) filter (where status = 'queued')::int as queued,
  count(*) filter (where status = 'sending')::int as sending,
  count(*) filter (where sent_at is not null)::int as sent,
  count(*) filter (where delivered_at is not null)::int as delivered,
  count(*) filter (where read_at is not null)::int as read_n,
  count(*) filter (where status = 'failed')::int as failed,
  count(*) filter (where status = 'skipped')::int as skipped,
  count(*) filter (where status = 'needs_review')::int as needs_review
from public.messages group by campaign_id;

create or replace function public.dashboard_stats(p_days int default 30) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'contacts_total', (select count(*) from public.contacts),
    'contacts_sendable', (select count(*) from public.contacts where status = 'active' and consent_status = 'granted'),
    'suppressed_total', (select count(*) from public.suppressions),
    'campaigns_total', (select count(*) from public.campaigns),
    'campaigns_active', (select count(*) from public.campaigns where status in ('running','scheduled')),
    'sent_last_24h', (select count(*) from public.messages where sent_at > now() - interval '24 hours' and not is_simulated),
    'daily', (select coalesce(jsonb_agg(to_jsonb(d) order by d.day), '[]'::jsonb) from (
        select coalesce(sent_at, created_at)::date as day,
          count(*) filter (where sent_at is not null) as sent,
          count(*) filter (where delivered_at is not null) as delivered,
          count(*) filter (where read_at is not null) as read_n,
          count(*) filter (where status = 'failed') as failed
        from public.messages where created_at > now() - make_interval(days => p_days)
        group by 1) d)
  )
$$;

-- ---------- Function privileges ----------
revoke all on function public.import_contacts(jsonb, text, boolean, uuid), public.audience_count(text[]),
  public.launch_campaign(uuid), public.set_campaign_status(uuid, text), public.requeue_message(uuid),
  public.dashboard_stats(int) from public, anon;
grant execute on function public.import_contacts(jsonb, text, boolean, uuid), public.audience_count(text[]),
  public.launch_campaign(uuid), public.set_campaign_status(uuid, text), public.requeue_message(uuid),
  public.dashboard_stats(int) to authenticated;

revoke all on function public.claim_messages(int), public.apply_message_status(text, text, timestamptz, text, text),
  public.campaign_housekeeping(), public.rl_hit(text, int, int),
  public.on_suppression_insert(), public.on_suppression_delete() from public, anon, authenticated;
grant execute on function public.claim_messages(int), public.apply_message_status(text, text, timestamptz, text, text),
  public.campaign_housekeeping(), public.rl_hit(text, int, int) to service_role;

revoke all on public.campaign_stats from anon;
grant select on public.campaign_stats to authenticated;
