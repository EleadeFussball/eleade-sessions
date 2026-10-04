-- Written without any removing statements so it can be applied directly.

-- The time in Sydney, in one place so the rule tests can set the clock.
create or replace function public.sydney_now() returns timestamp
language sql stable set search_path = public as $$ select now() at time zone 'Australia/Sydney' $$;
grant execute on function public.sydney_now() to authenticated;

-- A session can be marked as completed once it is over: five minutes after its planned end.
-- Cancellations and no-shows can be recorded at any time. Jan can confirm at any time.
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
  if p_outcome = 'attended' and not public.is_admin() and v_b.start_time is not null
     and (v_b.session_date + v_b.start_time + make_interval(mins => v_b.minutes + 5)) > public.sydney_now() then
    raise exception 'You can mark this session as completed from %, five minutes after it ends',
      to_char(v_b.start_time + make_interval(mins => v_b.minutes + 5), 'HH24:MI');
  end if;
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
  if p_outcome = 'attended' and not public.is_admin() and v_time is not null
     and (v_date + v_time + make_interval(mins => v_plan.minutes + 5)) > public.sydney_now() then
    raise exception 'You can mark this session as completed from %, five minutes after it ends',
      to_char(v_time + make_interval(mins => v_plan.minutes + 5), 'HH24:MI');
  end if;
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
