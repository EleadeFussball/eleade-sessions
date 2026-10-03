-- Sessions paid individually (cash, Stripe link, bank transfer) never use package credits and
-- are not part of a weekly transfer; Jan confirms the payment. Changing how a session was paid
-- is allowed on edit, and the payment check follows the change.
-- Written without any removing statements so it can be applied directly.

create or replace function public.charged_separately(p_format text, p_method text) returns boolean
language sql immutable set search_path = public as $$
  select p_format = 'assessment' or p_method is not null
$$;

create or replace function public.sessions_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin();
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
      -- a coach changing how it was paid sends it back to Jan for a check
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
    new.payment_status := 'awaiting';
  end if;

  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.payment_confirmed_by := auth.uid();
    new.payment_confirmed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.sessions_stamp() from public, anon, authenticated;

create or replace view public.credit_usage with (security_invoker = true) as
select sp.player_id, s.id as session_id, s.session_date, s.format, s.outcome,
       case when s.format in ('1:1', '2:1', '4:1') then 1 else 0 end as sessions_used,
       case when s.format = 'analysis' then 1 else 0 end as analyses_used
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
 where not s.imported
   and public.outcome_counts(s.outcome)
   and s.format not in ('testing', 'assessment')
   and s.payment_method is null;

create or replace view public.payg_weeks with (security_invoker = true) as
with charges as (
  select sp.player_id,
         (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
         count(*) as sessions,
         sum(coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))) as owed
    from public.sessions s
    join public.session_players sp on sp.session_id = s.id
    join public.players p on p.id = sp.player_id
   where not s.imported and public.outcome_counts(s.outcome)
     and s.format not in ('testing', 'assessment') and s.payment_method is null
     and p.billing_model = 'pay_per_session'
   group by 1, 2
), paid as (
  select player_id, week_start, sum(amount) amount from public.payments group by 1, 2
)
select c.player_id, p.name, p.family, c.week_start, c.sessions, c.owed,
       coalesce(paid.amount, 0) as paid, c.owed - coalesce(paid.amount, 0) as outstanding
  from charges c
  join public.players p on p.id = c.player_id
  left join paid on paid.player_id = c.player_id and paid.week_start = c.week_start
 where public.is_admin();

create or replace view public.payments_to_confirm with (security_invoker = true) as
select 'session'::text as kind, s.id as item_id, sp.player_id, p.name, s.session_date as item_date,
       case when s.format = 'assessment' then 'Assessment'
            when s.payment_method = 'cash' then 'Session paid in cash'
            when s.payment_method = 'stripe' then 'Session paid by Stripe link'
            when s.payment_method = 'bank' then 'Session paid by bank transfer'
            else 'Session paid separately' end as what,
       case when s.format = 'assessment'
            then (select (value #>> '{}')::numeric from public.settings where key = 'assessment_price')
            else coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))
       end as amount,
       s.payment_method, c.name as recorded_by
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
  join public.players p on p.id = sp.player_id
  join public.coaches c on c.id = s.coach_id
 where s.payment_status = 'awaiting' and public.is_admin()
union all
select 'package', l.id, l.player_id, p.name, l.effective_date,
       coalesce(l.package_name, 'Package'), l.amount_paid, l.payment_method,
       (select name from public.coaches where user_id = l.created_by)
  from public.credit_ledger l
  join public.players p on p.id = l.player_id
 where l.payment_status = 'awaiting' and public.is_admin();
