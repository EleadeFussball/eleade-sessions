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
-- Jan can edit or remove any credit entry (package, correction, opening balance) from the player page.
-- Coaches still only add packages; nothing they can change after saving.

alter table public.credit_ledger add column if not exists edited_by uuid;
alter table public.credit_ledger add column if not exists edited_at timestamptz;

create or replace function public.ledger_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not public.is_admin() and auth.uid() is not null then
      new.payment_status := 'awaiting';   -- a coach records it, Jan confirms it
    end if;
  elsif public.is_admin() then
    -- Jan may correct the entry itself; who and when is kept
    new.player_id := old.player_id; new.created_by := old.created_by; new.created_at := old.created_at;
    if (new.kind, new.sessions_delta, new.analyses_delta, new.pairs_delta, new.package_name, new.amount_paid,
        new.reason, new.effective_date, new.expires_on, new.payment_method)
       is distinct from
       (old.kind, old.sessions_delta, old.analyses_delta, old.pairs_delta, old.package_name, old.amount_paid,
        old.reason, old.effective_date, old.expires_on, old.payment_method) then
      new.edited_by := auth.uid();
      new.edited_at := now();
    end if;
  else
    -- only the payment check may change on an existing ledger row
    new.player_id := old.player_id; new.kind := old.kind;
    new.sessions_delta := old.sessions_delta; new.analyses_delta := old.analyses_delta; new.pairs_delta := old.pairs_delta;
    new.package_name := old.package_name; new.amount_paid := old.amount_paid;
    new.reason := old.reason; new.effective_date := old.effective_date;
    new.expires_on := old.expires_on; new.created_by := old.created_by; new.created_at := old.created_at;
    new.edited_by := old.edited_by; new.edited_at := old.edited_at;
  end if;
  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;
  return new;
end $$;

drop policy if exists ledger_delete on public.credit_ledger;
create policy ledger_delete on public.credit_ledger for delete to authenticated using (public.is_admin());
grant update, delete on public.credit_ledger to authenticated;
-- Sessions can be cancelled in advance (cancelled in time: no credit used, nothing on the coach invoice).
-- They stay in the calendar, shown faded with a red outline, and can be restored.

create or replace function public.confirm_booking(
  p_booking_id uuid, p_outcome text,
  p_topic text default null, p_observations text default null, p_improve text default null,
  p_payment_method text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_b public.bookings%rowtype;
  v_coach uuid;
  v_id uuid;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then raise exception 'Session not found'; end if;
  if v_b.session_id is not null then raise exception 'This session is already confirmed'; end if;
  if v_b.cancelled_at is not null then raise exception 'This session was taken off the calendar'; end if;
  if v_b.session_date > public.today_sydney() and p_outcome <> 'cancelled_in_time' then
    raise exception 'This session is still in the future. You can only cancel it in advance';
  end if;
  if p_outcome = 'attended' and not public.is_admin() and v_b.start_time is not null
     and (v_b.session_date + v_b.start_time + make_interval(mins => v_b.minutes + 5)) > public.sydney_now() then
    raise exception 'You can mark this session as completed from %, five minutes after it ends',
      to_char(v_b.start_time + make_interval(mins => v_b.minutes + 5), 'HH24:MI');
  end if;
  v_coach := case when public.is_admin() then v_b.coach_id else public.current_coach_id() end;
  insert into public.sessions (session_date, start_time, minutes, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method)
  values (v_b.session_date, v_b.start_time, v_b.minutes, v_coach, v_b.format, p_outcome, v_b.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.booking_players where booking_id = p_booking_id;
  update public.bookings set session_id = v_id where id = p_booking_id;
  return v_id;
end $$;

create or replace function public.confirm_plan_session(
  p_plan_id uuid, p_plan_date date, p_outcome text,
  p_topic text default null, p_observations text default null, p_improve text default null,
  p_payment_method text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_plan public.session_plans%rowtype;
  v_date date;
  v_time time;
  v_coach uuid;
  v_id uuid;
begin
  select * into v_plan from public.session_plans where id = p_plan_id;
  if not found then raise exception 'Regular session not found'; end if;
  select coalesce(ch.new_date, p_plan_date), coalesce(ch.new_time, v_plan.start_time)
    into v_date, v_time
    from (select 1) one left join public.plan_changes ch on ch.plan_id = p_plan_id and ch.plan_date = p_plan_date;
  if v_date > public.today_sydney() and p_outcome <> 'cancelled_in_time' then
    raise exception 'This session is still in the future. You can only cancel it in advance';
  end if;
  if p_outcome = 'attended' and not public.is_admin() and v_time is not null
     and (v_date + v_time + make_interval(mins => v_plan.minutes + 5)) > public.sydney_now() then
    raise exception 'You can mark this session as completed from %, five minutes after it ends',
      to_char(v_time + make_interval(mins => v_plan.minutes + 5), 'HH24:MI');
  end if;
  if exists (select 1 from public.sessions where plan_id = p_plan_id and plan_date = p_plan_date) then
    raise exception 'This session is already confirmed';
  end if;
  v_coach := case when public.is_admin() then v_plan.coach_id else public.current_coach_id() end;
  insert into public.sessions (session_date, start_time, minutes, coach_id, format, outcome, location,
                               topic, observations, improve, payment_method, plan_id, plan_date)
  values (v_date, v_time, v_plan.minutes, v_coach, v_plan.format, p_outcome, v_plan.location,
          nullif(trim(p_topic), ''), nullif(trim(p_observations), ''), nullif(trim(p_improve), ''),
          case when p_outcome <> 'cancelled_in_time' then p_payment_method end,
          p_plan_id, p_plan_date)
  returning id into v_id;
  insert into public.session_players (session_id, player_id)
  select v_id, player_id from public.plan_players where plan_id = p_plan_id;
  return v_id;
end $$;

-- Undo a cancellation made in advance: the session is planned again.
create or replace function public.undo_cancellation(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_s public.sessions%rowtype;
begin
  select * into v_s from public.sessions where id = p_session_id;
  if not found then raise exception 'Session not found'; end if;
  if v_s.outcome <> 'cancelled_in_time' then raise exception 'Only a session cancelled in time can be restored'; end if;
  if not (public.is_admin() or v_s.coach_id = public.current_coach_id()) then raise exception 'You can only change your own sessions'; end if;
  update public.bookings set session_id = null where session_id = p_session_id;
  delete from public.sessions where id = p_session_id;
end $$;
revoke all on function public.undo_cancellation(uuid) from public, anon;
grant execute on function public.undo_cancellation(uuid) to authenticated;

-- The phone calendar link also shows cancelled sessions (marked as cancelled).
create or replace function public.calendar_feed(p_token text)
returns table(coach_name text, kind text, ref_id uuid, plan_date date, session_date date, start_time time, minutes integer,
              format text, location text, note text, players text, done boolean, outcome text, prep text)
language sql stable security definer set search_path = public as $$
  with f as (select c.id, c.name from public.calendar_feeds cf join public.coaches c on c.id = cf.coach_id
              where cf.token = p_token and length(p_token) >= 32)
  select f.name, e.kind, e.ref_id, e.plan_date, e.session_date, e.start_time, e.minutes,
         e.format, e.location, e.note, e.players, e.session_id is not null, e.outcome,
         case when e.session_id is not null then null
              when e.kind = 'once' then (select sp.topic from public.session_prep sp where sp.booking_id = e.ref_id)
              when e.kind = 'regular' then (select sp.topic from public.session_prep sp where sp.plan_id = e.ref_id and sp.plan_date = e.plan_date)
         end
    from f
    cross join lateral public.calendar(public.today_sydney() - 28, public.today_sydney() + 84) e
   where e.coach_id = f.id
$$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- A Stripe payment is only treated as an assessment at the assessment price ($130 + GST);
-- other amounts (for example two 2:1 sessions at $165) are session payments.
create or replace function public.record_stripe_payment_named(
  p_stripe_session_id text, p_reference text, p_amount_total numeric, p_currency text,
  p_email text, p_name text, p_paid_at timestamptz, p_player_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_player uuid;
  v_n int;
  v_clean text := lower(regexp_replace(trim(coalesce(p_player_name, '')), '\s+', ' ', 'g'));
begin
  v_id := public.record_stripe_payment(p_stripe_session_id, p_reference, p_amount_total, p_currency, p_email, p_name, p_paid_at);
  if v_id is null then return null; end if;   -- already recorded
  if coalesce(trim(p_player_name), '') <> '' then
    update public.stripe_payments set player_name_entered = trim(p_player_name) where id = v_id;
  end if;
  -- a tagged link already found the player; otherwise use the name typed on the link
  if v_clean <> '' and (select player_id from public.stripe_payments where id = v_id) is null then
    select count(*), min(id::text)::uuid into v_n, v_player
      from public.players
     where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = v_clean;
    if v_n = 1 then
      update public.stripe_payments
         set player_id = v_player, for_what = case when p_amount_total between 140 and 150 then 'assessment' else 'session' end,
             purpose = case when p_amount_total between 140 and 150 then 'assessment' else 'unknown' end
       where id = v_id;
      perform public.apply_stripe_payments(v_player);
    end if;
  end if;
  return v_id;
end $$;
