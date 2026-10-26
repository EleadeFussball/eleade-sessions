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
