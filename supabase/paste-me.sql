-- How each player pays: monthly package, casual package (5/10), pays weekly, or casual (pays per session).
-- billing_model (package / pay_per_session) and monthly_recurring follow the plan automatically.

alter table public.players add column if not exists payment_plan text;
alter table public.players add column if not exists casual_method text check (casual_method in ('stripe', 'cash', 'bank'));
update public.players set payment_plan = case when billing_model = 'pay_per_session' then 'weekly'
                                              when monthly_recurring then 'monthly' else 'package' end
 where payment_plan is null;
alter table public.players alter column payment_plan set default 'package';
alter table public.players alter column payment_plan set not null;
alter table public.players drop constraint if exists players_payment_plan_check;
alter table public.players add constraint players_payment_plan_check check (payment_plan in ('monthly', 'package', 'weekly', 'casual'));

create or replace function public.players_payment_plan() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.payment_plan is distinct from old.payment_plan then
    -- the plan was chosen: set the older fields from it (credits are never touched, so they carry over)
    if tg_op = 'INSERT' and new.payment_plan = 'package' then
      -- created by an older screen that only sets billing_model / monthly_recurring
      if new.billing_model = 'pay_per_session' then new.payment_plan := 'weekly';
      elsif coalesce(new.monthly_recurring, false) then new.payment_plan := 'monthly'; end if;
    end if;
    new.billing_model := case when new.payment_plan in ('monthly', 'package') then 'package' else 'pay_per_session' end;
    new.monthly_recurring := new.payment_plan = 'monthly';
  elsif new.billing_model is distinct from old.billing_model or new.monthly_recurring is distinct from old.monthly_recurring then
    -- older screens change billing_model (e.g. recording a package for a weekly payer)
    new.payment_plan := case when new.billing_model = 'pay_per_session' then case when old.payment_plan = 'casual' then 'casual' else 'weekly' end
                             when new.monthly_recurring then 'monthly' else 'package' end;
  end if;
  if new.payment_plan <> 'casual' then new.casual_method := null; end if;
  return new;
end $$;
drop trigger if exists players_payment_plan on public.players;
create trigger players_payment_plan before insert or update on public.players
  for each row execute function public.players_payment_plan();

create or replace view public.player_balances with (security_invoker = true) as
with led as (
  select player_id, sum(sessions_delta) s, sum(analyses_delta) a, sum(pairs_delta) pr,
         max(effective_date) filter (where kind = 'purchase') last_purchase,
         min(expires_on) filter (where expires_on >= public.today_sydney()) next_expiry
    from public.credit_ledger group by player_id
), used as (
  select player_id, sum(sessions_used) s, sum(analyses_used) a, sum(pairs_used) pr from public.credit_usage group by player_id
), last_s as (
  select sp.player_id, max(s.session_date) last_session
    from public.sessions s join public.session_players sp on sp.session_id = s.id
   where s.outcome = 'attended' group by sp.player_id
), per_player as (
  select p.id as player_id, p.name, p.family, p.billing_model, p.active, p.main_coach_id, p.opening_confirmed,
         p.payment_plan, p.casual_method,
         case when p.billing_model = 'package' then coalesce(led.s, 0) - coalesce(used.s, 0) end as own_sessions_left,
         case when p.billing_model = 'package' then coalesce(led.a, 0) - coalesce(used.a, 0) end as own_analyses_left,
         coalesce(used.s, 0) as sessions_used_live,
         led.last_purchase, led.next_expiry, last_s.last_session,
         case when p.billing_model = 'package' then coalesce(led.pr, 0) - coalesce(used.pr, 0) end as own_pairs_left,
         coalesce(led.pr, 0) <> 0 as own_has_pairs
    from public.players p
    left join led on led.player_id = p.id
    left join used on used.player_id = p.id
    left join last_s on last_s.player_id = p.id
)
select pp.player_id, pp.name, pp.family, pp.billing_model, pp.active, pp.main_coach_id, pp.opening_confirmed,
       pp.own_sessions_left, pp.own_analyses_left, pp.sessions_used_live, pp.last_purchase, pp.next_expiry, pp.last_session,
       case when pp.family is null then pp.own_sessions_left
            else sum(pp.own_sessions_left) over (partition by pp.family) end as sessions_left,
       case when pp.family is null then pp.own_analyses_left
            else sum(pp.own_analyses_left) over (partition by pp.family) end as analyses_left,
       case when not (case when pp.family is null then pp.own_has_pairs
                           else bool_or(pp.own_has_pairs) over (partition by pp.family) end) then null
            when pp.family is null then pp.own_pairs_left
            else sum(pp.own_pairs_left) over (partition by pp.family) end as pairs_left,
       pp.payment_plan, pp.casual_method
  from per_player pp;

-- Weekly payers only (a casual player pays each session on its own)
create or replace view public.payg_weeks with (security_invoker = true) as
with charges as (
  select sp.player_id,
         (s.session_date - ((extract(isodow from s.session_date))::integer - 1)) as week_start,
         count(*) as sessions,
         sum(public.player_price(sp.player_id, s.format)) as owed
    from public.sessions s
    join public.session_players sp on sp.session_id = s.id
    join public.players p_1 on p_1.id = sp.player_id
   where not s.imported and public.outcome_counts(s.outcome)
     and s.format <> all (array['testing', 'assessment'])
     and s.payment_method is null and p_1.billing_model = 'pay_per_session' and p_1.payment_plan = 'weekly'
   group by sp.player_id, (s.session_date - ((extract(isodow from s.session_date))::integer - 1))
), paid as (
  select payments.player_id, payments.week_start, sum(payments.amount) as amount
    from public.payments group by payments.player_id, payments.week_start
)
select c.player_id, p.name, p.family, c.week_start, c.sessions, c.owed,
       coalesce(paid.amount, 0::numeric) as paid,
       c.owed - coalesce(paid.amount, 0::numeric) as outstanding
  from charges c
  join public.players p on p.id = c.player_id
  left join paid on paid.player_id = c.player_id and paid.week_start = c.week_start
 where public.is_admin();
-- 1. Player details from the website form: parent's name, date of birth (age group shown from it), email, phone, club.
-- 2. Feedback every two months: the main coach writes three short dot-point fields, Jan sends it to the parents.

-- ---------- player details ----------
alter table public.players add column if not exists parent_name text;
alter table public.players add column if not exists dob date;
alter table public.players add column if not exists email text;
alter table public.players add column if not exists phone text;
alter table public.players add column if not exists club text;
alter table public.players add column if not exists position text;
alter table public.players add column if not exists foot text;
alter table public.players add column if not exists heard_from text;
alter table public.players add column if not exists form_age_group text;   -- the age group as given on the form
alter table public.players add column if not exists enquiry_id uuid;       -- the website form the player came from

-- Training videos marked as good for social media are also copied to one shared folder.
alter table public.drive_clips add column if not exists social boolean not null default false;
alter table public.drive_clips add column if not exists social_file_id text;
alter table public.drive_connection add column if not exists social_folder_id text;

-- Coaches see the age group and club in the player list
create or replace view public.player_balances with (security_invoker = true) as
with led as (
  select player_id, sum(sessions_delta) s, sum(analyses_delta) a, sum(pairs_delta) pr,
         max(effective_date) filter (where kind = 'purchase') last_purchase,
         min(expires_on) filter (where expires_on >= public.today_sydney()) next_expiry
    from public.credit_ledger group by player_id
), used as (
  select player_id, sum(sessions_used) s, sum(analyses_used) a, sum(pairs_used) pr from public.credit_usage group by player_id
), last_s as (
  select sp.player_id, max(s.session_date) last_session
    from public.sessions s join public.session_players sp on sp.session_id = s.id
   where s.outcome = 'attended' group by sp.player_id
), per_player as (
  select p.id as player_id, p.name, p.family, p.billing_model, p.active, p.main_coach_id, p.opening_confirmed,
         p.payment_plan, p.casual_method, p.dob, p.club,
         case when p.billing_model = 'package' then coalesce(led.s, 0) - coalesce(used.s, 0) end as own_sessions_left,
         case when p.billing_model = 'package' then coalesce(led.a, 0) - coalesce(used.a, 0) end as own_analyses_left,
         coalesce(used.s, 0) as sessions_used_live,
         led.last_purchase, led.next_expiry, last_s.last_session,
         case when p.billing_model = 'package' then coalesce(led.pr, 0) - coalesce(used.pr, 0) end as own_pairs_left,
         coalesce(led.pr, 0) <> 0 as own_has_pairs
    from public.players p
    left join led on led.player_id = p.id
    left join used on used.player_id = p.id
    left join last_s on last_s.player_id = p.id
)
select pp.player_id, pp.name, pp.family, pp.billing_model, pp.active, pp.main_coach_id, pp.opening_confirmed,
       pp.own_sessions_left, pp.own_analyses_left, pp.sessions_used_live, pp.last_purchase, pp.next_expiry, pp.last_session,
       case when pp.family is null then pp.own_sessions_left
            else sum(pp.own_sessions_left) over (partition by pp.family) end as sessions_left,
       case when pp.family is null then pp.own_analyses_left
            else sum(pp.own_analyses_left) over (partition by pp.family) end as analyses_left,
       case when not (case when pp.family is null then pp.own_has_pairs
                           else bool_or(pp.own_has_pairs) over (partition by pp.family) end) then null
            when pp.family is null then pp.own_pairs_left
            else sum(pp.own_pairs_left) over (partition by pp.family) end as pairs_left,
       pp.payment_plan, pp.casual_method, pp.dob, pp.club
  from per_player pp;

-- Dates of birth arrive as "2008-04-05", "29 January 2007" or "05/02/2013".
create or replace function public.parse_dob(p text) returns date
language plpgsql immutable as $$
declare t text := trim(coalesce(p, '')); d date;
begin
  if t = '' then return null; end if;
  begin
    if t ~ '^\d{4}-\d{1,2}-\d{1,2}' then d := substring(t from '^\d{4}-\d{1,2}-\d{1,2}')::date;
    elsif t ~ '^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$' then d := to_date(regexp_replace(t, '[.-]', '/', 'g'), 'DD/MM/YYYY');
    elsif t ~* '^\d{1,2}\s+[a-z]+\s+\d{4}$' then d := to_date(t, 'FMDD FMMonth YYYY');
    else return null;
    end if;
  exception when others then return null;
  end;
  if d < date '1950-01-01' or d > current_date then return null; end if;
  return d;
end $$;

-- Copy the form details onto the player (only where the player has none yet).
create or replace function public.copy_enquiry_details(p_enquiry_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.players p
     set parent_name = coalesce(p.parent_name, nullif(trim(e.parent_name), '')),
         dob = coalesce(p.dob, public.parse_dob(e.dob)),
         email = coalesce(p.email, nullif(trim(coalesce(e.parent_email, e.email)), '')),
         phone = coalesce(p.phone, nullif(trim(coalesce(e.parent_phone, e.phone)), '')),
         club = coalesce(p.club, nullif(trim(e.club), '')),
         position = coalesce(p.position, nullif(trim(e.position), '')),
         foot = coalesce(p.foot, nullif(trim(e.foot), '')),
         heard_from = coalesce(p.heard_from, nullif(trim(e.heard_from), '')),
         form_age_group = coalesce(p.form_age_group, nullif(trim(e.age_group), '')),
         enquiry_id = coalesce(p.enquiry_id, e.id)
    from public.enquiries e
   where e.id = p_enquiry_id and p.id = e.player_id
$$;

create or replace function public.enquiry_make_player(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e public.enquiries%rowtype;
  v_name text;
  v_player uuid;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  select * into e from public.enquiries where id = p_id for update;
  if not found then raise exception 'Enquiry not found'; end if;
  if e.player_id is not null then perform public.copy_enquiry_details(p_id); return e.player_id; end if;
  v_name := trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
  if v_name = '' then raise exception 'The enquiry has no player name'; end if;
  select id into v_player from public.players where lower(name) = lower(v_name);
  if v_player is null then
    insert into public.players (name, main_coach_id, created_by)
    values (v_name, e.coach_id, auth.uid()) returning id into v_player;
  end if;
  update public.enquiries set player_id = v_player where id = p_id;
  perform public.copy_enquiry_details(p_id);
  return v_player;
end $$;

-- players already created from an enquiry
select public.copy_enquiry_details(id) from public.enquiries where player_id is not null;

-- Any coach can keep the details up to date.
create or replace function public.save_player_details(p_player_id uuid, p_parent_name text, p_dob date, p_email text, p_phone text, p_club text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  if p_dob is not null and (p_dob < date '1950-01-01' or p_dob > public.today_sydney()) then raise exception 'Check the date of birth'; end if;
  update public.players
     set parent_name = nullif(trim(p_parent_name), ''), dob = p_dob, email = nullif(lower(trim(p_email)), ''),
         phone = nullif(trim(p_phone), ''), club = nullif(trim(p_club), '')
   where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;
end $$;

-- ---------- feedback every two months ----------
insert into public.settings (key, value) values ('feedback_from', '"2026-09-01"') on conflict (key) do nothing;

create table if not exists public.player_feedback (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.players(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  coach_id     uuid references public.coaches(id),
  progress     text,
  focus        text,
  homework     text,
  updated_at   timestamptz not null default now(),
  sent_at      timestamptz,
  sent_by      uuid,
  unique (player_id, period_start)
);
alter table public.player_feedback enable row level security;
drop policy if exists player_feedback_read on public.player_feedback;
create policy player_feedback_read on public.player_feedback for select to authenticated using (public.is_coach());
grant select on public.player_feedback to authenticated;

-- Two-month periods: Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec. Feedback is due from the 25th of the second month.
create or replace function public.feedback_periods() returns table (period_start date, period_end date, due_on date)
language sql stable set search_path = public as $$
  select s::date, (s + interval '2 months' - interval '1 day')::date, (s + interval '1 month' + interval '24 days')::date
    from generate_series(
           date_trunc('month', coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_from'), date '2026-09-01')),
           public.today_sydney(), interval '2 months') s
   where (s + interval '1 month' + interval '24 days')::date <= public.today_sydney()
$$;

-- Players a coach still has to write feedback for: trained in the period, main coach (or the last coach if none).
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
     and not exists (select 1 from public.player_feedback fb where fb.player_id = t.player_id and fb.period_start = t.period_start
                       and nullif(trim(coalesce(fb.progress, '') || coalesce(fb.focus, '') || coalesce(fb.homework, '')), '') is not null)
   order by t.period_start, p.name
$$;

-- Jan: every player due for the latest periods, with the feedback and the parent's details.
create or replace function public.feedback_overview()
returns table (player_id uuid, name text, period_start date, period_end date, coach_name text,
               parent_name text, email text, phone text, feedback_id uuid, progress text, focus text, homework text,
               sent_at timestamptz, status text)
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
   order by t.period_start desc, 14 desc, p.name
$$;

create or replace function public.save_feedback(p_player_id uuid, p_period_start date, p_progress text, p_focus text, p_homework text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_end date;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  select period_end into v_end from public.feedback_periods() where period_start = p_period_start;
  if v_end is null then v_end := (p_period_start + interval '2 months' - interval '1 day')::date; end if;
  if nullif(trim(coalesce(p_progress, '') || coalesce(p_focus, '') || coalesce(p_homework, '')), '') is null then
    raise exception 'Add at least one point';
  end if;
  insert into public.player_feedback (player_id, period_start, period_end, coach_id, progress, focus, homework)
  values (p_player_id, p_period_start, v_end, public.current_coach_id(), nullif(trim(p_progress), ''), nullif(trim(p_focus), ''), nullif(trim(p_homework), ''))
  on conflict (player_id, period_start) do update
    set progress = excluded.progress, focus = excluded.focus, homework = excluded.homework,
        coach_id = coalesce(excluded.coach_id, public.player_feedback.coach_id), updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.feedback_sent(p_id uuid, p_sent boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  update public.player_feedback set sent_at = case when p_sent then now() end, sent_by = case when p_sent then auth.uid() end where id = p_id;
end $$;

revoke execute on function public.copy_enquiry_details(uuid), public.save_player_details(uuid, text, date, text, text, text),
  public.feedback_due(uuid), public.feedback_overview(), public.save_feedback(uuid, date, text, text, text),
  public.feedback_sent(uuid, boolean) from public, anon;
grant execute on function public.save_player_details(uuid, text, date, text, text, text), public.feedback_periods(),
  public.feedback_due(uuid), public.feedback_overview(), public.save_feedback(uuid, date, text, text, text),
  public.feedback_sent(uuid, boolean), public.parse_dob(text) to authenticated;

-- After a clip is copied to the social media folder.
create or replace function public.mark_clip_social(p_clip_id uuid, p_file_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  update public.drive_clips set social = true, social_file_id = nullif(p_file_id, '') where id = p_clip_id;
end $$;
create or replace function public.set_social_folder(p_folder_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  update public.drive_connection set social_folder_id = p_folder_id where id = 1 and social_folder_id is null;
end $$;
create or replace function public.social_folder() returns text
language sql stable security definer set search_path = public as $$
  select social_folder_id from public.drive_connection where id = 1 and public.is_coach()
$$;
revoke execute on function public.mark_clip_social(uuid, text), public.set_social_folder(text), public.social_folder() from public, anon;
grant execute on function public.mark_clip_social(uuid, text), public.set_social_folder(text), public.social_folder() to authenticated;
