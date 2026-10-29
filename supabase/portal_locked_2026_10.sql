-- Run once in the Supabase SQL Editor, after security_2026_10.sql. Safe to run again.
--
-- The installer portal and quote requests are switched off (installerQuotes in
-- src/features.js). Their functions run with the database owner's rights and
-- any signed-in user could call them through the API, so the security advisor
-- warned on each (29 Oct 2026). While the portal is off, nothing may call them.

-- These three read and change leads, which signed-in users cannot read
-- themselves, so they need the owner's rights: closed to everyone but the
-- server. Before switching the portal on, open them again:
--   grant execute on function public.installer_leads_v2(), public.my_quote_requests(),
--     public.set_assignment_status(uuid, text) to authenticated;
revoke execute on function public.installer_leads_v2() from public, anon, authenticated;
revoke execute on function public.my_quote_requests() from public, anon, authenticated;
revoke execute on function public.set_assignment_status(uuid, text) from public, anon, authenticated;

-- The installers and lead_assignments security rules call this one, so it stays
-- callable, with the caller's own rights: it reads only the caller's own rows of
-- installer_members, which that table's own rule already allows.
alter function public.is_installer_member(uuid) security invoker;
