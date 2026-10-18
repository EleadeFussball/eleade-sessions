-- 1. Documentation: coaches see every attended session still missing "What you worked on" and fill it in on the spot.
--    From Monday 19 October an invoice cannot be sent while one of its sessions is missing it.
-- 2. Training videos: every 4 to 6 weeks (varied per player) the main coach uploads a short clip of each player.
-- 3. Admin hours: coaches add hours (e.g. 1 or 1.5) at $30 an hour; they appear on their next invoice.

insert into public.settings (key, value) values
  ('docs_required_from', '"2026-10-19"'), ('docs_reminder_from', '"2026-10-05"'),
  ('videos_from', '"2026-10-18"'), ('admin_hour_rate', '30')
on conflict (key) do nothing;

create or replace function public.docs_required_from() returns date
language sql stable set search_path = public as $$
  select coalesce((select (value #>> '{}')::date from public.settings where key = 'docs_required_from'), date '2026-10-19')
$$;

-- Attended sessions of a coach still missing "What you worked on" (testing and cancellations need none).
create or replace function public.undocumented_sessions(p_coach_id uuid)
returns table (session_id uuid, session_date date, start_time time, format text, players text)
language sql stable security definer set search_path = public as $$
  select s.id, s.session_date, s.start_time, s.format,
         (select string_agg(p.name, ', ' order by p.name) from public.session_players sp
            join public.players p on p.id = sp.player_id where sp.session_id = s.id)
    from public.sessions s
   where s.coach_id = p_coach_id and not s.imported and s.outcome = 'attended'
     and s.format in ('1:1', '2:1', '4:1', 'assessment', 'analysis')
     and nullif(trim(s.topic), '') is null
     and s.session_date <= public.today_sydney()
     and s.session_date >= coalesce((select (value #>> '{}')::date from public.settings where key = 'docs_reminder_from'), date '2026-10-05')
     and (public.is_admin() or p_coach_id = public.current_coach_id())
   order by s.session_date, s.start_time
$$;

-- Notes for one session, from the list (no 30-day limit: catching up on documentation is always allowed).
create or replace function public.save_session_notes(p_session_id uuid, p_topic text, p_observations text default null, p_improve text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.sessions%rowtype;
begin
  select * into v_s from public.sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  if not (public.is_admin() or v_s.coach_id = public.current_coach_id()) then raise exception 'You can only document your own sessions'; end if;
  if nullif(trim(p_topic), '') is null then raise exception 'Add what you worked on'; end if;
  update public.sessions
     set topic = trim(p_topic),
         observations = coalesce(nullif(trim(p_observations), ''), observations),
         improve = coalesce(nullif(trim(p_improve), ''), improve)
   where id = p_session_id;
end $$;

-- Training videos due: one per player, for the player's main coach (or the last coach if none).
-- Next due 4 to 6 weeks after the last clip (the first round counts from 18 October), varied per player.
create or replace function public.videos_due(p_coach_id uuid)
returns table (player_id uuid, name text, due_on date, last_clip date, drive_folder_id text)
language sql stable security definer set search_path = public as $$
  with recent as (
    select sp.player_id, max(s.session_date) as last_session,
           (array_agg(s.coach_id order by s.session_date desc))[1] as last_coach
      from public.sessions s join public.session_players sp on sp.session_id = s.id
     where s.outcome = 'attended' and not s.imported and s.session_date >= public.today_sydney() - 42
       and s.format in ('1:1', '2:1', '4:1')
     group by sp.player_id
  ), base as (
    select p.id, p.name, p.drive_folder_id, coalesce(p.main_coach_id, r.last_coach) as coach_id,
           (select max(c.created_at at time zone 'Australia/Sydney')::date from public.drive_clips c where c.player_id = p.id) as last_clip
      from public.players p join recent r on r.player_id = p.id
     where p.active
  )
  select b.id, b.name,
         greatest(coalesce(b.last_clip, (select (value #>> '{}')::date from public.settings where key = 'videos_from'))
                  , coalesce((select (value #>> '{}')::date from public.settings where key = 'videos_from'), date '2026-10-18'))
           + 28 + (abs(hashtext(b.id::text || coalesce(b.last_clip::text, ''))) % 15) as due_on,
         b.last_clip, b.drive_folder_id
    from base b
   where b.coach_id = p_coach_id and (public.is_admin() or p_coach_id = public.current_coach_id())
   order by 3, 2
$$;

-- ---------- admin hours ----------
create table if not exists public.admin_hours (
  id         uuid primary key default gen_random_uuid(),
  coach_id   uuid not null references public.coaches(id),
  work_date  date not null,
  hours      numeric(4,2) not null check (hours > 0 and hours <= 12 and hours * 4 = round(hours * 4)),
  rate       numeric(10,2) not null,
  note       text,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.admin_hours enable row level security;
drop policy if exists admin_hours_read on public.admin_hours;
create policy admin_hours_read on public.admin_hours for select to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id());
grant select on public.admin_hours to authenticated;

alter table public.invoice_lines add column if not exists admin_hours_id uuid;

create or replace function public.add_admin_hours(p_work_date date, p_hours numeric, p_note text default null, p_coach_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_coach uuid := coalesce(case when public.is_admin() then p_coach_id end, public.current_coach_id()); v_id uuid;
begin
  if v_coach is null then raise exception 'Sign in as a coach'; end if;
  if (select salaried from public.coaches where id = v_coach) then raise exception 'Salaried coaches do not invoice admin hours'; end if;
  if p_work_date > public.today_sydney() then raise exception 'Admin hours can only be added once they are done'; end if;
  if p_hours is null or p_hours <= 0 or p_hours > 12 or p_hours * 4 <> round(p_hours * 4) then
    raise exception 'Hours in quarter steps, for example 1, 1.5 or 2.25';
  end if;
  insert into public.admin_hours (coach_id, work_date, hours, rate, note, created_by)
  values (v_coach, p_work_date, p_hours,
          coalesce((select (value #>> '{}')::numeric from public.settings where key = 'admin_hour_rate'), 30),
          nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Removable until it is on an invoice Jan has paid (an unpaid invoice is then updated by the coach).
create or replace function public.remove_admin_hours(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v public.admin_hours%rowtype;
begin
  select * into v from public.admin_hours where id = p_id;
  if not found then raise exception 'Not found'; end if;
  if not (public.is_admin() or v.coach_id = public.current_coach_id()) then raise exception 'You can only remove your own hours'; end if;
  if exists (select 1 from public.invoice_lines il join public.coach_invoices ci on ci.id = il.invoice_id
              where il.admin_hours_id = p_id) then
    raise exception 'These hours are already on an invoice. Ask Jan to change it';
  end if;
  delete from public.admin_hours where id = p_id;
end $$;

revoke execute on function public.undocumented_sessions(uuid), public.save_session_notes(uuid, text, text, text),
  public.videos_due(uuid), public.add_admin_hours(date, numeric, text, uuid), public.remove_admin_hours(uuid) from public, anon;
grant execute on function public.undocumented_sessions(uuid), public.save_session_notes(uuid, text, text, text),
  public.videos_due(uuid), public.add_admin_hours(date, numeric, text, uuid), public.remove_admin_hours(uuid),
  public.docs_required_from() to authenticated;

drop function if exists public.invoice_draft(uuid, date);
create function public.invoice_draft(p_coach_id uuid, p_until date)
returns table (session_id uuid, line_date date, description text, amount numeric, is_correction boolean, no_rate boolean,
               planned_kind text, planned_ref uuid, planned_date date, admin_hours_id uuid)
language sql stable security invoker set search_path = public as $$
  with cur as (
    select cp.session_id, cp.session_date, cp.players, cp.format, cp.outcome, cp.pay, cp.cash_kept,
           case when cp.pay is null then null else cp.pay - cp.cash_kept end as net
      from public.coach_pay cp
     where cp.coach_id = p_coach_id
       and cp.session_date <= p_until
       and cp.session_date >= coalesce((select (value #>> '{}')::date from public.settings where key = 'invoices_from'), date '2000-01-01')
  ),
  -- lines paid in advance for planned sessions, and what became of each planned session
  planned_paid as (
    select il.planned_kind as kind, il.planned_ref as ref,
           case when il.planned_kind = 'regular' then il.planned_date end as pdate,
           sum(il.amount) as amount, max(il.line_date) as line_date
      from public.invoice_lines il
      join public.coach_invoices ci on ci.id = il.invoice_id
     where ci.coach_id = p_coach_id and il.planned_kind is not null
     group by 1, 2, 3
  ),
  planned as (
    select pp.*,
           case pp.kind
             when 'once' then (select b.session_id from public.bookings b where b.id = pp.ref)
             else (select s.id from public.sessions s where s.plan_id = pp.ref and s.plan_date = pp.pdate) end as resolved,
           case pp.kind
             when 'once' then not exists (select 1 from public.bookings b
                                           where b.id = pp.ref and b.cancelled_at is null and b.coach_id = p_coach_id)
             else not exists (select 1 from public.session_plans pl
                               where pl.id = pp.ref and pl.coach_id = p_coach_id and pp.pdate >= pl.starts_on
                                 and (pl.ends_on is null or pp.pdate <= pl.ends_on)) end as gone
      from planned_paid pp
  ),
  billed as (
    select x.session_id, sum(x.amount) as amount, max(x.line_date) as line_date
      from (
        select il.session_id, il.amount, il.line_date
          from public.invoice_lines il
          join public.coach_invoices ci on ci.id = il.invoice_id
         where ci.coach_id = p_coach_id and il.session_id is not null
        union all
        -- a planned line counts as paid for the session it became, once that session is due
        select p.resolved, p.amount, p.line_date
          from planned p join public.sessions s on s.id = p.resolved
         where s.session_date <= p_until
      ) x
     group by x.session_id
  ),
  logged as (
    select coalesce(cur.session_id, b.session_id) as session_id,
           coalesce(cur.session_date, b.line_date) as line_date,
           case when cur.session_id is null then 'Correction: session taken off the record'
                else (case when b.session_id is not null then 'Correction: ' else '' end)
                  || case cur.format when '1:1' then '1:1 session' when '2:1' then '2:1 group session'
                                     when '4:1' then '4:1 group session' when 'analysis' then 'Game analysis'
                                     when 'testing' then 'Testing' when 'assessment' then 'Assessment'
                                     else cur.format end
                  || coalesce(', ' || cur.players, '')
                  || case cur.outcome when 'cancelled_late' then ' (cancelled late)'
                                      when 'no_show' then ' (no show)'
                                      when 'cancelled_in_time' then ' (cancelled in time)' else '' end
                  || case when cur.cash_kept > 0
                          then ' (cash $' || to_char(cur.cash_kept, 'FM999990.00') || ' kept, less pay $'
                               || to_char(coalesce(cur.pay, 0), 'FM999990.00') || ')'
                          else '' end
           end as description,
           coalesce(cur.net, 0) - coalesce(b.amount, 0) as amount,
           b.session_id is not null as is_correction,
           cur.session_id is not null and cur.pay is null as no_rate,
           null::text as planned_kind, null::uuid as planned_ref, null::date as planned_date, null::uuid as admin_hours_id
      from cur
      full join billed b on b.session_id = cur.session_id
     where (cur.session_id is null and b.amount <> 0)
        or (cur.session_id is not null and (cur.pay is null or cur.net <> coalesce(b.amount, 0)))
  ),
  -- paid in advance, but taken off the calendar before it happened
  removed as (
    select null::uuid, p.line_date, 'Correction: planned session taken off the calendar', -p.amount, true, false,
           p.kind, p.ref, p.pdate, null::uuid
      from planned p
     where p.resolved is null and p.gone and p.amount <> 0
  ),
  -- Friday-paid coaches: the rest of this week's calendar, paid now
  upcoming as (
    select null::uuid, c.session_date,
           'Planned: '
             || case c.format when '1:1' then '1:1 session' when '2:1' then '2:1 group session'
                              when '4:1' then '4:1 group session' when 'analysis' then 'Game analysis'
                              when 'testing' then 'Testing' when 'assessment' then 'Assessment' else c.format end
             || coalesce(', ' || c.players, ''),
           coalesce(public.coach_rate(p_coach_id, c.format), 0), false,
           public.coach_rate(p_coach_id, c.format) is null,
           c.kind, c.ref_id, case when c.kind = 'regular' then c.plan_date else c.session_date end, null::uuid
      from public.calendar(p_until + 1, p_until + (7 - extract(isodow from p_until)::int)) c
     where (select invoice_planned from public.coaches where id = p_coach_id)
       and c.coach_id = p_coach_id and c.kind in ('regular', 'once') and c.session_id is null
       and not exists (select 1 from planned p where p.kind = c.kind and p.ref = c.ref_id
                         and (c.kind = 'once' or p.pdate = c.plan_date))
  ),
  -- admin hours not on an invoice yet
  admin as (
    select null::uuid, a.work_date,
           'Admin: ' || rtrim(rtrim(a.hours::text, '0'), '.') || ' h at $' || trim(to_char(a.rate, 'FM9990.00'))
             || coalesce(' (' || nullif(trim(a.note), '') || ')', ''),
           round(a.hours * a.rate, 2), false, false, null::text, null::uuid, null::date, a.id
      from public.admin_hours a
     where a.coach_id = p_coach_id and a.work_date <= p_until
       and not exists (select 1 from public.invoice_lines il where il.admin_hours_id = a.id)
  )
  select * from logged
  union all select * from removed
  union all select * from upcoming
  union all select * from admin
  order by 2, 3
$$;
grant execute on function public.invoice_draft(uuid, date) to authenticated;

create or replace function public.submit_invoice(p_coach_id uuid, p_until date)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_coach public.coaches%rowtype;
  v_det   public.coach_details%rowtype;
  v_total numeric;
  v_n     int;
  v_no    int;
  v_id    uuid;
begin
  if not (public.is_admin() or p_coach_id = public.current_coach_id()) then
    raise exception 'You can only submit your own invoice';
  end if;
  select * into v_coach from public.coaches where id = p_coach_id for update;
  if not found then raise exception 'Coach not found'; end if;
  if v_coach.salaried then raise exception '% is salaried, so no invoice is needed', v_coach.name; end if;
  if p_until > public.today_sydney() then raise exception 'An invoice can only run up to today'; end if;

  select * into v_det from public.coach_details where coach_id = p_coach_id;
  if not v_coach.paid_separately then
    if not found or coalesce(trim(v_det.legal_name), '') = '' or v_det.abn is null or v_det.bsb is null
       or v_det.account_number is null or coalesce(trim(v_det.account_name), '') = '' then
      raise exception 'Add your name, ABN and bank details on the Account page first';
    end if;
  end if;

  if not public.is_admin() and exists (select 1 from public.undocumented_sessions(p_coach_id) u where u.session_date >= public.docs_required_from() and u.session_date <= p_until) then
    raise exception 'Add "What you worked on" for % session(s) first. They are listed under Documentation to do', (select count(*) from public.undocumented_sessions(p_coach_id) u where u.session_date >= public.docs_required_from() and u.session_date <= p_until);
  end if;

  if exists (select 1 from public.invoice_draft(p_coach_id, p_until) d where d.no_rate) then
    raise exception 'Some session types have no pay rate yet. Ask Jan to set it on the Team page';
  end if;
  select count(*), coalesce(sum(d.amount), 0) into v_n, v_total from public.invoice_draft(p_coach_id, p_until) d;
  if v_n = 0 or v_total <= 0 then raise exception 'Nothing to invoice up to %', to_char(p_until, 'DD Mon'); end if;

  select coalesce(max(number), 0) + 1 into v_no from public.coach_invoices where coach_id = p_coach_id;
  insert into public.coach_invoices (coach_id, number, period_start, period_end, total, coach_name,
        coach_legal_name, coach_abn, bsb, account_number, account_name, business_name, business_abn, submitted_by)
  values (p_coach_id, v_no, p_until - (extract(isodow from p_until)::int - 1), public.invoice_period_end(p_coach_id, p_until),
          v_total, v_coach.name,
          coalesce(nullif(trim(v_det.legal_name), ''), v_coach.name), coalesce(v_det.abn, ''), coalesce(v_det.bsb, ''),
          coalesce(v_det.account_number, ''), coalesce(trim(v_det.account_name), ''),
          (select value #>> '{}' from public.settings where key = 'business_name'),
          nullif((select value #>> '{}' from public.settings where key = 'business_abn'), ''),
          auth.uid())
  returning id into v_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction, planned_kind, planned_ref, planned_date, admin_hours_id)
  select v_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction, d.planned_kind, d.planned_ref, d.planned_date, d.admin_hours_id
    from public.invoice_draft(p_coach_id, p_until) d;
  return v_id;
end $$;
revoke execute on function public.submit_invoice(uuid, date) from public, anon;
grant execute on function public.submit_invoice(uuid, date) to authenticated;

create or replace function public.update_invoice(p_invoice_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_inv public.coach_invoices%rowtype;
  v_until date;
  v_total numeric;
  v_n int;
begin
  select * into v_inv from public.coach_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if not (public.is_admin() or v_inv.coach_id = public.current_coach_id()) then
    raise exception 'You can only change your own invoice';
  end if;
  if v_inv.status = 'paid' then
    raise exception 'This invoice is already paid, so it can no longer be changed. Anything missing goes on your next invoice';
  end if;
  if not public.is_admin() and public.sydney_now() >= public.invoice_edit_until(v_inv.period_end) then
    raise exception 'An invoice can be changed until Sunday 8pm of its week. Anything missing goes on your next invoice';
  end if;

  v_until := least(public.today_sydney(), v_inv.period_end + (7 - extract(isodow from v_inv.period_end)::int));
  delete from public.invoice_lines where invoice_id = p_invoice_id;

  if not public.is_admin() and exists (select 1 from public.undocumented_sessions(v_inv.coach_id) u where u.session_date >= public.docs_required_from() and u.session_date <= v_until) then
    raise exception 'Add "What you worked on" for % session(s) first. They are listed under Documentation to do', (select count(*) from public.undocumented_sessions(v_inv.coach_id) u where u.session_date >= public.docs_required_from() and u.session_date <= v_until);
  end if;

  if exists (select 1 from public.invoice_draft(v_inv.coach_id, v_until) d where d.no_rate) then
    raise exception 'Some session types have no pay rate yet. Ask Jan to set it on the Team page';
  end if;
  select count(*), coalesce(sum(d.amount), 0) into v_n, v_total from public.invoice_draft(v_inv.coach_id, v_until) d;
  if v_n = 0 or v_total <= 0 then
    delete from public.coach_invoices where id = p_invoice_id;
    return null;
  end if;

  update public.coach_invoices
     set total = v_total,
         period_start = v_until - (extract(isodow from v_until)::int - 1),
         period_end = public.invoice_period_end(v_inv.coach_id, v_until),
         issued_on = public.today_sydney(),
         submitted_at = now(),
         submitted_by = auth.uid()
   where id = p_invoice_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction, planned_kind, planned_ref, planned_date, admin_hours_id)
  select p_invoice_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction, d.planned_kind, d.planned_ref, d.planned_date, d.admin_hours_id
    from public.invoice_draft(v_inv.coach_id, v_until) d;
  return p_invoice_id;
end $$;
revoke all on function public.update_invoice(uuid) from public, anon;
grant execute on function public.update_invoice(uuid) to authenticated;
