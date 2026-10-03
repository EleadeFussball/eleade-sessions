-- Regular (recurring) sessions: a coach plans a weekly slot for a player or group,
-- then confirms each one as done, cancelled, or moves it to another day and time.
-- Written without any removing statements so it can be applied directly.

create table public.session_plans (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references public.coaches(id),
  format      text not null check (format in ('1:1', '2:1', '4:1', 'analysis', 'testing')),
  weekday     int  not null check (weekday between 1 and 7),   -- ISO: 1 = Monday, 7 = Sunday
  start_time  time not null,
  location    text,
  starts_on   date not null default public.today_sydney(),
  ends_on     date,                                            -- set when the regular session stops
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on - 1)
);

create table public.plan_players (
  plan_id    uuid not null references public.session_plans(id),
  player_id  uuid not null references public.players(id),
  primary key (plan_id, player_id)
);

-- One row per regular date that was moved to another day or time.
create table public.plan_changes (
  plan_id     uuid not null references public.session_plans(id),
  plan_date   date not null,        -- the regular date the change applies to
  new_date    date not null,
  new_time    time not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (plan_id, plan_date),
  check (new_date between plan_date - 14 and plan_date + 14)
);

alter table public.sessions
  add column plan_id uuid references public.session_plans(id),
  add column plan_date date;
create unique index sessions_plan_once on public.sessions (plan_id, plan_date) where plan_id is not null;

create or replace function public.plans_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end $$;
create or replace trigger plans_stamp before insert on public.session_plans
  for each row execute function public.plans_stamp();
create or replace trigger plan_changes_stamp before insert or update on public.plan_changes
  for each row execute function public.plans_stamp();
revoke execute on function public.plans_stamp() from public, anon, authenticated;

-- May the signed-in person manage this plan? Jan always; a coach for their own plans.
create or replace function public.can_manage_plan(p_plan_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.is_admin() or exists (
    select 1 from public.session_plans
     where id = p_plan_id and coach_id = public.current_coach_id()), false)
$$;

-- ---------------------------------------------------------------- access rules
alter table public.session_plans enable row level security;
alter table public.plan_players enable row level security;
alter table public.plan_changes enable row level security;

create policy plans_read on public.session_plans for select to authenticated using (public.is_coach());
create policy plans_insert on public.session_plans for insert to authenticated
  with check (public.is_coach() and (public.is_admin() or coach_id = public.current_coach_id()));
create policy plans_update on public.session_plans for update to authenticated
  using (public.can_manage_plan(id))
  with check (public.is_admin() or coach_id = public.current_coach_id());

create policy plan_players_read on public.plan_players for select to authenticated using (public.is_coach());
create policy plan_players_insert on public.plan_players for insert to authenticated
  with check (public.can_manage_plan(plan_id));

create policy plan_changes_read on public.plan_changes for select to authenticated using (public.is_coach());
create policy plan_changes_insert on public.plan_changes for insert to authenticated
  with check (public.can_manage_plan(plan_id));
create policy plan_changes_update on public.plan_changes for update to authenticated
  using (public.can_manage_plan(plan_id)) with check (public.can_manage_plan(plan_id));

grant select, insert, update on public.session_plans, public.plan_players, public.plan_changes to authenticated;

-- ---------------------------------------------------------------- functions
create or replace function public.create_plan(
  p_coach_id uuid, p_format text, p_weekday int, p_start_time time,
  p_player_ids uuid[], p_location text default null, p_starts_on date default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_n int := coalesce(array_length(p_player_ids, 1), 0);
begin
  if v_n = 0 then raise exception 'Pick at least one player'; end if;
  if p_format in ('1:1', 'analysis') and v_n <> 1 then raise exception 'A % session has exactly one player', p_format; end if;
  if p_format = '2:1' and v_n > 2 then raise exception 'A 2:1 session has at most 2 players'; end if;
  if p_format = '4:1' and v_n > 4 then raise exception 'A 4:1 session has at most 4 players'; end if;
  insert into public.session_plans (coach_id, format, weekday, start_time, location, starts_on)
  values (p_coach_id, p_format, p_weekday, p_start_time, nullif(trim(p_location), ''),
          coalesce(p_starts_on, public.today_sydney()))
  returning id into v_id;
  insert into public.plan_players (plan_id, player_id) select v_id, unnest(p_player_ids);
  return v_id;
end $$;

-- Every planned session between two dates, after moves, with whether it has been handled.
create or replace function public.plan_occurrences(p_from date, p_to date)
returns table (
  plan_id uuid, plan_date date, session_date date, start_time time, coach_id uuid, format text,
  location text, player_ids uuid[], players text, moved boolean, session_id uuid, outcome text
)
language sql stable security invoker set search_path = public as $$
  with regular as (
    select pl.*, d::date as pdate
      from public.session_plans pl
      cross join generate_series(p_from - 14, p_to + 14, interval '1 day') d
     where extract(isodow from d) = pl.weekday
       and d::date >= pl.starts_on
       and (pl.ends_on is null or d::date <= pl.ends_on)
  )
  select r.id, r.pdate, coalesce(ch.new_date, r.pdate), coalesce(ch.new_time, r.start_time),
         r.coach_id, r.format, r.location,
         (select array_agg(pp.player_id order by p.name) from public.plan_players pp
            join public.players p on p.id = pp.player_id where pp.plan_id = r.id),
         (select string_agg(p.name, ', ' order by p.name) from public.plan_players pp
            join public.players p on p.id = pp.player_id where pp.plan_id = r.id),
         ch.plan_id is not null, s.id, s.outcome
    from regular r
    left join public.plan_changes ch on ch.plan_id = r.id and ch.plan_date = r.pdate
    left join public.sessions s on s.plan_id = r.id and s.plan_date = r.pdate
   where coalesce(ch.new_date, r.pdate) between p_from and p_to
   order by 3, 4
$$;

create or replace function public.move_plan_session(p_plan_id uuid, p_plan_date date, p_new_date date, p_new_time time)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if exists (select 1 from public.sessions where plan_id = p_plan_id and plan_date = p_plan_date) then
    raise exception 'This session is already confirmed';
  end if;
  if p_new_date not between p_plan_date - 14 and p_plan_date + 14 then
    raise exception 'A session can be moved up to two weeks either way';
  end if;
  insert into public.plan_changes (plan_id, plan_date, new_date, new_time)
  values (p_plan_id, p_plan_date, p_new_date, p_new_time)
  on conflict (plan_id, plan_date) do update set new_date = excluded.new_date, new_time = excluded.new_time;
end $$;

-- Confirm a planned session as done, or record a cancellation or no-show for it.
-- The session is logged under the confirming coach (Jan logs it under the plan's coach).
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
  insert into public.sessions (session_date, start_time, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method, plan_id, plan_date)
  values (v_date, v_time, v_coach, v_plan.format, p_outcome, v_plan.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end,
          p_plan_id, p_plan_date)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.plan_players where plan_id = p_plan_id;
  return v_id;
end $$;

revoke execute on function public.can_manage_plan(uuid) from public, anon;
revoke execute on function public.create_plan(uuid, text, int, time, uuid[], text, date) from public, anon;
revoke execute on function public.plan_occurrences(date, date) from public, anon;
revoke execute on function public.move_plan_session(uuid, date, date, time) from public, anon;
revoke execute on function public.confirm_plan_session(uuid, date, text, text, text, text, text) from public, anon;
grant execute on function public.can_manage_plan(uuid), public.create_plan(uuid, text, int, time, uuid[], text, date),
  public.plan_occurrences(date, date), public.move_plan_session(uuid, date, date, time),
  public.confirm_plan_session(uuid, date, text, text, text, text, text) to authenticated;
