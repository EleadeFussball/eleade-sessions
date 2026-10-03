-- Weekly coach invoices made inside the app, and a bank payment file for Jan.
-- Coaches are not registered for GST. Salaried staff track sessions but do not invoice.
-- Written without any removing statements so it can be applied directly.

alter table public.coaches add column if not exists salaried boolean not null default false;
update public.coaches set salaried = true where name = 'Jani' and is_admin;

insert into public.settings (key, value) values
  ('invoices_from', '"2026-10-05"'),     -- sessions before this date were invoiced the old way
  ('business_name', '"Eleade"'),
  ('business_abn', '""')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- private details
-- A coach's invoice details: only that coach and Jan can see or change them.
create table public.coach_details (
  coach_id        uuid primary key references public.coaches(id),
  legal_name      text,
  abn             text check (abn is null or abn ~ '^[0-9]{11}$'),
  bsb             text check (bsb is null or bsb ~ '^[0-9]{6}$'),
  account_number  text check (account_number is null or account_number ~ '^[0-9]{4,9}$'),
  account_name    text,
  updated_at      timestamptz not null default now()
);
alter table public.coach_details enable row level security;
create policy details_read on public.coach_details for select to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id());
create policy details_insert on public.coach_details for insert to authenticated
  with check (public.is_admin() or coach_id = public.current_coach_id());
create policy details_update on public.coach_details for update to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id())
  with check (public.is_admin() or coach_id = public.current_coach_id());
revoke all on public.coach_details from anon, authenticated;
grant select, insert, update on public.coach_details to authenticated;

-- Eleade's paying account, for the bank file. Jan only.
create table public.bank_file_settings (
  id              boolean primary key default true check (id),
  bsb             text check (bsb is null or bsb ~ '^[0-9]{6}$'),
  account_number  text check (account_number is null or account_number ~ '^[0-9]{4,9}$'),
  account_name    text,
  user_id_number  text not null default '000000' check (user_id_number ~ '^[0-9]{6}$'),
  remitter_name   text not null default 'ELEADE',
  updated_at      timestamptz not null default now()
);
insert into public.bank_file_settings (id) values (true) on conflict do nothing;
alter table public.bank_file_settings enable row level security;
create policy bank_admin_read on public.bank_file_settings for select to authenticated using (public.is_admin());
create policy bank_admin_update on public.bank_file_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.bank_file_settings from anon, authenticated;
grant select, update on public.bank_file_settings to authenticated;

-- ---------------------------------------------------------------- invoices
create table public.coach_invoices (
  id                uuid primary key default gen_random_uuid(),
  coach_id          uuid not null references public.coaches(id),
  number            int  not null,
  period_start      date not null,
  period_end        date not null,
  issued_on         date not null default public.today_sydney(),
  total             numeric(10,2) not null,
  status            text not null default 'submitted' check (status in ('submitted', 'paid')),
  coach_name        text not null,
  coach_legal_name  text not null,
  coach_abn         text not null,
  bsb               text not null,
  account_number    text not null,
  account_name      text not null,
  business_name     text,
  business_abn      text,
  submitted_by      uuid,
  submitted_at      timestamptz not null default now(),
  paid_by           uuid,
  paid_at           timestamptz,
  unique (coach_id, number)
);
create table public.invoice_lines (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null references public.coach_invoices(id),
  session_id     uuid,            -- no link on purpose: a removed session still shows on old invoices
  line_date      date not null,
  description    text not null,
  amount         numeric(10,2) not null,
  is_correction  boolean not null default false
);
create index invoice_lines_session on public.invoice_lines (session_id);

alter table public.coach_invoices enable row level security;
alter table public.invoice_lines enable row level security;
create policy invoices_read on public.coach_invoices for select to authenticated
  using (public.is_admin() or coach_id = public.current_coach_id());
create policy invoice_lines_read on public.invoice_lines for select to authenticated
  using (exists (select 1 from public.coach_invoices i where i.id = invoice_id
                  and (public.is_admin() or i.coach_id = public.current_coach_id())));
-- read only: invoices are written by submit_invoice and mark_invoices_paid
revoke all on public.coach_invoices, public.invoice_lines from anon, authenticated;
grant select on public.coach_invoices, public.invoice_lines to authenticated;

-- ---------------------------------------------------------------- pay
-- Salaried staff: sessions are tracked, pay is 0.
create or replace view public.coach_pay with (security_invoker = true) as
select s.id as session_id, s.session_date,
       (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
       s.coach_id, c.name as coach_name, s.format, s.outcome,
       (select string_agg(p.name, ', ' order by p.name)
          from public.session_players sp join public.players p on p.id = sp.player_id
         where sp.session_id = s.id) as players,
       case when c.salaried or not public.outcome_counts(s.outcome) then 0
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

-- What the coach's next invoice would contain up to a date: every session not yet invoiced,
-- plus a correction for any invoiced session whose pay has changed since (or that was removed).
create or replace function public.invoice_draft(p_coach_id uuid, p_until date)
returns table (session_id uuid, line_date date, description text, amount numeric, is_correction boolean, no_rate boolean)
language sql stable security invoker set search_path = public as $$
  with cur as (
    select cp.session_id, cp.session_date, cp.players, cp.format, cp.outcome, cp.pay
      from public.coach_pay cp
     where cp.coach_id = p_coach_id
       and cp.session_date <= p_until
       and cp.session_date >= coalesce((select (value #>> '{}')::date from public.settings where key = 'invoices_from'), date '2000-01-01')
  ), billed as (
    select il.session_id, sum(il.amount) as amount, max(il.line_date) as line_date
      from public.invoice_lines il
      join public.coach_invoices ci on ci.id = il.invoice_id
     where ci.coach_id = p_coach_id and il.session_id is not null
     group by il.session_id
  )
  select coalesce(cur.session_id, b.session_id),
         coalesce(cur.session_date, b.line_date),
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
         end,
         coalesce(cur.pay, 0) - coalesce(b.amount, 0),
         b.session_id is not null,
         cur.session_id is not null and cur.pay is null
    from cur
    full join billed b on b.session_id = cur.session_id
   where (cur.session_id is null and b.amount <> 0)
      or (cur.session_id is not null and (cur.pay is null or cur.pay <> coalesce(b.amount, 0)))
   order by 2, 3
$$;

-- The coach (or Jan for them) submits the invoice for the week ending p_until.
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
  if not found or coalesce(trim(v_det.legal_name), '') = '' or v_det.abn is null or v_det.bsb is null
     or v_det.account_number is null or coalesce(trim(v_det.account_name), '') = '' then
    raise exception 'Add your name, ABN and bank details on the Account page first';
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
          trim(v_det.legal_name), v_det.abn, v_det.bsb, v_det.account_number, trim(v_det.account_name),
          (select value #>> '{}' from public.settings where key = 'business_name'),
          nullif((select value #>> '{}' from public.settings where key = 'business_abn'), ''),
          auth.uid())
  returning id into v_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction)
  select v_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction
    from public.invoice_draft(p_coach_id, p_until) d;
  return v_id;
end $$;

create or replace function public.mark_invoices_paid(p_ids uuid[])
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public.is_admin() then raise exception 'Only Jan can mark invoices as paid'; end if;
  update public.coach_invoices set status = 'paid', paid_by = auth.uid(), paid_at = now()
   where id = any(p_ids) and status = 'submitted';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.invoice_draft(uuid, date) from public, anon;
revoke execute on function public.submit_invoice(uuid, date) from public, anon;
revoke execute on function public.mark_invoices_paid(uuid[]) from public, anon;
grant execute on function public.invoice_draft(uuid, date), public.submit_invoice(uuid, date),
  public.mark_invoices_paid(uuid[]) to authenticated;
