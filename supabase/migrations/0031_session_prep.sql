-- Coaches can plan a session before it happens. The plan becomes "What you worked on" when the session is confirmed.

create table if not exists public.session_prep (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  plan_id uuid references public.session_plans(id) on delete cascade,
  plan_date date,
  topic text not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check ((booking_id is not null and plan_id is null and plan_date is null)
      or (booking_id is null and plan_id is not null and plan_date is not null))
);
create unique index if not exists session_prep_booking on public.session_prep (booking_id) where booking_id is not null;
create unique index if not exists session_prep_plan on public.session_prep (plan_id, plan_date) where plan_id is not null;
alter table public.session_prep enable row level security;
drop policy if exists session_prep_read on public.session_prep;
create policy session_prep_read on public.session_prep for select to authenticated using (public.is_coach());
grant select on public.session_prep to authenticated;
grant select on public.session_prep to service_role;

-- Save (or clear, with an empty text) the plan for a planned session. Only its coach or Jan.
create or replace function public.save_prep(p_kind text, p_ref_id uuid, p_plan_date date, p_topic text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_coach uuid;
  v_topic text := nullif(trim(p_topic), '');
begin
  if p_kind = 'once' then
    select coach_id into v_coach from public.bookings where id = p_ref_id;
  elsif p_kind = 'regular' then
    select coach_id into v_coach from public.session_plans where id = p_ref_id;
    if p_plan_date is null then raise exception 'Missing date'; end if;
  else
    raise exception 'Only planned sessions can have a plan';
  end if;
  if v_coach is null then raise exception 'Session not found'; end if;
  if not (public.is_admin() or v_coach = public.current_coach_id()) then
    raise exception 'You can only plan your own sessions';
  end if;

  if p_kind = 'once' then
    delete from public.session_prep where booking_id = p_ref_id;
    if v_topic is not null then
      insert into public.session_prep (booking_id, topic, updated_by) values (p_ref_id, v_topic, auth.uid());
    end if;
  else
    delete from public.session_prep where plan_id = p_ref_id and plan_date = p_plan_date;
    if v_topic is not null then
      insert into public.session_prep (plan_id, plan_date, topic, updated_by) values (p_ref_id, p_plan_date, v_topic, auth.uid());
    end if;
  end if;
end $$;
revoke all on function public.save_prep(text, uuid, date, text) from public, anon;
grant execute on function public.save_prep(text, uuid, date, text) to authenticated;
