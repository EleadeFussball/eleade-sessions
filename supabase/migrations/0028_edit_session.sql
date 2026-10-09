-- Coaches can edit a completed session fully (date, time, length, type, players, outcome, location, notes, payment)
-- instead of deleting and logging it again. Credits and coach pay follow automatically; an invoiced session
-- gets a correction line on the next invoice.

create or replace function public.edit_session(
  p_session_id uuid, p_session_date date, p_start_time time, p_minutes integer, p_format text, p_outcome text,
  p_location text, p_player_ids uuid[], p_topic text default null, p_observations text default null,
  p_improve text default null, p_payment_method text default null, p_coach_id uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_s public.sessions%rowtype;
  v_ids uuid[];
  v_n int;
  v_max int;
begin
  select * into v_s from public.sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  if not public.is_admin() then
    if v_s.coach_id is distinct from public.current_coach_id() then raise exception 'You can only edit your own sessions'; end if;
    if v_s.imported then raise exception 'Sessions from the old documentation can only be changed by Jan'; end if;
    if v_s.session_date < public.today_sydney() - 30 then raise exception 'Sessions older than 30 days can only be changed by Jan'; end if;
    if p_coach_id is not null and p_coach_id <> v_s.coach_id then raise exception 'Only Jan can move a session to another coach'; end if;
  end if;
  if p_session_date > public.today_sydney() then raise exception 'A completed session cannot be in the future'; end if;

  select array_agg(distinct x) into v_ids from unnest(p_player_ids) x where x is not null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  v_max := case p_format when '2:1' then 2 when '4:1' then 4 when 'testing' then 12 else 1 end;
  if v_n = 0 then raise exception 'Pick at least one player'; end if;
  if p_format in ('2:1', '4:1') and v_n < 2 then
    raise exception 'A % session needs at least 2 players. For one player, choose 1:1', p_format;
  end if;
  if v_n > v_max then raise exception 'A % session can have at most % player%', p_format, v_max, case when v_max = 1 then '' else 's' end; end if;

  update public.sessions
     set session_date = p_session_date,
         start_time = p_start_time,
         minutes = coalesce(p_minutes, minutes),
         coach_id = coalesce(p_coach_id, coach_id),
         format = p_format,
         outcome = p_outcome,
         location = nullif(trim(p_location), ''),
         topic = nullif(trim(p_topic), ''),
         observations = nullif(trim(p_observations), ''),
         improve = nullif(trim(p_improve), ''),
         payment_method = case when p_outcome = 'cancelled_in_time' then null else nullif(p_payment_method, '') end
   where id = p_session_id;

  delete from public.session_players where session_id = p_session_id and player_id <> all (v_ids);
  insert into public.session_players (session_id, player_id)
  select p_session_id, x from unnest(v_ids) x
   where not exists (select 1 from public.session_players sp where sp.session_id = p_session_id and sp.player_id = x);

  -- a one-off booking that became this session shows the same details in the calendar
  update public.bookings
     set session_date = p_session_date, start_time = p_start_time, minutes = coalesce(p_minutes, minutes),
         coach_id = coalesce(p_coach_id, coach_id), format = p_format, location = nullif(trim(p_location), '')
   where session_id = p_session_id;
  delete from public.booking_players bp using public.bookings b
   where b.id = bp.booking_id and b.session_id = p_session_id and bp.player_id <> all (v_ids);
  insert into public.booking_players (booking_id, player_id)
  select b.id, x from public.bookings b cross join unnest(v_ids) x
   where b.session_id = p_session_id
     and not exists (select 1 from public.booking_players bp where bp.booking_id = b.id and bp.player_id = x);
end $$;
revoke all on function public.edit_session(uuid, date, time, integer, text, text, text, uuid[], text, text, text, text, uuid) from public, anon;
grant execute on function public.edit_session(uuid, date, time, integer, text, text, text, uuid[], text, text, text, text, uuid) to authenticated;

-- A weekly session that has been completed shows what actually happened (players, type, time), not the plan.
create or replace function public.calendar(p_from date, p_to date)
 returns table(kind text, ref_id uuid, plan_date date, session_date date, start_time time, minutes integer, coach_id uuid,
               format text, location text, note text, player_ids uuid[], players text, moved boolean, session_id uuid, outcome text)
 language sql stable set search_path to 'public'
as $$
  select 'regular'::text, o.plan_id, o.plan_date,
         coalesce(s.session_date, o.session_date), coalesce(s.start_time, o.start_time),
         coalesce(s.minutes, pl.minutes, 60), coalesce(s.coach_id, o.coach_id),
         coalesce(s.format, o.format), coalesce(s.location, o.location), null::text,
         case when s.id is null then o.player_ids else
           (select array_agg(sp.player_id order by p.name) from public.session_players sp
              join public.players p on p.id = sp.player_id where sp.session_id = s.id) end,
         case when s.id is null then o.players else
           (select string_agg(p.name, ', ' order by p.name) from public.session_players sp
              join public.players p on p.id = sp.player_id where sp.session_id = s.id) end,
         o.moved, o.session_id, o.outcome
    from public.plan_occurrences(p_from, p_to) o
    join public.session_plans pl on pl.id = o.plan_id
    left join public.sessions s on s.id = o.session_id
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
