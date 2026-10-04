-- Cash a coach keeps is settled on the weekly invoice instead of being handed to Jan.
-- Example: a player pays the coach $120 in cash and the coach earns $60 for the session. The invoice
-- line for that session becomes -$60 (cash kept $120 less pay $60), so the weekly total drops by $60.
-- If the cash outweighs the week's pay, the invoice total is negative: it is not sent and the
-- sessions stay open, so the difference carries into the next week automatically.
-- Applies to sessions on or after the date in the setting 'cash_kept_from', and not to salaried staff
-- (they still hand cash to Jan, who confirms it on Monday).
-- Written without any removing statements so it can be applied directly.

insert into public.settings (key, value) values ('cash_kept_from', '"2026-10-05"') on conflict (key) do nothing;

-- Does this cash session settle through the coach's invoice?
create or replace function public.cash_via_invoice(p_coach_id uuid, p_method text, p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select p_method = 'cash'
     and exists (select 1 from public.coaches c where c.id = p_coach_id and not c.salaried)
     and p_date >= coalesce((select (value #>> '{}')::date from public.settings where key = 'cash_kept_from'), date '2000-01-01')
$$;
revoke execute on function public.cash_via_invoice(uuid, text, date) from public, anon;
grant execute on function public.cash_via_invoice(uuid, text, date) to authenticated;

-- What the players paid in cash for a session: each player's own price (assessments: the assessment price).
create or replace function public.session_cash_amount(p_session_id uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare v_s public.sessions%rowtype;
begin
  select * into v_s from public.sessions where id = p_session_id;
  if not found then return 0; end if;
  if not (public.is_admin() or v_s.coach_id = public.current_coach_id()) then return 0; end if;
  if v_s.format = 'assessment' then
    return coalesce((select (value #>> '{}')::numeric from public.settings where key = 'assessment_price'), 0);
  end if;
  return coalesce((
    select sum(coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price')))
      from public.session_players sp join public.players p on p.id = sp.player_id
     where sp.session_id = p_session_id), 0);
end $$;
revoke execute on function public.session_cash_amount(uuid) from public, anon;
grant execute on function public.session_cash_amount(uuid) to authenticated;

-- Pay view with the cash the coach kept as a last column (pay itself is unchanged, so Stats stay the same).
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
       end as pay,
       case when public.outcome_counts(s.outcome) and public.cash_via_invoice(s.coach_id, s.payment_method, s.session_date)
            then public.session_cash_amount(s.id) else 0 end as cash_kept
  from public.sessions s
  join public.coaches c on c.id = s.coach_id
  join public.coach_rates r on r.coach_id = s.coach_id
 where not s.imported;

-- Invoice draft: for cash sessions the line is pay minus the cash kept.
create or replace function public.invoice_draft(p_coach_id uuid, p_until date)
returns table (session_id uuid, line_date date, description text, amount numeric, is_correction boolean, no_rate boolean)
language sql stable security invoker set search_path = public as $$
  with cur as (
    select cp.session_id, cp.session_date, cp.players, cp.format, cp.outcome, cp.pay, cp.cash_kept,
           case when cp.pay is null then null else cp.pay - cp.cash_kept end as net
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
                || case when cur.cash_kept > 0
                        then ' (cash $' || to_char(cur.cash_kept, 'FM999990.00') || ' kept, less pay $'
                             || to_char(coalesce(cur.pay, 0), 'FM999990.00') || ')'
                        else '' end
         end,
         coalesce(cur.net, 0) - coalesce(b.amount, 0),
         b.session_id is not null,
         cur.session_id is not null and cur.pay is null
    from cur
    full join billed b on b.session_id = cur.session_id
   where (cur.session_id is null and b.amount <> 0)
      or (cur.session_id is not null and (cur.pay is null or cur.net <> coalesce(b.amount, 0)))
   order by 2, 3
$$;

-- A coach's cash session needs no check from Jan: it is settled on the invoice.
create or replace function public.sessions_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin() or coalesce(current_setting('eleade.system', true), '') = 'on';
  v_charged boolean;
begin
  if tg_op = 'INSERT' then
    new.logged_by := coalesce(auth.uid(), new.logged_by);
    new.logged_at := coalesce(new.logged_at, now());
    if not v_admin then
      new.payment_status := null;
      new.payment_confirmed_by := null;
      new.payment_confirmed_at := null;
    end if;
  else
    new.logged_by := old.logged_by;
    new.logged_at := old.logged_at;
    new.imported  := old.imported;
    if not v_admin then
      new.payment_status := old.payment_status;
      new.payment_confirmed_by := old.payment_confirmed_by;
      new.payment_confirmed_at := old.payment_confirmed_at;
      if new.payment_method is distinct from old.payment_method then
        new.payment_status := null;
        new.payment_confirmed_by := null;
        new.payment_confirmed_at := null;
      end if;
    end if;
  end if;

  v_charged := public.charged_separately(new.format, new.payment_method) and public.outcome_counts(new.outcome);
  if not v_charged then
    new.payment_status := null;
    new.payment_confirmed_by := null;
    new.payment_confirmed_at := null;
  elsif new.payment_status is null then
    new.payment_status := case when public.cash_via_invoice(new.coach_id, new.payment_method, new.session_date)
                               then 'confirmed' else 'awaiting' end;
  end if;

  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.payment_confirmed_by := auth.uid();
    new.payment_confirmed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.sessions_stamp() from public, anon, authenticated;

-- Cash sessions already waiting for Jan's check that now settle on the invoice.
do $$
begin
  perform set_config('eleade.system', 'on', true);
  update public.sessions s set payment_status = 'confirmed'
   where s.payment_status = 'awaiting' and s.format <> 'assessment'
     and public.cash_via_invoice(s.coach_id, s.payment_method, s.session_date);
  perform set_config('eleade.system', 'off', true);
end $$;
