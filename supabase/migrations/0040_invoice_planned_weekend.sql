-- Coaches paid on Friday (Paul) can invoice the whole week, Monday to Sunday: sessions still planned for the
-- rest of the week appear as "Planned" lines. When a planned session is logged, it is matched to that line,
-- so it is not paid twice. If it is cancelled in time, removed from the calendar, or logged differently,
-- the difference is taken off (or added to) the next invoice automatically.

alter table public.coaches add column if not exists invoice_planned boolean not null default false;
update public.coaches set invoice_planned = true where lower(name) like 'paul%' and not invoice_planned;

alter table public.invoice_lines add column if not exists planned_kind text check (planned_kind in ('regular', 'once'));
alter table public.invoice_lines add column if not exists planned_ref uuid;
alter table public.invoice_lines add column if not exists planned_date date;
create index if not exists invoice_lines_planned on public.invoice_lines (planned_ref) where planned_ref is not null;

-- Pay for one session of this type at the coach's rate (null when no rate is set).
create or replace function public.coach_rate(p_coach_id uuid, p_format text) returns numeric
language sql stable security invoker set search_path = public as $$
  select case when c.salaried then 0 else
           case p_format when '1:1' then r.one_to_one when '2:1' then r.two_to_one when '4:1' then r.four_to_one
                         when 'analysis' then r.analysis when 'testing' then r.testing
                         when 'assessment' then coalesce(r.assessment, r.one_to_one) end end
    from public.coaches c left join public.coach_rates r on r.coach_id = c.id
   where c.id = p_coach_id
$$;

drop function if exists public.invoice_draft(uuid, date);
create function public.invoice_draft(p_coach_id uuid, p_until date)
returns table (session_id uuid, line_date date, description text, amount numeric, is_correction boolean, no_rate boolean,
               planned_kind text, planned_ref uuid, planned_date date)
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
           null::text as planned_kind, null::uuid as planned_ref, null::date as planned_date
      from cur
      full join billed b on b.session_id = cur.session_id
     where (cur.session_id is null and b.amount <> 0)
        or (cur.session_id is not null and (cur.pay is null or cur.net <> coalesce(b.amount, 0)))
  ),
  -- paid in advance, but taken off the calendar before it happened
  removed as (
    select null::uuid, p.line_date, 'Correction: planned session taken off the calendar', -p.amount, true, false,
           p.kind, p.ref, p.pdate
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
           c.kind, c.ref_id, case when c.kind = 'regular' then c.plan_date else c.session_date end
      from public.calendar(p_until + 1, p_until + (7 - extract(isodow from p_until)::int)) c
     where (select invoice_planned from public.coaches where id = p_coach_id)
       and c.coach_id = p_coach_id and c.kind in ('regular', 'once') and c.session_id is null
       and not exists (select 1 from planned p where p.kind = c.kind and p.ref = c.ref_id
                         and (c.kind = 'once' or p.pdate = c.plan_date))
  )
  select * from logged
  union all select * from removed
  union all select * from upcoming
  order by 2, 3
$$;
grant execute on function public.invoice_draft(uuid, date) to authenticated;

-- The week an invoice covers: to Sunday for a Friday-paid coach, otherwise to the invoice date.
create or replace function public.invoice_period_end(p_coach_id uuid, p_until date) returns date
language sql stable set search_path = public as $$
  select case when (select invoice_planned from public.coaches where id = p_coach_id)
              then p_until + (7 - extract(isodow from p_until)::int) else p_until end
$$;

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
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction, planned_kind, planned_ref, planned_date)
  select v_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction, d.planned_kind, d.planned_ref, d.planned_date
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
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction, planned_kind, planned_ref, planned_date)
  select p_invoice_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction, d.planned_kind, d.planned_ref, d.planned_date
    from public.invoice_draft(v_inv.coach_id, v_until) d;
  return p_invoice_id;
end $$;
revoke all on function public.update_invoice(uuid) from public, anon;
grant execute on function public.update_invoice(uuid) to authenticated;
