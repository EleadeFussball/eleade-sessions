-- Jan's own weekly figures (admin only): salary cost, Elle Academy income and Tyler's Elle commission.
-- The stats page uses them to show what the business generates overall.

create table if not exists public.owner_weeks (
  week_start date primary key check (extract(isodow from week_start) = 1),
  salary_cost numeric(10,2) not null default 0,       -- Jan's gross salary + super for this week
  elle_hours numeric(5,2) not null default 0,
  elle_rate numeric(8,2) not null default 70,
  elle_amount numeric(10,2) not null default 0,       -- paid by Elle Academy to Eleade
  tyler_elle_sessions integer not null default 0,
  tyler_commission_rate numeric(8,2) not null default 20,
  tyler_commission numeric(10,2) not null default 0,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.owner_weeks enable row level security;
drop policy if exists owner_weeks_admin on public.owner_weeks;
create policy owner_weeks_admin on public.owner_weeks for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.owner_weeks to authenticated;
grant select on public.owner_weeks to service_role;

-- Fortnightly $3,500 gross + $420 super = $1,960 a week, from KW41 2026 (week starting 5 Oct 2026).
-- A week without its own row uses the salary of the latest earlier row. Kept here, not in settings, so only Jan can see it.
-- KW40 and KW41 were school holidays: no Elle income. Salary starts in KW41.
insert into public.owner_weeks (week_start, salary_cost, elle_hours, elle_amount, note)
values ('2026-09-28', 0, 0, 0, 'School holidays'), ('2026-10-05', 1960, 0, 0, 'School holidays')
on conflict (week_start) do nothing;
-- Coaches can correct a sent invoice until Sunday 8pm (Sydney) of the invoice's week, as long as Jan has not paid it.
-- "Update invoice" rebuilds the lines from the logged sessions, keeping the invoice number. Jan can update any unpaid invoice.

create or replace function public.invoice_edit_until(p_period_end date)
returns timestamp language sql immutable as $$
  select (p_period_end + (7 - extract(isodow from p_period_end)::int)) + time '20:00'
$$;
grant execute on function public.invoice_edit_until(date) to authenticated;

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
    -- nothing left to pay: the invoice is withdrawn
    delete from public.coach_invoices where id = p_invoice_id;
    return null;
  end if;

  update public.coach_invoices
     set total = v_total,
         period_start = v_until - (extract(isodow from v_until)::int - 1),
         period_end = v_until,
         issued_on = public.today_sydney(),
         submitted_at = now(),
         submitted_by = auth.uid()
   where id = p_invoice_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction)
  select p_invoice_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction
    from public.invoice_draft(v_inv.coach_id, v_until) d;
  return p_invoice_id;
end $$;
revoke all on function public.update_invoice(uuid) from public, anon;
grant execute on function public.update_invoice(uuid) to authenticated;
