-- Row Level Security: default deny, explicit grants per role.

create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.staff where user_id = auth.uid()
$$;
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_role() is not null $$;
create or replace function public.can_edit() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_role() in ('admin','editor') $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.staff_role() = 'admin' $$;

revoke all on function public.staff_role(), public.is_staff(), public.can_edit(), public.is_admin() from public, anon;
grant execute on function public.staff_role(), public.is_staff(), public.can_edit(), public.is_admin() to authenticated;

-- Anonymous users get nothing.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

alter table public.staff enable row level security;
alter table public.business_settings enable row level security;
alter table public.import_batches enable row level security;
alter table public.contacts enable row level security;
alter table public.suppressions enable row level security;
alter table public.templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.messages enable row level security;
alter table public.webhook_events enable row level security;   -- no policies: service role only
alter table public.rate_limits enable row level security;      -- no policies: service role only

-- staff
create policy staff_read_self on public.staff for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy staff_admin_write on public.staff for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- business_settings
create policy settings_read on public.business_settings for select to authenticated using (public.is_staff());
create policy settings_update on public.business_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin() and id = 1);

-- import_batches
create policy batches_read on public.import_batches for select to authenticated using (public.is_staff());
create policy batches_insert on public.import_batches for insert to authenticated with check (public.can_edit());
create policy batches_update on public.import_batches for update to authenticated
  using (public.can_edit() and created_by = auth.uid()) with check (public.can_edit());

-- contacts
create policy contacts_read on public.contacts for select to authenticated using (public.is_staff());
create policy contacts_insert on public.contacts for insert to authenticated with check (public.can_edit());
create policy contacts_update on public.contacts for update to authenticated
  using (public.can_edit()) with check (public.can_edit());
create policy contacts_delete on public.contacts for delete to authenticated using (public.is_admin());

-- suppressions
create policy supp_read on public.suppressions for select to authenticated using (public.is_staff());
create policy supp_insert on public.suppressions for insert to authenticated with check (public.can_edit());
create policy supp_delete on public.suppressions for delete to authenticated using (public.is_admin());

-- templates: real templates come only from the sync function (service role).
-- Admins may add clearly-labelled sample templates for test mode.
create policy tpl_read on public.templates for select to authenticated using (public.is_staff());
create policy tpl_sample_insert on public.templates for insert to authenticated
  with check (public.is_admin() and source = 'sample');
create policy tpl_sample_delete on public.templates for delete to authenticated
  using (public.is_admin() and source = 'sample');

-- campaigns
create policy camp_read on public.campaigns for select to authenticated using (public.is_staff());
create policy camp_insert on public.campaigns for insert to authenticated
  with check (public.can_edit() and status = 'draft');
create policy camp_update_draft on public.campaigns for update to authenticated
  using (public.can_edit() and status = 'draft') with check (public.can_edit() and status = 'draft');
create policy camp_delete on public.campaigns for delete to authenticated
  using (public.is_admin() and status = 'draft');

-- messages: read-only for staff; all writes happen in definer functions / service role.
create policy msg_read on public.messages for select to authenticated using (public.is_staff());
