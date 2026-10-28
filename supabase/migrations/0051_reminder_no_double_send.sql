-- 1. After "Sent in MYOB" a new renewal reminder appeared at once whenever the player still had one credit or less
--    (the new package was unpaid and often small), and sending that one added the package a second time.
--    A renewal is now only asked for when the last package is not waiting for payment.
-- 2. Confirming a package under "Payments to confirm" now also marks its MYOB reminder as paid, so the two lists agree.

drop function if exists public.invoice_reminders();
create function public.invoice_reminders()
returns table(key text, kind text, title text, details text, bill_to text, item text,
              amount_ex numeric, gst numeric, total numeric, due_from date, player_id uuid, done_at timestamptz, dismissed boolean,
              package_name text, sessions numeric, analyses numeric, pairs numeric, status text, paid_at timestamptz, ledger_id uuid, payment_method text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can see invoice reminders'; end if;
  return query
  with pool as (
    select coalesce(b.family, b.player_id::text) as pool_key,
           string_agg(b.name, ' & ' order by b.name) as names,
           (array_agg(b.player_id order by b.name))[1] as first_player,
           max(b.sessions_left) as sessions_left,
           bool_or(p.monthly_recurring) as recurring
      from public.player_balances b join public.players p on p.id = b.player_id
     where b.active and b.billing_model = 'package'
     group by 1
  ), lastp as (
    select distinct on (coalesce(p.family, p.id::text))
           coalesce(p.family, p.id::text) as pool_key, l.id as ledger_id, l.package_name, l.amount_paid, l.effective_date,
           l.sessions_delta, l.analyses_delta, l.pairs_delta, l.payment_status
      from public.credit_ledger l join public.players p on p.id = l.player_id
     where l.kind = 'purchase' and l.package_name is not null
     order by coalesce(p.family, p.id::text), l.effective_date desc, l.created_at desc
  ), r as (
    -- 5 pack, 10 pack, tailored (and monthly when not recurring): one credit or less left
    select 'renewal:' || lp.ledger_id as key, 'renewal'::text as kind,
           'Renewal: ' || coalesce(public.package_kind(lp.package_name), lp.package_name) || ' for ' || po.names as title,
           po.names || ' ' || case when po.sessions_left <= 0 then 'has no credits left'
                                   else 'has ' || po.sessions_left || ' session' || case when po.sessions_left = 1 then '' else 's' end || ' left' end
             || '. Last package: ' || lp.package_name || ' on ' || to_char(lp.effective_date, 'DD Mon YYYY') || '.' as details,
           po.names as bill_to, 'eleade ' || coalesce(public.package_kind(lp.package_name), lp.package_name) as item,
           public.package_price(lp.package_name, lp.amount_paid) as amount_ex,
           public.today_sydney() as due_from, po.first_player as player_id,
           coalesce(public.package_kind(lp.package_name), 'Tailored') as package_name,
           case public.package_kind(lp.package_name) when '5 pack' then 5 when '10 pack' then 10 when 'Monthly' then 4 else lp.sessions_delta end as sessions,
           case public.package_kind(lp.package_name) when '5 pack' then 0 when '10 pack' then 1 when 'Monthly' then 1 else lp.analyses_delta end as analyses,
           case when public.package_kind(lp.package_name) is null then lp.pairs_delta else 0 end as pairs
      from pool po join lastp lp on lp.pool_key = po.pool_key
     where po.sessions_left <= 1 and not (public.package_kind(lp.package_name) = 'Monthly' and po.recurring)
       -- an invoice that was just sent and is waiting for payment must not ask for the next one straight away
       and lp.payment_status <> 'awaiting'
    union all
    -- recurring monthly package: next month's invoice from 5 days before it starts
    select 'monthly:' || lp.ledger_id, 'monthly',
           'Monthly package for ' || po.names || ', from ' || to_char((lp.effective_date + interval '1 month')::date, 'DD Mon'),
           'Recurring monthly package: 4 sessions and 1 game analysis. Last month started ' || to_char(lp.effective_date, 'DD Mon YYYY')
             || '. Record the new Monthly package on the player page once paid.',
           po.names, 'eleade monthly package', public.package_price('Monthly', lp.amount_paid),
           (lp.effective_date + interval '1 month')::date, po.first_player,
           'Monthly', 4::numeric, 1::numeric, 0::numeric
      from pool po join lastp lp on lp.pool_key = po.pool_key
     where public.package_kind(lp.package_name) = 'Monthly' and po.recurring
       and public.today_sydney() >= (lp.effective_date + interval '1 month')::date - 5
    union all
    -- weekly Elle invoice: Jan's hours and Tyler's commission, once the week is over
    select 'elle:' || ow.week_start, 'elle',
           'Elle Academy, week ' || extract(week from ow.week_start)::int || ' (' || to_char(ow.week_start, 'DD Mon') || ' to ' || to_char(ow.week_start + 6, 'DD Mon') || ')',
           concat_ws(E'\n',
             case when ow.elle_amount > 0 then 'Coaching (Jan): ' || rtrim(rtrim(ow.elle_hours::text, '0'), '.') || ' hours × $' || trim(to_char(ow.elle_rate, 'FM9990.00')) || ' = $' || trim(to_char(ow.elle_amount, 'FM999990.00')) end,
             case when ow.tyler_commission > 0 then 'Coach commission (Tyler): ' || ow.tyler_elle_sessions || ' sessions × $' || trim(to_char(ow.tyler_commission_rate, 'FM9990.00')) || ' = $' || trim(to_char(ow.tyler_commission, 'FM999990.00')) end,
             'Send to ellefootballacademy@gmail.com'),
           'Elle Football Academy', 'Coaching and coach commission, week ' || extract(week from ow.week_start)::int,
           ow.elle_amount + ow.tyler_commission, ow.week_start + 6, null::uuid,
           null::text, null::numeric, null::numeric, null::numeric
      from public.owner_weeks ow
     where ow.elle_amount + ow.tyler_commission > 0 and ow.week_start + 6 <= public.today_sydney()
  ), cur as (
    select r.key, r.kind, r.title, r.details, r.bill_to,
           case when e.key is not null and r.kind <> 'elle' then 'eleade ' || coalesce(e.package_name, r.package_name) else r.item end as item,
           coalesce(e.amount_ex, r.amount_ex) as amount_ex, r.due_from, r.player_id,
           coalesce(e.package_name, r.package_name) as package_name, coalesce(e.sessions, r.sessions) as sessions,
           coalesce(e.analyses, r.analyses) as analyses, coalesce(e.pairs, r.pairs) as pairs
      from r left join public.invoice_reminder_edits e on e.key = r.key
  )
  select c.key, c.kind, c.title, c.details, c.bill_to, c.item, c.amount_ex, round(c.amount_ex * 0.10, 2), round(c.amount_ex * 1.10, 2),
         c.due_from, c.player_id, null::timestamptz, false, c.package_name, c.sessions, c.analyses, c.pairs, 'open'::text, null::timestamptz, null::uuid, null::text
    from cur c
   where not exists (select 1 from public.invoice_reminders_done d where d.key = c.key)
  union all
  select d.key, coalesce(d.kind, 'renewal'), coalesce(d.title, c.title, d.key), coalesce(d.details, c.details, ''), coalesce(d.bill_to, c.bill_to, ''),
         coalesce(d.item, c.item, ''), coalesce(d.amount_ex, c.amount_ex, 0), round(coalesce(d.amount_ex, c.amount_ex, 0) * 0.10, 2),
         round(coalesce(d.amount_ex, c.amount_ex, 0) * 1.10, 2), coalesce(d.due_from, c.due_from), coalesce(d.player_id, c.player_id),
         d.done_at, d.dismissed, coalesce(d.package_name, c.package_name), coalesce(d.sessions, c.sessions), coalesce(d.analyses, c.analyses),
         coalesce(d.pairs, c.pairs),
         case when d.dismissed then 'dismissed' when d.paid_at is null then 'waiting' else 'paid' end, d.paid_at, d.ledger_id, d.payment_method
    from public.invoice_reminders_done d left join cur c on c.key = d.key
   where (not d.dismissed and d.paid_at is null) or coalesce(d.paid_at, d.done_at) > now() - interval '14 days'
   order by 18 desc, 10, 3;
end $$;
revoke all on function public.invoice_reminders() from public, anon;
grant execute on function public.invoice_reminders() to authenticated;

create or replace function public.sync_reminder_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.payment_status = 'confirmed' and old.payment_status is distinct from 'confirmed' then
    update public.invoice_reminders_done
       set paid_at = now(), payment_method = coalesce(new.payment_method, payment_method, 'bank')
     where ledger_id = new.id and paid_at is null;
  end if;
  return new;
end $$;
drop trigger if exists ledger_sync_reminder_paid on public.credit_ledger;
create trigger ledger_sync_reminder_paid after update of payment_status on public.credit_ledger
  for each row execute function public.sync_reminder_paid();
revoke execute on function public.sync_reminder_paid() from public, anon, authenticated;

-- reminders that were already confirmed under "Payments to confirm" but still wait in the MYOB list
update public.invoice_reminders_done d set paid_at = now(), payment_method = coalesce(l.payment_method, 'bank')
  from public.credit_ledger l
 where d.ledger_id = l.id and l.payment_status = 'confirmed' and d.paid_at is null;
