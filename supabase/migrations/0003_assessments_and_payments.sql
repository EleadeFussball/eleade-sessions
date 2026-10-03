-- Assessments, coach-recorded packages and payment confirmation.

-- ---------------------------------------------------------------- assessments
alter table public.sessions drop constraint if exists sessions_format_check;
alter table public.sessions add constraint sessions_format_check
  check (format in ('1:1', '2:1', '4:1', 'analysis', 'testing', 'assessment'));

-- Payment check for sessions charged on their own (assessments). Jan confirms.
alter table public.sessions
  add column payment_status text check (payment_status in ('awaiting', 'confirmed')),
  add column payment_method text check (payment_method in ('stripe', 'bank', 'cash', 'other')),
  add column payment_confirmed_by uuid,
  add column payment_confirmed_at timestamptz;

alter table public.coach_rates add column assessment numeric(8,2);  -- blank = the coach's 1:1 rate

insert into public.settings (key, value) values ('assessment_price', '130')
  on conflict (key) do nothing;

-- ---------------------------------------------------------------- package payments
alter table public.credit_ledger
  add column payment_status text not null default 'confirmed' check (payment_status in ('awaiting', 'confirmed')),
  add column payment_method text check (payment_method in ('stripe', 'bank', 'cash', 'other')),
  add column confirmed_by uuid,
  add column confirmed_at timestamptz;

-- A session paid on its own (assessment, or cash on the day) rather than from credits or the weekly transfer.
create or replace function public.charged_separately(p_format text, p_method text) returns boolean
language sql immutable set search_path = public as $$
  select p_format = 'assessment' or p_method = 'cash'
$$;

-- ---------------------------------------------------------------- stamps (who may set what)
create or replace function public.sessions_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_admin boolean := public.is_admin();
begin
  if tg_op = 'INSERT' then
    new.logged_by := coalesce(auth.uid(), new.logged_by);
    new.logged_at := coalesce(new.logged_at, now());
    if public.charged_separately(new.format, new.payment_method) and public.outcome_counts(new.outcome) then
      if not v_admin or new.payment_status is null then
        new.payment_status := 'awaiting';
        new.payment_confirmed_by := null;
        new.payment_confirmed_at := null;
      end if;
    else
      new.payment_status := null;
    end if;
  else
    new.logged_by := old.logged_by;
    new.logged_at := old.logged_at;
    new.imported  := old.imported;
    if not v_admin then
      new.payment_status := old.payment_status;
      new.payment_confirmed_by := old.payment_confirmed_by;
      new.payment_confirmed_at := old.payment_confirmed_at;
      -- an assessment changed to/from a charged outcome by the coach
      if public.charged_separately(new.format, new.payment_method) and public.outcome_counts(new.outcome) and new.payment_status is null then
        new.payment_status := 'awaiting';
      elsif not (public.charged_separately(new.format, new.payment_method) and public.outcome_counts(new.outcome)) and new.payment_status = 'awaiting' then
        new.payment_status := null;
      end if;
    end if;
  end if;
  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.payment_confirmed_by := auth.uid();
    new.payment_confirmed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.ledger_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not public.is_admin() and auth.uid() is not null then
      new.payment_status := 'awaiting';   -- a coach records it, Jan confirms it
    end if;
  else
    -- only the payment check may change on an existing ledger row
    new.player_id := old.player_id; new.kind := old.kind;
    new.sessions_delta := old.sessions_delta; new.analyses_delta := old.analyses_delta;
    new.package_name := old.package_name; new.amount_paid := old.amount_paid;
    new.reason := old.reason; new.effective_date := old.effective_date;
    new.expires_on := old.expires_on; new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists ledger_stamp on public.credit_ledger;
create trigger ledger_stamp before insert or update on public.credit_ledger
  for each row execute function public.ledger_stamp();
revoke execute on function public.ledger_stamp() from public, anon, authenticated;
revoke execute on function public.sessions_stamp() from public, anon, authenticated;

-- ---------------------------------------------------------------- access rules
-- Coaches may record a package bought (never free sessions or corrections).
drop policy if exists ledger_insert on public.credit_ledger;
create policy ledger_insert on public.credit_ledger for insert to authenticated
  with check (public.is_admin() or (public.is_coach() and kind = 'purchase' and sessions_delta >= 0 and analyses_delta >= 0));
create policy ledger_confirm on public.credit_ledger for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Coaches may add a new player (for an assessment). Everything else about players stays with Jan.
create policy players_coach_insert on public.players for insert to authenticated
  with check (public.is_coach() and active and not opening_confirmed);

-- ---------------------------------------------------------------- logic
drop function if exists public.log_session(date, uuid, text, text, uuid[], text, time, text, text, text);
create function public.log_session(
  p_session_date date, p_coach_id uuid, p_format text, p_outcome text,
  p_player_ids uuid[], p_location text default null, p_start_time time default null,
  p_topic text default null, p_observations text default null, p_improve text default null,
  p_payment_method text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_expected int := case p_format when '2:1' then 2 when '4:1' then 4 else null end;
begin
  if p_player_ids is null or array_length(p_player_ids, 1) is null then
    raise exception 'Pick at least one player';
  end if;
  if p_format in ('1:1', 'analysis', 'assessment') and array_length(p_player_ids, 1) <> 1 then
    raise exception 'A % session has exactly one player', p_format;
  end if;
  if v_expected is not null and array_length(p_player_ids, 1) > v_expected then
    raise exception 'A % session has at most % players', p_format, v_expected;
  end if;
  if p_session_date > public.today_sydney() then
    raise exception 'Session date is in the future';
  end if;
  insert into public.sessions (session_date, start_time, coach_id, format, outcome, location, topic, observations, improve, payment_method)
  values (p_session_date, p_start_time, p_coach_id, p_format, p_outcome, p_location, p_topic, p_observations, p_improve,
          p_payment_method)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, unnest(p_player_ids);
  return v_id;
end $$;
revoke execute on function public.log_session(date, uuid, text, text, uuid[], text, time, text, text, text, text) from public, anon;
grant execute on function public.log_session(date, uuid, text, text, uuid[], text, time, text, text, text, text) to authenticated;

-- Assessments never use package credits.
create or replace view public.credit_usage with (security_invoker = true) as
select sp.player_id, s.id as session_id, s.session_date, s.format, s.outcome,
       case when s.format in ('1:1', '2:1', '4:1') then 1 else 0 end as sessions_used,
       case when s.format = 'analysis' then 1 else 0 end as analyses_used
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
 where not s.imported
   and public.outcome_counts(s.outcome)
   and s.format not in ('testing', 'assessment')
   and s.payment_method is distinct from 'cash';

-- Assessment pay: the coach's assessment rate, or their 1:1 rate when none is set.
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
                   when 'assessment' then coalesce(r.assessment, r.one_to_one)
                 end
       end as pay
  from public.sessions s
  join public.coaches c on c.id = s.coach_id
  join public.coach_rates r on r.coach_id = s.coach_id
 where not s.imported;

-- Weekly payers: assessments are charged separately, not in the weekly total.
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
     and s.format not in ('testing', 'assessment') and s.payment_method is distinct from 'cash'
     and p.billing_model = 'pay_per_session'
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

-- Everything waiting for Jan to confirm a payment: assessments and coach-recorded packages.
create or replace view public.payments_to_confirm with (security_invoker = true) as
select 'session'::text as kind, s.id as item_id, sp.player_id, p.name, s.session_date as item_date,
       case when s.format = 'assessment' then 'Assessment' else 'Session paid in cash' end as what,
       case when s.format = 'assessment'
            then (select (value #>> '{}')::numeric from public.settings where key = 'assessment_price')
            else coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))
       end as amount,
       s.payment_method, c.name as recorded_by
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
  join public.players p on p.id = sp.player_id
  join public.coaches c on c.id = s.coach_id
 where s.payment_status = 'awaiting' and public.is_admin()
union all
select 'package', l.id, l.player_id, p.name, l.effective_date,
       coalesce(l.package_name, 'Package'), l.amount_paid, l.payment_method,
       (select name from public.coaches where user_id = l.created_by)
  from public.credit_ledger l
  join public.players p on p.id = l.player_id
 where l.payment_status = 'awaiting' and public.is_admin();

revoke update on public.credit_ledger from authenticated;
grant update (payment_status, payment_method) on public.credit_ledger to authenticated;
grant select on public.payments_to_confirm, public.credit_usage, public.coach_pay, public.payg_weeks to authenticated;
