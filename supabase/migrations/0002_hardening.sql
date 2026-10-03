-- Hardening from the Supabase security advisor.
-- 1. Pin search_path on the two helper functions.
alter function public.today_sydney() set search_path = public;
alter function public.outcome_counts(text) set search_path = public;

-- 2. Trigger functions are never called directly: nobody needs EXECUTE on them
--    (triggers still fire without it).
revoke execute on function public.link_coach_on_signup() from public, anon, authenticated;
revoke execute on function public.link_coach_on_save()   from public, anon, authenticated;
revoke execute on function public.sessions_stamp()       from public, anon, authenticated;
revoke execute on function public.ledger_stamp()         from public, anon, authenticated;
revoke execute on function public.notes_stamp()          from public, anon, authenticated;

-- 3. Identity helpers are needed by the access rules for signed-in users only.
revoke execute on function public.is_admin()         from public, anon;
revoke execute on function public.is_coach()         from public, anon;
revoke execute on function public.current_coach_id() from public, anon;
revoke execute on function public.log_session(date, uuid, text, text, uuid[], text, time, text, text, text) from public, anon;
