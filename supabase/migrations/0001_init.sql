-- Eleade platform, phase 1: session tracking, documentation, credits, coach pay.
-- Principle: a session is logged once, by the coach. Credits, documentation,
-- coach pay and the Monday checks are all derived from that one record.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- helpers
create or replace function public.today_sydney() returns date
language sql stable as $$ select (now() at time zone 'Australia/Sydney')::date $$;

-- ---------------------------------------------------------------- tables
create table public.coaches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  email       text unique,
  user_id     uuid unique,               -- auth.users.id, linked on first login by email
  is_admin    boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Pay per session, per format. Only the coach themself and the admin can read a row.
create table public.coach_rates (
  coach_id     uuid primary key references public.coaches(id) on delete cascade,
  one_to_one   numeric(8,2),
  two_to_one   numeric(8,2) not null default 70,
  four_to_one  numeric(8,2) not null default 80,
  analysis     numeric(8,2) not null default 60,
  testing      numeric(8,2) not null default 0,
  updated_at   timestamptz not null default now()
);

create table public.players (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  family           text,                     -- siblings who share billing
  billing_model    text not null default 'package'
                   check (billing_model in ('package', 'pay_per_session')),
  session_price    numeric(8,2),             -- pay per session players: price per session, ex GST
  main_coach_id    uuid references public.coaches(id),
  active           boolean not null default true,
  opening_confirmed boolean not null default false,
  profile_notes    text,                     -- tailored arrangements: free session, agreed price, focus
  created_at       timestamptz not null default now()
);
create unique index players_name_uq on public.players (lower(name));

-- Every change to a player's credits, with a reason. Balance = sum of this - sessions used.
create table public.credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references public.players(id) on delete cascade,
  kind            text not null check (kind in ('opening', 'purchase', 'free', 'correction', 'expiry')),
  sessions_delta  numeric(6,2) not null default 0,
  analyses_delta  numeric(6,2) not null default 0,
  package_name    text,
  amount_paid     numeric(10,2),
  reason          text not null check (length(trim(reason)) > 0),
  effective_date  date not null default public.today_sydney(),
  expires_on      date,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index credit_ledger_player on public.credit_ledger (player_id);

create table public.sessions (
  id            uuid primary key default gen_random_uuid(),
  session_date  date not null,
  start_time    time,
  coach_id      uuid not null references public.coaches(id),
  format        text not null check (format in ('1:1', '2:1', '4:1', 'analysis', 'testing')),
  outcome       text not null default 'attended'
                check (outcome in ('attended', 'cancelled_in_time', 'cancelled_late', 'no_show')),
  location      text,
  topic         text,      -- what was worked on
  observations  text,      -- key observations / feedback
  improve       text,      -- areas to improve / ideas for next session
  imported      boolean not null default false,  -- history from the old files: never touches credits or pay
  logged_by     uuid,
  logged_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint session_date_sane check (session_date between date '2024-01-01' and date '2030-12-31')
);
create index sessions_date on public.sessions (session_date);
create index sessions_coach on public.sessions (coach_id, session_date);

create table public.session_players (
  session_id  uuid not null references public.sessions(id) on delete cascade,
  player_id   uuid not null references public.players(id),
  primary key (session_id, player_id)
);
create index session_players_player on public.session_players (player_id);

create table public.player_notes (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.players(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0),
  author      uuid,
  created_at  timestamptz not null default now()
);

-- Pay per session families: one row per payment received.
create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.players(id) on delete cascade,
  week_start  date not null,               -- Monday of the week paid for
  amount      numeric(10,2) not null,
  received_on date not null default public.today_sydney(),
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table public.settings (
  key    text primary key,
  value  jsonb not null
);
insert into public.settings (key, value) values
  ('default_session_price', '120'),
  ('late_log_days', '2'),
  ('low_credit_threshold', '2');

-- ---------------------------------------------------------------- identity
create or replace function public.current_coach_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.coaches where user_id = auth.uid() and active
$$;

create or replace function public.is_coach() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.coaches where user_id = auth.uid() and active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.coaches where user_id = auth.uid() and active and is_admin)
$$;

-- Link a login to its coach record by email (runs when Jan invites a coach).
create or replace function public.link_coach_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.coaches set user_id = new.id
   where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_coach_on_signup();

-- And the other way round: Jan adds a coach whose login already exists.
create or replace function public.link_coach_on_save() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if new.email is not null and (tg_op = 'INSERT' or new.email is distinct from old.email) then
    new.user_id := (select id from auth.users where lower(email) = lower(new.email) limit 1);
  end if;
  return new;
end $$;

create trigger coaches_link before insert or update of email on public.coaches
  for each row execute function public.link_coach_on_save();

-- ---------------------------------------------------------------- business rules
-- Which outcomes use a credit and are paid to the coach.
create or replace function public.outcome_counts(o text) returns boolean
language sql immutable as $$ select o in ('attended', 'cancelled_late', 'no_show') $$;

-- Stamp who logged it, keep imported history out of reach of normal edits.
create or replace function public.sessions_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.logged_by := coalesce(auth.uid(), new.logged_by);
    new.logged_at := coalesce(new.logged_at, now());
  else
    new.logged_by := old.logged_by;
    new.logged_at := old.logged_at;
    new.imported  := old.imported;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger sessions_stamp before insert or update on public.sessions
  for each row execute function public.sessions_stamp();

create or replace function public.ledger_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  return new;
end $$;
create trigger ledger_stamp before insert on public.credit_ledger
  for each row execute function public.ledger_stamp();

create or replace function public.notes_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author := coalesce(auth.uid(), new.author);
  return new;
end $$;
create trigger notes_stamp before insert on public.player_notes
  for each row execute function public.notes_stamp();

-- Log a session and its players in one call (one entry, many players for groups).
create or replace function public.log_session(
  p_session_date date, p_coach_id uuid, p_format text, p_outcome text,
  p_player_ids uuid[], p_location text default null, p_start_time time default null,
  p_topic text default null, p_observations text default null, p_improve text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_expected int := case p_format when '2:1' then 2 when '4:1' then 4 else null end;
begin
  if p_player_ids is null or array_length(p_player_ids, 1) is null then
    raise exception 'Pick at least one player';
  end if;
  if p_format in ('1:1', 'analysis') and array_length(p_player_ids, 1) <> 1 then
    raise exception 'A % session has exactly one player', p_format;
  end if;
  if v_expected is not null and array_length(p_player_ids, 1) > v_expected then
    raise exception 'A % session has at most % players', p_format, v_expected;
  end if;
  if p_session_date > public.today_sydney() then
    raise exception 'Session date is in the future';
  end if;
  insert into public.sessions (session_date, start_time, coach_id, format, outcome, location, topic, observations, improve)
  values (p_session_date, p_start_time, p_coach_id, p_format, p_outcome, p_location, p_topic, p_observations, p_improve)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, unnest(p_player_ids);
  return v_id;
end $$;

-- ---------------------------------------------------------------- views
-- One row per player per session that uses a credit (live sessions only).
create or replace view public.credit_usage with (security_invoker = true) as
select sp.player_id, s.id as session_id, s.session_date, s.format, s.outcome,
       case when s.format in ('1:1', '2:1', '4:1') then 1 else 0 end as sessions_used,
       case when s.format = 'analysis' then 1 else 0 end as analyses_used
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
 where not s.imported
   and public.outcome_counts(s.outcome)
   and s.format <> 'testing';

create or replace view public.player_balances with (security_invoker = true) as
with led as (
  select player_id, sum(sessions_delta) s, sum(analyses_delta) a,
         max(effective_date) filter (where kind = 'purchase') last_purchase,
         min(expires_on) filter (where expires_on >= public.today_sydney()) next_expiry
    from public.credit_ledger group by player_id
), used as (
  select player_id, sum(sessions_used) s, sum(analyses_used) a from public.credit_usage group by player_id
), last_s as (
  select sp.player_id, max(s.session_date) last_session
    from public.sessions s join public.session_players sp on sp.session_id = s.id
   where s.outcome = 'attended' group by sp.player_id
)
, per_player as (
select p.id as player_id, p.name, p.family, p.billing_model, p.active, p.main_coach_id, p.opening_confirmed,
       case when p.billing_model = 'package' then coalesce(led.s, 0) - coalesce(used.s, 0) end as own_sessions_left,
       case when p.billing_model = 'package' then coalesce(led.a, 0) - coalesce(used.a, 0) end as own_analyses_left,
       coalesce(used.s, 0) as sessions_used_live,
       led.last_purchase, led.next_expiry, last_s.last_session
  from public.players p
  left join led on led.player_id = p.id
  left join used on used.player_id = p.id
  left join last_s on last_s.player_id = p.id
)
-- Siblings with a family name share one credit pool (one package covers the family).
select pp.*,
       case when pp.family is null then pp.own_sessions_left
            else sum(pp.own_sessions_left) over (partition by pp.family) end as sessions_left,
       case when pp.family is null then pp.own_analyses_left
            else sum(pp.own_analyses_left) over (partition by pp.family) end as analyses_left
  from per_player pp;

-- Coach pay per session. Inner join on coach_rates means RLS hides other coaches' pay.
create or replace view public.coach_pay with (security_invoker = true) as
select s.id as session_id, s.session_date,
       (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
       s.coach_id, c.name as coach_name, s.format, s.outcome,
       (select string_agg(p.name, ', ' order by p.name)
          from public.session_players sp join public.players p on p.id = sp.player_id
         where sp.session_id = s.id) as players,
       case when not public.outcome_counts(s.outcome) then 0
            else case s.format
                   when '1:1' then r.one_to_one
                   when '2:1' then r.two_to_one
                   when '4:1' then r.four_to_one
                   when 'analysis' then r.analysis
                   when 'testing' then r.testing
                 end
       end as pay
  from public.sessions s
  join public.coaches c on c.id = s.coach_id
  join public.coach_rates r on r.coach_id = s.coach_id
 where not s.imported;

-- Pay per session: what each family owes per week, and what has arrived.
create or replace view public.payg_weeks with (security_invoker = true) as
with charges as (
  select sp.player_id,
         (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
         count(*) as sessions,
         sum(coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))) as owed
    from public.sessions s
    join public.session_players sp on sp.session_id = s.id
    join public.players p on p.id = sp.player_id
   where not s.imported and public.outcome_counts(s.outcome)
     and s.format <> 'testing' and p.billing_model = 'pay_per_session'
   group by 1, 2
), paid as (
  select player_id, week_start, sum(amount) amount from public.payments group by 1, 2
)
select c.player_id, p.name, p.family, c.week_start, c.sessions, c.owed,
       coalesce(paid.amount, 0) as paid, c.owed - coalesce(paid.amount, 0) as outstanding
  from charges c
  join public.players p on p.id = c.player_id
  left join paid on paid.player_id = c.player_id and paid.week_start = c.week_start
 where public.is_admin();

-- Monday checks: regular players (a session in each of the 3 weeks before last week)
-- with nothing logged last week or since.
create or replace view public.missing_sessions with (security_invoker = true) as
with wk as (
  select (public.today_sydney() - ((extract(isodow from public.today_sydney())::int) - 1))::date as this_week
), per_week as (
  select sp.player_id, (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start
    from public.sessions s join public.session_players sp on sp.session_id = s.id
   group by 1, 2
)
select p.id as player_id, p.name, p.main_coach_id,
       (select max(s.session_date) from public.sessions s join public.session_players sp on sp.session_id = s.id
         where sp.player_id = p.id) as last_logged
  from public.players p, wk
 where p.active
   and (select count(distinct week_start) from per_week pw
         where pw.player_id = p.id
           and pw.week_start between wk.this_week - 28 and wk.this_week - 14) = 3
   and not exists (select 1 from per_week pw
                    where pw.player_id = p.id and pw.week_start >= wk.this_week - 7);

create or replace view public.late_logs with (security_invoker = true) as
select s.id as session_id, s.session_date, (s.logged_at at time zone 'Australia/Sydney')::date as logged_on,
       s.coach_id, c.name as coach_name, s.format,
       ((s.logged_at at time zone 'Australia/Sydney')::date - s.session_date) as days_late
  from public.sessions s join public.coaches c on c.id = s.coach_id
 where not s.imported
   and ((s.logged_at at time zone 'Australia/Sydney')::date - s.session_date)
       > (select (value #>> '{}')::int from public.settings where key = 'late_log_days');

-- ---------------------------------------------------------------- row level security
alter table public.coaches enable row level security;
alter table public.coach_rates enable row level security;
alter table public.players enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.sessions enable row level security;
alter table public.session_players enable row level security;
alter table public.player_notes enable row level security;
alter table public.payments enable row level security;
alter table public.settings enable row level security;

-- coaches: every coach sees the team list; only the admin changes it
create policy coaches_read on public.coaches for select to authenticated using (public.is_coach());
create policy coaches_admin on public.coaches for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- rates: own row or admin
create policy rates_read on public.coach_rates for select to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id());
create policy rates_admin on public.coach_rates for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- players: all coaches read (credits included); admin writes. Coaches may update profile notes only via player_notes.
create policy players_read on public.players for select to authenticated using (public.is_coach());
create policy players_admin on public.players for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ledger: coaches read (they see credits), only admin writes; nobody edits or deletes history
create policy ledger_read on public.credit_ledger for select to authenticated using (public.is_coach());
create policy ledger_insert on public.credit_ledger for insert to authenticated with check (public.is_admin());

-- sessions: all coaches read and log (for any player, any coach: cover sessions are normal).
-- A coach can edit or delete their own entry for 7 days; the admin always can.
create policy sessions_read on public.sessions for select to authenticated using (public.is_coach());
-- A coach logs under their own name (pay follows who coached); the admin can log for anyone.
create policy sessions_insert on public.sessions for insert to authenticated
  with check (public.is_coach() and not imported and (public.is_admin() or coach_id = public.current_coach_id()));
create policy sessions_update on public.sessions for update to authenticated
  using (public.is_admin() or (logged_by = auth.uid() and logged_at > now() - interval '7 days'))
  with check (public.is_admin() or (logged_by = auth.uid() and coach_id = public.current_coach_id()));
create policy sessions_delete on public.sessions for delete to authenticated
  using (public.is_admin() or (logged_by = auth.uid() and logged_at > now() - interval '7 days' and not imported));

create policy sp_read on public.session_players for select to authenticated using (public.is_coach());
create policy sp_write on public.session_players for insert to authenticated
  with check (exists (select 1 from public.sessions s where s.id = session_id
                       and (public.is_admin() or (s.logged_by = auth.uid() and s.logged_at > now() - interval '7 days'))));
create policy sp_delete on public.session_players for delete to authenticated
  using (exists (select 1 from public.sessions s where s.id = session_id
                  and (public.is_admin() or (s.logged_by = auth.uid() and s.logged_at > now() - interval '7 days'))));

-- notes: all coaches read and add; author or admin deletes
create policy notes_read on public.player_notes for select to authenticated using (public.is_coach());
create policy notes_insert on public.player_notes for insert to authenticated with check (public.is_coach());
create policy notes_delete on public.player_notes for delete to authenticated using (public.is_admin() or author = auth.uid());

-- payments: admin only
create policy payments_admin on public.payments for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- settings: coaches read, admin writes
create policy settings_read on public.settings for select to authenticated using (public.is_coach());
create policy settings_admin on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- grants
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.credit_usage, public.player_balances, public.coach_pay, public.payg_weeks,
               public.missing_sessions, public.late_logs to authenticated;
grant execute on function public.log_session, public.is_admin, public.is_coach, public.current_coach_id,
                          public.today_sydney, public.outcome_counts to authenticated;
revoke all on all tables in schema public from anon;
