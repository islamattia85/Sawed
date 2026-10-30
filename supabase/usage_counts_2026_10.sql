-- How far people get, read in the Supabase dashboard (29 Oct 2026).
--
-- Two views over public.events, the consent-only counts the app sends
-- (api/event.js). They run with the reader's own rights (security_invoker),
-- and events has row security with no policies, so the website's keys read
-- nothing through them: only the dashboard and the server can.
--
-- usage_funnel: for each step, how many visits reached it, since when.
-- usage_by_day: each step and screen, day by day.

create or replace view public.usage_funnel with (security_invoker = true) as
select step, sessions, since from (
  select name as step,
         count(distinct session_id) as sessions,
         min(created_at)::date as since,
         array_position(array['setup_started', 'meter_file_added', 'setup_finished', 'report_downloaded', 'result_shared', 'switch_click'], name) as ord
  from public.events
  where name in ('setup_started', 'meter_file_added', 'setup_finished', 'report_downloaded', 'result_shared', 'switch_click')
  group by name
) s order by ord;

create or replace view public.usage_by_day with (security_invoker = true) as
select created_at::date as day,
       name as step,
       coalesce(props->>'screen', props->>'how', props->>'route', '') as detail,
       count(*) as events,
       count(distinct session_id) as sessions
from public.events
group by 1, 2, 3
order by 1 desc, 2, 3;

revoke all on public.usage_funnel, public.usage_by_day from public, anon, authenticated;
