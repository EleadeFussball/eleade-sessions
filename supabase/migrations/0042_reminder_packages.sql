-- MYOB reminders: edit the package before invoicing (sessions, game analyses, price), and after
-- "Sent in MYOB" the reminder waits until Jan confirms the payment. Sending records the package
-- (credits available straight away, payment "awaiting"); "Paid" confirms it.

alter table public.invoice_reminders_done
  add column if not exists kind text, add column if not exists title text, add column if not exists details text,
  add column if not exists bill_to text, add column if not exists item text, add column if not exists player_id uuid,
  add column if not exists package_name text, add column if not exists sessions numeric, add column if not exists analyses numeric,
  add column if not exists pairs numeric, add column if not exists amount_ex numeric, add column if not exists ledger_id uuid,
  add column if not exists due_from date, add column if not exists paid_at timestamptz,
  add column if not exists payment_method text;
-- reminders marked before this change were recorded and paid by hand
update public.invoice_reminders_done set paid_at = done_at where paid_at is null and not dismissed and ledger_id is null and title is null;
grant update on public.invoice_reminders_done to authenticated;

create table if not exists public.invoice_reminder_edits (
  key text primary key, package_name text, sessions numeric not null default 0, analyses numeric not null default 0,
  pairs numeric not null default 0, amount_ex numeric not null default 0, updated_at timestamptz not null default now()
);
alter table public.invoice_reminder_edits enable row level security;
drop policy if exists invoice_reminder_edits_admin on public.invoice_reminder_edits;
create policy invoice_reminder_edits_admin on public.invoice_reminder_edits for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.invoice_reminder_edits to authenticated;

drop function if exists public.invoice_reminders();
drop function if exists public.reminder_paid(text, boolean, text);
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
           l.sessions_delta, l.analyses_delta, l.pairs_delta
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

create or replace function public.save_reminder_package(p_key text, p_package_name text, p_sessions numeric, p_analyses numeric, p_pairs numeric, p_amount_ex numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  if coalesce(p_sessions, 0) < 0 or coalesce(p_analyses, 0) < 0 or coalesce(p_pairs, 0) < 0 or coalesce(p_amount_ex, 0) < 0 then
    raise exception 'Numbers cannot be negative';
  end if;
  insert into public.invoice_reminder_edits (key, package_name, sessions, analyses, pairs, amount_ex)
  values (p_key, nullif(trim(p_package_name), ''), coalesce(p_sessions, 0), coalesce(p_analyses, 0), coalesce(p_pairs, 0), coalesce(p_amount_ex, 0))
  on conflict (key) do update set package_name = excluded.package_name, sessions = excluded.sessions, analyses = excluded.analyses,
        pairs = excluded.pairs, amount_ex = excluded.amount_ex, updated_at = now();
end $$;

-- "Sent in MYOB": records the package (payment awaiting) and keeps the reminder until the payment is confirmed.
create or replace function public.send_reminder(p_key text, p_dismiss boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare v record; v_ledger uuid; v_exp date; v_name text;
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  select * into v from public.invoice_reminders() r where r.key = p_key and r.status = 'open';
  if not found then raise exception 'This reminder is already handled'; end if;
  if not p_dismiss and v.kind in ('renewal', 'monthly') and v.player_id is not null then
    if coalesce(v.sessions, 0) + coalesce(v.analyses, 0) + coalesce(v.pairs, 0) = 0 then raise exception 'Set the sessions in the package first'; end if;
    v_name := case when v.package_name in ('5 pack', '10 pack', 'Monthly') then v.package_name else 'Tailored' end;
    v_exp := case v_name when '5 pack' then (v.due_from + interval '3 months')::date when '10 pack' then (v.due_from + interval '6 months')::date end;
    insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, pairs_delta, package_name, amount_paid,
                                      payment_method, payment_status, reason, effective_date, expires_on)
    values (v.player_id, 'purchase', coalesce(v.sessions, 0), coalesce(v.analyses, 0), coalesce(v.pairs, 0), v_name, v.amount_ex,
            'bank', 'awaiting',
            case when v_name = 'Tailored'
                 then 'Tailored package: ' || rtrim(rtrim(coalesce(v.sessions, 0)::text, '0'), '.') || ' sessions'
                      || case when coalesce(v.analyses, 0) > 0 then ', ' || rtrim(rtrim(v.analyses::text, '0'), '.') || ' game analysis' else '' end
                 else 'Bought ' || v_name end || ' (invoiced in MYOB)',
            greatest(v.due_from, public.today_sydney() - 31), v_exp)
    returning id into v_ledger;
  end if;
  insert into public.invoice_reminders_done (key, dismissed, done_by, kind, title, details, bill_to, item, player_id, package_name,
                                             sessions, analyses, pairs, amount_ex, ledger_id, due_from)
  values (p_key, p_dismiss, auth.uid(), v.kind, v.title, v.details, v.bill_to, v.item, v.player_id, v.package_name,
          v.sessions, v.analyses, v.pairs, v.amount_ex, v_ledger, v.due_from);
  delete from public.invoice_reminder_edits where key = p_key;
end $$;

-- Paid by bank transfer, Stripe or cash.
create or replace function public.reminder_paid(p_key text, p_paid boolean default true, p_method text default 'bank')
returns void language plpgsql security definer set search_path = public as $$
declare d public.invoice_reminders_done%rowtype;
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  if p_paid and coalesce(p_method, '') not in ('bank', 'stripe', 'cash', 'other') then raise exception 'Choose how it was paid'; end if;
  select * into d from public.invoice_reminders_done where key = p_key;
  if not found then raise exception 'Reminder not found'; end if;
  update public.invoice_reminders_done
     set paid_at = case when p_paid then now() end, payment_method = case when p_paid then p_method end
   where key = p_key;
  if d.ledger_id is not null then
    update public.credit_ledger
       set payment_status = case when p_paid then 'confirmed' else 'awaiting' end,
           payment_method = case when p_paid then p_method else payment_method end
     where id = d.ledger_id;
  end if;
end $$;

-- Undo "Sent" or "Not needed": the reminder is open again and an unpaid package recorded by it is removed.
create or replace function public.undo_reminder(p_key text)
returns void language plpgsql security definer set search_path = public as $$
declare d public.invoice_reminders_done%rowtype;
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  select * into d from public.invoice_reminders_done where key = p_key;
  if not found then return; end if;
  if d.paid_at is not null and d.ledger_id is not null then raise exception 'Already paid. Tap Not paid first'; end if;
  if d.ledger_id is not null then delete from public.credit_ledger where id = d.ledger_id; end if;
  delete from public.invoice_reminders_done where key = p_key;
end $$;

revoke execute on function public.save_reminder_package(text, text, numeric, numeric, numeric, numeric), public.send_reminder(text, boolean),
  public.reminder_paid(text, boolean, text), public.undo_reminder(text) from public, anon;
grant execute on function public.save_reminder_package(text, text, numeric, numeric, numeric, numeric), public.send_reminder(text, boolean),
  public.reminder_paid(text, boolean, text), public.undo_reminder(text) to authenticated;
