-- Sessions can be cancelled in advance (cancelled in time: no credit used, nothing on the coach invoice).
-- They stay in the calendar, shown faded with a red outline, and can be restored.

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
  if v_b.session_date > public.today_sydney() and p_outcome <> 'cancelled_in_time' then
    raise exception 'This session is still in the future. You can only cancel it in advance';
  end if;
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
  if v_date > public.today_sydney() and p_outcome <> 'cancelled_in_time' then
    raise exception 'This session is still in the future. You can only cancel it in advance';
  end if;
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

-- Undo a cancellation made in advance: the session is planned again.
create or replace function public.undo_cancellation(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.sessions%rowtype;
begin
  select * into v_s from public.sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  if v_s.outcome <> 'cancelled_in_time' then raise exception 'Only a session cancelled in time can be restored'; end if;
  if not (public.is_admin() or v_s.coach_id = public.current_coach_id()) then raise exception 'You can only change your own sessions'; end if;
  update public.bookings set session_id = null where session_id = p_session_id;
  delete from public.sessions where id = p_session_id;
end $$;
revoke all on function public.undo_cancellation(uuid) from public, anon;
grant execute on function public.undo_cancellation(uuid) to authenticated;

-- The phone calendar link also shows cancelled sessions (marked as cancelled).
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
$$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- A Stripe payment is only treated as an assessment at the assessment price ($130 + GST);
-- other amounts (for example two 2:1 sessions at $165) are session payments.
create or replace function public.record_stripe_payment_named(
  p_stripe_session_id text, p_reference text, p_amount_total numeric, p_currency text,
  p_email text, p_name text, p_paid_at timestamptz, p_player_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_player uuid;
  v_n int;
  v_clean text := lower(regexp_replace(trim(coalesce(p_player_name, '')), '\s+', ' ', 'g'));
begin
  v_id := public.record_stripe_payment(p_stripe_session_id, p_reference, p_amount_total, p_currency, p_email, p_name, p_paid_at);
  if v_id is null then return null; end if;   -- already recorded
  if coalesce(trim(p_player_name), '') <> '' then
    update public.stripe_payments set player_name_entered = trim(p_player_name) where id = v_id;
  end if;
  -- a tagged link already found the player; otherwise use the name typed on the link
  if v_clean <> '' and (select player_id from public.stripe_payments where id = v_id) is null then
    select count(*), min(id::text)::uuid into v_n, v_player
      from public.players
     where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = v_clean;
    if v_n = 1 then
      update public.stripe_payments
         set player_id = v_player, for_what = case when p_amount_total between 140 and 150 then 'assessment' else 'session' end,
             purpose = case when p_amount_total between 140 and 150 then 'assessment' else 'unknown' end
       where id = v_id;
      perform public.apply_stripe_payments(v_player);
    end if;
  end if;
  return v_id;
end $$;
