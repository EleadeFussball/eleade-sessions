-- Two-monthly feedback is only needed for regular players.
-- feedback_mode per player: 'auto' (regular = a current regular session, or at least 4 sessions in the period),
-- 'always' (always asked for) or 'never' (never asked for). Jan sets it on the player page.

alter table public.players add column if not exists feedback_mode text not null default 'auto';
alter table public.players drop constraint if exists players_feedback_mode_check;
alter table public.players add constraint players_feedback_mode_check check (feedback_mode in ('auto', 'always', 'never'));

create or replace function public.feedback_applies(p_player_id uuid, p_start date, p_end date)
returns boolean
language sql stable security definer set search_path = public as $$
  select case p.feedback_mode
           when 'never' then false
           when 'always' then true
           else p.active and (
             exists (select 1 from public.plan_players pp join public.session_plans pl on pl.id = pp.plan_id
                      where pp.player_id = p.id and pl.starts_on <= p_end and (pl.ends_on is null or pl.ends_on >= p_start))
             or (select count(*) from public.sessions s join public.session_players sp on sp.session_id = s.id
                  where sp.player_id = p.id and s.session_date between p_start and p_end
                    and public.outcome_counts(s.outcome) and s.format in ('1:1', '2:1', '4:1')) >= 4)
         end
    from public.players p where p.id = p_player_id
$$;
revoke execute on function public.feedback_applies(uuid, date, date) from public, anon;
grant execute on function public.feedback_applies(uuid, date, date) to authenticated;

create or replace function public.feedback_due(p_coach_id uuid)
returns table (player_id uuid, name text, period_start date, period_end date, sessions bigint)
language sql stable security definer set search_path = public as $$
  with trained as (
    select f.period_start, f.period_end, sp.player_id, count(*) as n,
           (array_agg(s.coach_id order by s.session_date desc))[1] as last_coach
      from public.feedback_periods() f
      join public.sessions s on s.session_date between f.period_start and f.period_end
      join public.session_players sp on sp.session_id = s.id
     where s.outcome = 'attended' and not s.imported and s.format in ('1:1', '2:1', '4:1')
     group by 1, 2, 3
  )
  select t.player_id, p.name, t.period_start, t.period_end, t.n
    from trained t join public.players p on p.id = t.player_id
   where coalesce(p.main_coach_id, t.last_coach) = p_coach_id
     and (public.is_admin() or p_coach_id = public.current_coach_id())
     and public.feedback_applies(t.player_id, t.period_start, t.period_end)
     and not exists (select 1 from public.player_feedback fb where fb.player_id = t.player_id and fb.period_start = t.period_start
                       and nullif(trim(coalesce(fb.progress, '') || coalesce(fb.focus, '') || coalesce(fb.homework, '')), '') is not null)
   order by t.period_start, p.name
$$;

create or replace function public.feedback_overview()
returns table (player_id uuid, name text, period_start date, period_end date, coach_name text, parent_name text, email text, phone text,
               feedback_id uuid, progress text, focus text, homework text, sent_at timestamptz, status text)
language sql stable security definer set search_path = public as $$
  with trained as (
    select f.period_start, f.period_end, sp.player_id,
           (array_agg(s.coach_id order by s.session_date desc))[1] as last_coach
      from public.feedback_periods() f
      join public.sessions s on s.session_date between f.period_start and f.period_end
      join public.session_players sp on sp.session_id = s.id
     where s.outcome = 'attended' and not s.imported and s.format in ('1:1', '2:1', '4:1')
     group by 1, 2, 3
  )
  select t.player_id, p.name, t.period_start, t.period_end, c.name, p.parent_name, p.email, p.phone,
         fb.id, fb.progress, fb.focus, fb.homework, fb.sent_at,
         case when fb.sent_at is not null then 'sent' when fb.id is not null then 'ready' else 'waiting' end
    from trained t
    join public.players p on p.id = t.player_id
    left join public.coaches c on c.id = coalesce(p.main_coach_id, t.last_coach)
    left join public.player_feedback fb on fb.player_id = t.player_id and fb.period_start = t.period_start
   where public.is_admin()
     and (fb.id is not null or public.feedback_applies(t.player_id, t.period_start, t.period_end))
   order by t.period_start desc, 14 desc, p.name
$$;

-- not regular players: no feedback needed
update public.players set feedback_mode = 'never'
 where name in ('Lewi Basnett', 'Nicholas Hagios', 'Nicolas Calder', 'Noah Peacock', 'Ruby Betro');
