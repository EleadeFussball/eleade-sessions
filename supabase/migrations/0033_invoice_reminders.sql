-- Reminders for Jan to raise invoices in MYOB: package renewals, monthly packages and the weekly Elle invoice.
-- The app only reminds and shows the figures; the invoice itself is created and sent in MYOB.

alter table public.players add column if not exists monthly_recurring boolean not null default false;

create table if not exists public.invoice_reminders_done (
  key text primary key,
  done_at timestamptz not null default now(),
  dismissed boolean not null default false,   -- "Not needed" instead of "Sent in MYOB"
  done_by uuid
);
alter table public.invoice_reminders_done enable row level security;
drop policy if exists invoice_reminders_done_admin on public.invoice_reminders_done;
create policy invoice_reminders_done_admin on public.invoice_reminders_done for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
revoke all on public.invoice_reminders_done from anon;
grant select, insert, delete on public.invoice_reminders_done to authenticated;

-- Which standard package a purchase was (older entries were named like "10 sessions + 1 analysis").
create or replace function public.package_kind(p_name text)
returns text language sql immutable as $$
  select case
    when p_name = '5 pack' or p_name ~* '^5 sessions' then '5 pack'
    when p_name = '10 pack' or p_name ~* '^10 sessions' then '10 pack'
    when p_name = 'Monthly' or p_name ~* '^4 sessions' then 'Monthly'
  end
$$;
-- Package prices ex GST (from 12 Oct 2026). Other packages use the price recorded with the purchase (0 = check).
create or replace function public.package_price(p_name text, p_recorded numeric)
returns numeric language sql immutable as $$
  select case public.package_kind(p_name) when '5 pack' then 650 when '10 pack' then 1250 when 'Monthly' then 650
              else coalesce(p_recorded, 0) end
$$;

create or replace function public.invoice_reminders()
returns table(key text, kind text, title text, details text, bill_to text, item text,
              amount_ex numeric, gst numeric, total numeric, due_from date, player_id uuid, done_at timestamptz, dismissed boolean)
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
           coalesce(p.family, p.id::text) as pool_key, l.id as ledger_id, l.package_name, l.amount_paid, l.effective_date
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
           public.today_sydney() as due_from, po.first_player as player_id
      from pool po join lastp lp on lp.pool_key = po.pool_key
     where po.sessions_left <= 1 and not (public.package_kind(lp.package_name) = 'Monthly' and po.recurring)
    union all
    -- recurring monthly package: next month's invoice from 5 days before it starts
    select 'monthly:' || lp.ledger_id, 'monthly',
           'Monthly package for ' || po.names || ', from ' || to_char((lp.effective_date + interval '1 month')::date, 'DD Mon'),
           'Recurring monthly package: 4 sessions and 1 game analysis. Last month started ' || to_char(lp.effective_date, 'DD Mon YYYY')
             || '. Record the new Monthly package on the player page once paid.',
           po.names, 'eleade monthly package', public.package_price('Monthly', lp.amount_paid),
           (lp.effective_date + interval '1 month')::date, po.first_player
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
           ow.elle_amount + ow.tyler_commission, ow.week_start + 6, null::uuid
      from public.owner_weeks ow
     where ow.elle_amount + ow.tyler_commission > 0 and ow.week_start + 6 <= public.today_sydney()
  )
  select r.key, r.kind, r.title, r.details, r.bill_to, r.item, r.amount_ex,
         round(r.amount_ex * 0.10, 2), round(r.amount_ex * 1.10, 2), r.due_from, r.player_id, d.done_at, coalesce(d.dismissed, false)
    from r left join public.invoice_reminders_done d on d.key = r.key
   where d.key is null or d.done_at > now() - interval '14 days'
   order by d.done_at nulls first, r.due_from, r.title;
end $$;
revoke all on function public.invoice_reminders() from public, anon;
grant execute on function public.invoice_reminders() to authenticated;
