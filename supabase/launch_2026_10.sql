-- Run once in the Supabase SQL Editor before launch. Safe to run again.
--
-- 1. Retention. The daily job (/api/alerts-cron) calls purge_expired(), but
--    the function was never created on the live project, so nothing was ever
--    removed. The periods here are the ones the privacy page states.
-- 2. Quote requests to installers were removed from the app (October 2026).
--    Their tables and functions go, with any rows in them: the people who
--    sent them agreed to a service that no longer exists.

create or replace function public.purge_expired() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r jsonb := '{}'; n int;
begin
  delete from api_hits where at < now() - interval '1 day'; get diagnostics n = row_count; r := r || jsonb_build_object('api_hits', n);
  delete from client_errors where at < now() - interval '30 days'; get diagnostics n = row_count; r := r || jsonb_build_object('client_errors', n);
  delete from events where created_at < now() - interval '26 months'; get diagnostics n = row_count; r := r || jsonb_build_object('events', n);
  delete from alert_log where sent_at < now() - interval '13 months'; get diagnostics n = row_count; r := r || jsonb_build_object('alert_log', n);
  delete from consents where created_at < now() - interval '36 months'; get diagnostics n = row_count; r := r || jsonb_build_object('consents', n);
  return r;
end $$;
revoke execute on function public.purge_expired() from public, anon, authenticated;

drop table if exists public.lead_assignments, public.leads, public.installer_members, public.installers cascade;
drop function if exists public.installer_leads();
drop function if exists public.installer_leads_v2();
drop function if exists public.my_quote_requests();
drop function if exists public.route_lead(uuid);
drop function if exists public.set_assignment_status(uuid, text);
drop function if exists public.is_installer_member(uuid);

-- Check: should list only purge_expired, and run without error.
select proname from pg_proc where pronamespace = 'public'::regnamespace;
select public.purge_expired();
