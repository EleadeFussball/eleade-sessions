-- Stopping a regular session: every session from now on disappears.
-- Today's session is kept only if it has already started or been logged (it then still needs confirming).
create or replace function public.stop_plan(p_plan_id uuid) returns date
language plpgsql security invoker set search_path = public as $$
declare
  v public.session_plans%rowtype;
  v_today date := public.today_sydney();
  v_now time := (now() at time zone 'Australia/Sydney')::time;
  v_last date;
begin
  select * into v from public.session_plans where id = p_plan_id;
  if not found or not public.can_manage_plan(p_plan_id) then
    raise exception 'Regular session not found, or it is not yours to stop';
  end if;
  v_last := case
    when exists (select 1 from public.sessions where plan_id = p_plan_id and plan_date = v_today)
      or (extract(isodow from v_today)::int = v.weekday and v.start_time <= v_now and v_today >= v.starts_on)
    then v_today else v_today - 1 end;
  v_last := greatest(v_last, v.starts_on - 1);
  if v.ends_on is not null and v.ends_on < v_last then v_last := v.ends_on; end if;
  update public.session_plans set ends_on = v_last where id = p_plan_id;
  return v_last;
end $$;

revoke execute on function public.stop_plan(uuid) from public, anon;
grant execute on function public.stop_plan(uuid) to authenticated;
