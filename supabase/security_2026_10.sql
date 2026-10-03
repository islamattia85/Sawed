-- Run once in the Supabase SQL Editor. Safe to run again.
-- Rate limiting for the paid and lead endpoints, and how long data is kept.

create table if not exists public.api_hits (key text not null, at timestamptz not null default now());
create index if not exists api_hits_key_at on public.api_hits (key, at);
alter table public.api_hits enable row level security;
comment on table public.api_hits is 'Rate limiting: a salted hash of the caller address per call. Kept one day.';

-- Errors reported by the app (api/error.js): what broke and where, no personal data.
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  message text not null, stack text, source text, build text, version text, screen text, ua text
);
create index if not exists client_errors_at on public.client_errors (at);
alter table public.client_errors enable row level security;

-- Retention, run daily by /api/alerts-cron. Changing a period here changes
-- what the privacy notice must say.
create or replace function public.purge_expired() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r jsonb := '{}'; n int;
begin
  delete from api_hits where at < now() - interval '1 day'; get diagnostics n = row_count; r := r || jsonb_build_object('api_hits', n);
  delete from client_errors where at < now() - interval '30 days'; get diagnostics n = row_count; r := r || jsonb_build_object('client_errors', n);
  delete from lead_assignments where lead_id in (select id from leads where coalesce(updated_at, created_at) < now() - interval '24 months');
  delete from leads where coalesce(updated_at, created_at) < now() - interval '24 months'; get diagnostics n = row_count; r := r || jsonb_build_object('leads', n);
  delete from events where created_at < now() - interval '26 months'; get diagnostics n = row_count; r := r || jsonb_build_object('events', n);
  delete from alert_log where sent_at < now() - interval '13 months'; get diagnostics n = row_count; r := r || jsonb_build_object('alert_log', n);
  delete from consents where created_at < now() - interval '36 months'; get diagnostics n = row_count; r := r || jsonb_build_object('consents', n);
  return r;
end $$;
revoke execute on function public.purge_expired() from public, anon, authenticated;

-- Superseded by installer_leads_v2; nothing calls it.
drop function if exists public.installer_leads();
