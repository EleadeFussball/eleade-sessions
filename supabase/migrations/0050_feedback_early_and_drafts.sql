-- Player reviews are postponed to 30 Nov, but coaches may already write them and nothing they type may be lost.
-- 1. The forms are available from the usual date again (25th of the second month); only the due date is later.
-- 2. feedback_due shows the due date, so reminders can wait while the forms stay open.
-- 3. feedback_drafts: saved but not yet sent feedback, so a coach can open it again and carry on.

create or replace function public.feedback_periods() returns table (period_start date, period_end date, due_on date)
language sql stable set search_path = public as $$
  select s::date, (s + interval '2 months' - interval '1 day')::date,
         greatest((s + interval '1 month' + interval '24 days')::date,
                  coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_not_before'), date '2000-01-01'))
    from generate_series(
           date_trunc('month', coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_from'), date '2026-09-01')),
           public.today_sydney(), interval '2 months') s
   where (s + interval '1 month' + interval '24 days')::date <= public.today_sydney()
$$;

drop function if exists public.feedback_due(uuid);
create or replace function public.feedback_due(p_coach_id uuid)
returns table (player_id uuid, name text, period_start date, period_end date, sessions bigint, due_on date)
language sql stable security definer set search_path = public as $$
  with trained as (
    select f.period_start, f.period_end, f.due_on, sp.player_id, count(*) as n,
           (array_agg(s.coach_id order by s.session_date desc))[1] as last_coach
      from public.feedback_periods() f
      join public.sessions s on s.session_date between f.period_start and f.period_end
      join public.session_players sp on sp.session_id = s.id
     where s.outcome = 'attended' and not s.imported and s.format in ('1:1', '2:1', '4:1')
     group by 1, 2, 3, 4
  )
  select t.player_id, p.name, t.period_start, t.period_end, t.n, t.due_on
    from trained t join public.players p on p.id = t.player_id
   where coalesce(p.main_coach_id, t.last_coach) = p_coach_id
     and (public.is_admin() or p_coach_id = public.current_coach_id())
     and public.feedback_applies(t.player_id, t.period_start, t.period_end)
     and not exists (select 1 from public.player_feedback fb where fb.player_id = t.player_id and fb.period_start = t.period_start
                       and nullif(trim(coalesce(fb.progress, '') || coalesce(fb.focus, '') || coalesce(fb.homework, '')), '') is not null)
   order by t.period_start, p.name
$$;

create or replace function public.feedback_drafts(p_coach_id uuid)
returns table (player_id uuid, name text, period_start date, period_end date, progress text, focus text, homework text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select fb.player_id, p.name, fb.period_start, fb.period_end, fb.progress, fb.focus, fb.homework, fb.updated_at
    from public.player_feedback fb join public.players p on p.id = fb.player_id
   where fb.sent_at is null
     and (public.is_admin() or p_coach_id = public.current_coach_id())
     and coalesce(p.main_coach_id, fb.coach_id) = p_coach_id
   order by fb.period_start desc, p.name
$$;

revoke execute on function public.feedback_due(uuid), public.feedback_drafts(uuid) from public, anon;
grant execute on function public.feedback_due(uuid), public.feedback_drafts(uuid) to authenticated;
