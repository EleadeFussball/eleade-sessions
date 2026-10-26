-- Paste this whole file into the Supabase SQL Editor and run it once.
-- Part 1: change a regular session going forward (0045). Part 2: casual players never use package credit (0047).

-- Change a regular (weekly) session going forward: a new day, time, length or place from a chosen date.
-- Sessions before that date stay exactly as they are. Behind the scenes the old plan ends the day before
-- and an identical new one starts (same coach, type and players), so history, invoices and credits are untouched.

create or replace function public.change_plan(
  p_plan_id uuid, p_from date, p_weekday int, p_start_time time, p_minutes int default null, p_location text default null
) returns uuid
language plpgsql set search_path = public as $$
declare
  v public.session_plans%rowtype;
  v_new uuid;
  v_loc text := nullif(trim(p_location), '');
  v_used boolean;
begin
  select * into v from public.session_plans where id = p_plan_id;
  if not found or not public.can_manage_plan(p_plan_id) then
    raise exception 'Regular session not found, or it is not yours to change';
  end if;
  if p_weekday is null or p_weekday not between 1 and 7 then raise exception 'Pick a day'; end if;
  if p_start_time is null then raise exception 'Add a start time'; end if;
  if p_from is null or p_from < public.today_sydney() then
    raise exception 'Choose today or a later date for the change to start';
  end if;
  if v.ends_on is not null and v.ends_on < p_from then
    raise exception 'That regular session has already ended';
  end if;
  if exists (select 1 from public.sessions where plan_id = p_plan_id and plan_date >= p_from) then
    raise exception 'Sessions from that date are already logged. Choose a later date.';
  end if;

  -- nothing has happened on this plan yet: just edit it
  v_used := exists (select 1 from public.sessions where plan_id = p_plan_id)
         or exists (select 1 from public.invoice_lines where planned_ref = p_plan_id)
         or exists (select 1 from public.plan_changes where plan_id = p_plan_id);
  if p_from <= v.starts_on and not v_used then
    update public.session_plans
       set weekday = p_weekday, start_time = p_start_time, minutes = coalesce(p_minutes, minutes), location = v_loc
     where id = p_plan_id;
    return p_plan_id;
  end if;

  update public.session_plans set ends_on = greatest(p_from - 1, starts_on - 1) where id = p_plan_id;
  insert into public.session_plans (coach_id, format, weekday, start_time, location, starts_on, ends_on, minutes, created_by)
  values (v.coach_id, v.format, p_weekday, p_start_time, v_loc, p_from, v.ends_on, coalesce(p_minutes, v.minutes), auth.uid())
  returning id into v_new;
  insert into public.plan_players (plan_id, player_id) select v_new, player_id from public.plan_players where plan_id = p_plan_id;
  return v_new;
end $$;

grant execute on function public.change_plan(uuid, date, int, time, int, text) to authenticated;

-- Casual players (a few sessions here and there, no package) are never logged as "package credit".
-- Every counted session for a casual player gets a payment method: the way that player is set to pay,
-- or "Other" when they pay Jan directly (new option "Pays Jan directly").
-- Sessions with no method used to take a package credit; for a casual player that left the session
-- unpaid and invisible. Now it shows as awaiting payment until Jan confirms it.

alter table public.players drop constraint if exists players_casual_method_check;
alter table public.players add constraint players_casual_method_check
  check (casual_method is null or casual_method in ('stripe', 'cash', 'bank', 'other'));

-- The payment method every player on the session is set to, or null when any player is not casual.
create or replace function public.casual_session_method(p_session uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
           when count(*) = 0 or bool_or(p.payment_plan is distinct from 'casual') then null
           when count(p.casual_method) = count(*) and count(distinct p.casual_method) = 1 then min(p.casual_method)
           else 'other'
         end
    from public.session_players sp join public.players p on p.id = sp.player_id
   where sp.session_id = p_session
$$;
revoke execute on function public.casual_session_method(uuid) from public, anon, authenticated;

-- New session: the players are added right after the session row.
create or replace function public.casual_default_on_player() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.sessions s set payment_method = public.casual_session_method(s.id)
   where s.id = new.session_id and s.payment_method is null and not s.imported
     and s.format not in ('testing', 'assessment') and public.outcome_counts(s.outcome)
     and public.casual_session_method(s.id) is not null;
  return null;
end $$;
revoke execute on function public.casual_default_on_player() from public, anon, authenticated;
drop trigger if exists session_players_casual on public.session_players;
create trigger session_players_casual after insert on public.session_players
  for each row execute function public.casual_default_on_player();

-- Existing session changed (outcome confirmed, "package credit" picked again, players edited).
create or replace function public.sessions_casual_default() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_method text;
begin
  if new.payment_method is null and not new.imported and new.format not in ('testing', 'assessment')
     and public.outcome_counts(new.outcome) then
    v_method := public.casual_session_method(new.id);
    if v_method is not null then new.payment_method := v_method; end if;
  end if;
  return new;
end $$;
revoke execute on function public.sessions_casual_default() from public, anon, authenticated;
drop trigger if exists sessions_a_casual on public.sessions;
create trigger sessions_a_casual before update on public.sessions
  for each row execute function public.sessions_casual_default();

-- Sessions already logged without a method for a casual player.
do $$
begin
  perform set_config('eleade.system', 'on', true);
  update public.sessions s set payment_method = public.casual_session_method(s.id)
   where s.payment_method is null and not s.imported and s.format not in ('testing', 'assessment')
     and public.outcome_counts(s.outcome) and public.casual_session_method(s.id) is not null;
end $$;
