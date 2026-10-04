-- The coaches' calendar: one-off planned sessions alongside the weekly regular ones,
-- and one schedule that returns both. Planned sessions are not logged sessions: they
-- only touch credits and pay once the coach confirms them.
-- Written without any removing statements so it can be applied directly.

create table public.bookings (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references public.coaches(id),
  session_date  date not null,
  start_time    time not null,
  format        text not null check (format in ('1:1', '2:1', '4:1', 'analysis', 'testing', 'assessment')),
  location      text,
  note          text,
  session_id    uuid references public.sessions(id),   -- set once confirmed
  cancelled_at  timestamptz,                           -- taken off the calendar before it happened
  created_by    uuid,
  created_at    timestamptz not null default now(),
  constraint booking_date_sane check (session_date between date '2024-01-01' and date '2030-12-31')
);
create index bookings_date on public.bookings (session_date);

create table public.booking_players (
  booking_id  uuid not null references public.bookings(id),
  player_id   uuid not null references public.players(id),
  primary key (booking_id, player_id)
);

create or replace function public.bookings_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.coach_id   := old.coach_id;
  end if;
  return new;
end $$;
create or replace trigger bookings_stamp before insert or update on public.bookings
  for each row execute function public.bookings_stamp();
revoke execute on function public.bookings_stamp() from public, anon, authenticated;

-- May the signed-in person manage this booking? Jan always; a coach their own.
create or replace function public.can_manage_booking(p_booking_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_admin() or exists (
    select 1 from public.bookings where id = p_booking_id and coach_id = public.current_coach_id()), false)
$$;

alter table public.bookings enable row level security;
alter table public.booking_players enable row level security;
create policy bookings_read on public.bookings for select to authenticated using (public.is_coach());
create policy bookings_insert on public.bookings for insert to authenticated
  with check (public.is_coach() and (public.is_admin() or coach_id = public.current_coach_id()));
create policy bookings_update on public.bookings for update to authenticated
  using (public.can_manage_booking(id)) with check (public.can_manage_booking(id));
create policy bp_read on public.booking_players for select to authenticated using (public.is_coach());
create policy bp_insert on public.booking_players for insert to authenticated
  with check (public.can_manage_booking(booking_id));
grant select, insert, update on public.bookings to authenticated;
grant select, insert on public.booking_players to authenticated;
revoke all on public.bookings, public.booking_players from anon;

-- ---------------------------------------------------------------- the schedule
-- Everything planned between two dates: weekly regular sessions (after any move) and
-- one-off bookings, with whether each has already been confirmed.
create or replace function public.schedule(p_from date, p_to date)
returns table (
  kind text, ref_id uuid, plan_date date, session_date date, start_time time, coach_id uuid,
  format text, location text, note text, player_ids uuid[], players text,
  moved boolean, session_id uuid, outcome text
)
language sql stable security invoker set search_path = public as $$
  select 'regular'::text, o.plan_id, o.plan_date, o.session_date, o.start_time, o.coach_id,
         o.format, o.location, null::text, o.player_ids, o.players, o.moved, o.session_id, o.outcome
    from public.plan_occurrences(p_from, p_to) o
  union all
  select 'once', b.id, null, b.session_date, b.start_time, b.coach_id,
         b.format, b.location, b.note,
         (select array_agg(bp.player_id order by p.name) from public.booking_players bp
            join public.players p on p.id = bp.player_id where bp.booking_id = b.id),
         (select string_agg(p.name, ', ' order by p.name) from public.booking_players bp
            join public.players p on p.id = bp.player_id where bp.booking_id = b.id),
         false, b.session_id, s.outcome
    from public.bookings b
    left join public.sessions s on s.id = b.session_id
   where b.cancelled_at is null and b.session_date between p_from and p_to
   order by 4, 5
$$;

-- ---------------------------------------------------------------- functions
create or replace function public.create_booking(
  p_coach_id uuid, p_session_date date, p_start_time time, p_format text,
  p_player_ids uuid[], p_location text default null, p_note text default null
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
  insert into public.bookings (coach_id, session_date, start_time, format, location, note)
  values (p_coach_id, p_session_date, p_start_time, p_format, nullif(trim(p_location), ''), nullif(trim(p_note), ''))
  returning id into v_id;
  insert into public.booking_players (booking_id, player_id) select v_id, unnest(p_player_ids);
  return v_id;
end $$;

create or replace function public.move_booking(p_booking_id uuid, p_new_date date, p_new_time time)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if exists (select 1 from public.bookings where id = p_booking_id and session_id is not null) then
    raise exception 'This session is already confirmed';
  end if;
  update public.bookings set session_date = p_new_date, start_time = p_new_time where id = p_booking_id;
  if not found then raise exception 'Session not found'; end if;
end $$;

-- Take a planned session off the calendar before it happened. Nobody is charged:
-- a cancellation that should be charged is confirmed with the outcome instead.
create or replace function public.cancel_booking(p_booking_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if exists (select 1 from public.bookings where id = p_booking_id and session_id is not null) then
    raise exception 'This session is already confirmed';
  end if;
  update public.bookings set cancelled_at = now() where id = p_booking_id;
  if not found then raise exception 'Session not found'; end if;
end $$;

-- Confirm a one-off planned session as done, cancelled or a no-show.
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
  insert into public.sessions (session_date, start_time, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method)
  values (v_b.session_date, v_b.start_time, v_coach, v_b.format, p_outcome, v_b.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.booking_players where booking_id = p_booking_id;
  update public.bookings set session_id = v_id where id = p_booking_id;
  return v_id;
end $$;

revoke execute on function public.can_manage_booking(uuid) from public, anon;
revoke execute on function public.schedule(date, date) from public, anon;
revoke execute on function public.create_booking(uuid, date, time, text, uuid[], text, text) from public, anon;
revoke execute on function public.move_booking(uuid, date, time) from public, anon;
revoke execute on function public.cancel_booking(uuid) from public, anon;
revoke execute on function public.confirm_booking(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.can_manage_booking(uuid), public.schedule(date, date),
  public.create_booking(uuid, date, time, text, uuid[], text, text),
  public.move_booking(uuid, date, time), public.cancel_booking(uuid),
  public.confirm_booking(uuid, text, text, text, text, text) to authenticated;
