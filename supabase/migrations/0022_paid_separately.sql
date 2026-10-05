-- A coach who is paid separately (Paul) sends the weekly invoice without ABN or bank details.
-- The invoice then shows no bank block, and Jan leaves it out of the NAB payment file.
-- Written without any removing statements so it can be applied directly.

alter table public.coaches add column if not exists paid_separately boolean not null default false;
update public.coaches set paid_separately = true where name = 'Paul';

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
  if extract(isodow from p_until) <> 7 then raise exception 'An invoice runs to a Sunday'; end if;
  if p_until > public.today_sydney() then raise exception 'You can submit this invoice on Sunday, once the week is over'; end if;

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
  values (p_coach_id, v_no, p_until - 6, p_until, v_total, v_coach.name,
          coalesce(nullif(trim(v_det.legal_name), ''), v_coach.name), coalesce(v_det.abn, ''), coalesce(v_det.bsb, ''),
          coalesce(v_det.account_number, ''), coalesce(trim(v_det.account_name), ''),
          (select value #>> '{}' from public.settings where key = 'business_name'),
          nullif((select value #>> '{}' from public.settings where key = 'business_abn'), ''),
          auth.uid())
  returning id into v_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction)
  select v_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction
    from public.invoice_draft(p_coach_id, p_until) d;
  return v_id;
end $$;
revoke execute on function public.submit_invoice(uuid, date) from public, anon;
grant execute on function public.submit_invoice(uuid, date) to authenticated;
