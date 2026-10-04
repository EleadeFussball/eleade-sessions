-- How long a session runs, so the calendar can show it on a time grid. One hour unless changed.
-- The schedule also returns sessions a coach logged without planning them first.
-- Written without any removing statements so it can be applied directly.

alter table public.bookings      add column if not exists minutes int not null default 60;
alter table public.session_plans add column if not exists minutes int not null default 60;
alter table public.sessions      add column if not exists minutes int not null default 60;
alter table public.bookings      add constraint bookings_minutes_sane      check (minutes between 15 and 480);
alter table public.session_plans add constraint session_plans_minutes_sane check (minutes between 15 and 480);
alter table public.sessions      add constraint sessions_minutes_sane      check (minutes between 15 and 480);

-- Named "calendar" because it returns more than the first version of "schedule" did,
-- and a function's result cannot be widened in place. The old schedule() is no longer used.
create or replace function public.calendar(p_from date, p_to date)
returns table (
  kind text, ref_id uuid, plan_date date, session_date date, start_time time, minutes int, coach_id uuid,
  format text, location text, note text, player_ids uuid[], players text,
  moved boolean, session_id uuid, outcome text
)
language sql stable security invoker set search_path = public as $$
  select 'regular'::text, o.plan_id, o.plan_date, o.session_date, o.start_time,
         coalesce(pl.minutes, 60), o.coach_id,
         o.format, o.location, null::text, o.player_ids, o.players, o.moved, o.session_id, o.outcome
    from public.plan_occurrences(p_from, p_to) o
    join public.session_plans pl on pl.id = o.plan_id
  union all
  select 'once', b.id, null, b.session_date, b.start_time, b.minutes, b.coach_id,
         b.format, b.location, b.note,
         (select array_agg(bp.player_id order by p.name) from public.booking_players bp
            join public.players p on p.id = bp.player_id where bp.booking_id = b.id),
         (select string_agg(p.name, ', ' order by p.name) from public.booking_players bp
            join public.players p on p.id = bp.player_id where bp.booking_id = b.id),
         false, b.session_id, s.outcome
    from public.bookings b
    left join public.sessions s on s.id = b.session_id
   where b.cancelled_at is null and b.session_date between p_from and p_to
  union all
  -- logged straight from the Log screen, with no plan or booking behind it
  select 'logged', s.id, null, s.session_date, s.start_time, s.minutes, s.coach_id,
         s.format, s.location, null,
         (select array_agg(sp.player_id order by p.name) from public.session_players sp
            join public.players p on p.id = sp.player_id where sp.session_id = s.id),
         (select string_agg(p.name, ', ' order by p.name) from public.session_players sp
            join public.players p on p.id = sp.player_id where sp.session_id = s.id),
         false, s.id, s.outcome
    from public.sessions s
   where not s.imported and s.plan_id is null
     and s.session_date between p_from and p_to
     and not exists (select 1 from public.bookings b where b.session_id = s.id)
  order by 4, 5
$$;

-- New names rather than extra arguments: adding a defaulted argument to an existing
-- function would make calls ambiguous, and an existing function cannot be removed here.

-- Plan a one-off session with a length.
create or replace function public.book_session(
  p_coach_id uuid, p_session_date date, p_start_time time, p_minutes int, p_format text,
  p_player_ids uuid[], p_location text, p_note text
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_n int := coalesce(array_length(p_player_ids, 1), 0);
begin
  if v_n = 0 then raise exception 'Pick at least one player'; end if;
  if p_format in ('1:1', 'analysis', 'assessment') and v_n <> 1 then
    raise exception 'A % has exactly one player', p_format;
  end if;
  if p_format = '2:1' and v_n > 2 then raise exception 'A 2:1 session has at most 2 players'; end if;
  if p_format = '4:1' and v_n > 4 then raise exception 'A 4:1 session has at most 4 players'; end if;
  insert into public.bookings (coach_id, session_date, start_time, format, location, note, minutes)
  values (p_coach_id, p_session_date, p_start_time, p_format, nullif(trim(p_location), ''),
          nullif(trim(p_note), ''), coalesce(p_minutes, 60))
  returning id into v_id;
  insert into public.booking_players (booking_id, player_id) select v_id, unnest(p_player_ids);
  return v_id;
end $$;

-- How long a weekly regular session runs, from now on.
create or replace function public.set_plan_minutes(p_plan_id uuid, p_minutes int) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.session_plans set minutes = p_minutes where id = p_plan_id;
  if not found then raise exception 'Regular session not found'; end if;
end $$;

-- Move anything on the calendar: a week of a regular session, a one-off, or a logged session.
-- For a regular session the new length applies to every week; the move applies to that week only.
create or replace function public.reschedule(
  p_kind text, p_ref_id uuid, p_plan_date date, p_new_date date, p_new_time time, p_minutes int
) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if p_kind = 'regular' then
    if exists (select 1 from public.sessions where plan_id = p_ref_id and plan_date = p_plan_date) then
      raise exception 'This session is already confirmed';
    end if;
    if p_new_date not between p_plan_date - 14 and p_plan_date + 14 then
      raise exception 'A weekly session can be moved up to two weeks either way';
    end if;
    insert into public.plan_changes (plan_id, plan_date, new_date, new_time)
    values (p_ref_id, p_plan_date, p_new_date, p_new_time)
    on conflict (plan_id, plan_date) do update set new_date = excluded.new_date, new_time = excluded.new_time;
    if p_minutes is not null then
      update public.session_plans set minutes = p_minutes where id = p_ref_id;
    end if;
  elsif p_kind = 'once' then
    if exists (select 1 from public.bookings where id = p_ref_id and session_id is not null) then
      raise exception 'This session is already confirmed';
    end if;
    update public.bookings
       set session_date = p_new_date, start_time = p_new_time, minutes = coalesce(p_minutes, minutes)
     where id = p_ref_id;
    if not found then raise exception 'Session not found'; end if;
  elsif p_kind = 'logged' then
    update public.sessions
       set session_date = p_new_date, start_time = p_new_time, minutes = coalesce(p_minutes, minutes)
     where id = p_ref_id;
    if not found then raise exception 'Session not found, or you can no longer change it'; end if;
  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

-- A confirmed session keeps the length it was planned with.
create or replace function public.confirm_booking(
  p_booking_id uuid, p_outcome text,
  p_topic text default null, p_observations text default null, p_improve text default null,
  p_payment_method text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_b public.bookings%rowtype;
  v_coach uuid;
  v_id uuid;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Session not found'; end if;
  if v_b.session_id is not null then raise exception 'This session is already confirmed'; end if;
  if v_b.cancelled_at is not null then raise exception 'This session was taken off the calendar'; end if;
  if v_b.session_date > public.today_sydney() then raise exception 'This session is still in the future'; end if;
  v_coach := case when public.is_admin() then v_b.coach_id else public.current_coach_id() end;
  insert into public.sessions (session_date, start_time, minutes, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method)
  values (v_b.session_date, v_b.start_time, v_b.minutes, v_coach, v_b.format, p_outcome, v_b.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.booking_players where booking_id = p_booking_id;
  update public.bookings set session_id = v_id where id = p_booking_id;
  return v_id;
end $$;

create or replace function public.confirm_plan_session(
  p_plan_id uuid, p_plan_date date, p_outcome text,
  p_topic text default null, p_observations text default null, p_improve text default null,
  p_payment_method text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_plan public.session_plans%rowtype;
  v_date date;
  v_time time;
  v_coach uuid;
  v_id uuid;
begin
  select * into v_plan from public.session_plans where id = p_plan_id;
  if not found then raise exception 'Regular session not found'; end if;
  select coalesce(ch.new_date, p_plan_date), coalesce(ch.new_time, v_plan.start_time)
    into v_date, v_time
    from (select 1) one left join public.plan_changes ch on ch.plan_id = p_plan_id and ch.plan_date = p_plan_date;
  if v_date > public.today_sydney() then raise exception 'This session is still in the future'; end if;
  if exists (select 1 from public.sessions where plan_id = p_plan_id and plan_date = p_plan_date) then
    raise exception 'This session is already confirmed';
  end if;
  v_coach := case when public.is_admin() then v_plan.coach_id else public.current_coach_id() end;
  insert into public.sessions (session_date, start_time, minutes, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method, plan_id, plan_date)
  values (v_date, v_time, v_plan.minutes, v_coach, v_plan.format, p_outcome, v_plan.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end,
          p_plan_id, p_plan_date)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.plan_players where plan_id = p_plan_id;
  return v_id;
end $$;

-- A session logged straight from the Log screen can be moved on the calendar too.
create or replace function public.move_session(p_session_id uuid, p_new_date date, p_new_time time, p_minutes int default null)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.sessions
     set session_date = p_new_date, start_time = p_new_time, minutes = coalesce(p_minutes, minutes)
   where id = p_session_id;
  if not found then raise exception 'Session not found, or you can no longer change it'; end if;
end $$;

revoke execute on function public.calendar(date, date) from public, anon;
revoke execute on function public.book_session(uuid, date, time, int, text, uuid[], text, text) from public, anon;
revoke execute on function public.set_plan_minutes(uuid, int) from public, anon;
revoke execute on function public.reschedule(text, uuid, date, date, time, int) from public, anon;
grant execute on function public.calendar(date, date),
  public.book_session(uuid, date, time, int, text, uuid[], text, text),
  public.set_plan_minutes(uuid, int),
  public.reschedule(text, uuid, date, date, time, int) to authenticated;
