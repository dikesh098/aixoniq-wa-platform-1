-- Aixoniq WhatsApp platform: core schema
create extension if not exists pgcrypto;
create extension if not exists pg_trgm with schema extensions;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- Team members allowed to use the dashboard. Nobody gets access by signing up.
create table public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null check (role in ('admin','editor','viewer')),
  created_at timestamptz not null default now()
);

-- Single-row, non-secret business configuration. Secrets live in Edge Function secrets.
create table public.business_settings (
  id int primary key default 1 check (id = 1),
  business_name text not null default 'Aixoniq Technologies',
  support_email text,
  waba_id text,
  phone_number_id text,
  api_version text not null default 'v23.0' check (api_version ~ '^v[0-9]+\.[0-9]+$'),
  test_mode boolean not null default true,
  daily_cap int not null default 250 check (daily_cap between 1 and 1000000),
  max_per_minute int not null default 30 check (max_per_minute between 1 and 300),
  default_country text not null default 'IN' check (default_country ~ '^[A-Z]{2}$'),
  updated_at timestamptz not null default now()
);
insert into public.business_settings (id) values (1) on conflict do nothing;
create trigger trg_settings_updated before update on public.business_settings
  for each row execute function public.set_updated_at();

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text,
  consent_source text,
  consent_confirmed boolean not null default false,
  total_rows int not null default 0,
  inserted int not null default 0,
  updated int not null default 0,
  rejected int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text,
  email text,
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active','unsubscribed')),
  consent_status text not null default 'none' check (consent_status in ('granted','none')),
  consent_at timestamptz,
  consent_source text,
  consent_note text,
  unsubscribed_at timestamptz,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_tags_gin on public.contacts using gin (tags);
create index contacts_status_idx on public.contacts (status, consent_status);
create index contacts_created_idx on public.contacts (created_at desc);
create index contacts_name_trgm on public.contacts using gin (name extensions.gin_trgm_ops);
create index contacts_email_trgm on public.contacts using gin (email extensions.gin_trgm_ops);
create trigger trg_contacts_updated before update on public.contacts
  for each row execute function public.set_updated_at();

-- Suppression list survives contact deletion and re-import.
create table public.suppressions (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  reason text not null default 'manual' check (reason in ('user_request','manual','import','bounce')),
  source text,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  meta_template_id text,
  name text not null check (name ~ '^[a-z0-9_]{1,512}$'),
  language text not null check (language ~ '^[a-z]{2,3}(_[A-Za-z]{2,4})?$'),
  category text not null default 'MARKETING',
  status text not null default 'pending',
  components jsonb not null default '[]',
  variable_count int not null default 0 check (variable_count between 0 and 20),
  supported boolean not null default true,
  source text not null default 'meta' check (source in ('meta','sample')),
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (name, language)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  template_id uuid not null references public.templates(id),
  status text not null default 'draft'
    check (status in ('draft','scheduled','running','paused','completed','cancelled')),
  scheduled_at timestamptz,
  audience_tags text[] not null default '{}',
  variable_mapping jsonb not null default '[]',
  total_recipients int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  launched_at timestamptz,
  completed_at timestamptz
);
create trigger trg_campaigns_updated before update on public.campaigns
  for each row execute function public.set_updated_at();

-- The sending queue. One row per (campaign, contact): duplicates are impossible.
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  phone_e164 text not null,
  status text not null default 'queued'
    check (status in ('queued','sending','sent','delivered','read','failed','skipped','needs_review')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  wa_message_id text unique,
  is_simulated boolean not null default false,
  error_code text,
  error_message text,
  skip_reason text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index messages_queue_idx on public.messages (next_attempt_at) where status = 'queued';
create index messages_campaign_status_idx on public.messages (campaign_id, status);
create index messages_sent_at_idx on public.messages (sent_at);

-- Meta status events (deduplicated by wamid:status). No message content stored.
create table public.webhook_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  wa_message_id text not null,
  status text not null,
  event_ts timestamptz not null,
  error_code text,
  error_message text,
  processed boolean not null default false,
  received_at timestamptz not null default now()
);
create index webhook_events_unprocessed on public.webhook_events (received_at) where not processed;

create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
