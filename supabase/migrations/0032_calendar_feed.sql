-- A private calendar link per coach (iPhone / Google Calendar subscription). The token in the link is the only key.

create table if not exists public.calendar_feeds (
  coach_id uuid primary key references public.coaches(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
alter table public.calendar_feeds enable row level security;
drop policy if exists calendar_feeds_own on public.calendar_feeds;
create policy calendar_feeds_own on public.calendar_feeds for select to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id());
grant select on public.calendar_feeds to authenticated;

-- The signed-in coach's link token, created on first use. p_reset makes a new one (the old link stops working).
create or replace function public.my_calendar_token(p_reset boolean default false)
returns text
language plpgsql security definer set search_path = public as $$
declare v_coach uuid := public.current_coach_id(); v_token text;
begin
  if v_coach is null then raise exception 'Only coaches have a calendar link'; end if;
  if p_reset then delete from public.calendar_feeds where coach_id = v_coach; end if;
  insert into public.calendar_feeds (coach_id) values (v_coach) on conflict (coach_id) do nothing;
  select token into v_token from public.calendar_feeds where coach_id = v_coach;
  return v_token;
end $$;
revoke all on function public.my_calendar_token(boolean) from public, anon;
grant execute on function public.my_calendar_token(boolean) to authenticated;

-- What the calendar link shows: the coach's sessions from 4 weeks back to 12 weeks ahead, with plans.
create or replace function public.calendar_feed(p_token text)
returns table(coach_name text, kind text, ref_id uuid, plan_date date, session_date date, start_time time, minutes integer,
              format text, location text, note text, players text, done boolean, outcome text, prep text)
language sql stable security definer set search_path = public as $$
  with f as (select c.id, c.name from public.calendar_feeds cf join public.coaches c on c.id = cf.coach_id
              where cf.token = p_token and length(p_token) >= 32)
  select f.name, e.kind, e.ref_id, e.plan_date, e.session_date, e.start_time, e.minutes,
         e.format, e.location, e.note, e.players, e.session_id is not null, e.outcome,
         case when e.session_id is not null then null
              when e.kind = 'once' then (select sp.topic from public.session_prep sp where sp.booking_id = e.ref_id)
              when e.kind = 'regular' then (select sp.topic from public.session_prep sp where sp.plan_id = e.ref_id and sp.plan_date = e.plan_date)
         end
    from f
    cross join lateral public.calendar(public.today_sydney() - 28, public.today_sydney() + 84) e
   where e.coach_id = f.id
     and coalesce(e.outcome, '') <> 'cancelled_in_time'
$$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;
