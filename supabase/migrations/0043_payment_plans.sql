-- How each player pays: monthly package, casual package (5/10), pays weekly, or casual (pays per session).
-- billing_model (package / pay_per_session) and monthly_recurring follow the plan automatically.

alter table public.players add column if not exists payment_plan text;
alter table public.players add column if not exists casual_method text check (casual_method in ('stripe', 'cash', 'bank'));
update public.players set payment_plan = case when billing_model = 'pay_per_session' then 'weekly'
                                              when monthly_recurring then 'monthly' else 'package' end
 where payment_plan is null;
alter table public.players alter column payment_plan set default 'package';
alter table public.players alter column payment_plan set not null;
alter table public.players drop constraint if exists players_payment_plan_check;
alter table public.players add constraint players_payment_plan_check check (payment_plan in ('monthly', 'package', 'weekly', 'casual'));

create or replace function public.players_payment_plan() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.payment_plan is distinct from old.payment_plan then
    -- the plan was chosen: set the older fields from it (credits are never touched, so they carry over)
    if tg_op = 'INSERT' and new.payment_plan = 'package' then
      -- created by an older screen that only sets billing_model / monthly_recurring
      if new.billing_model = 'pay_per_session' then new.payment_plan := 'weekly';
      elsif coalesce(new.monthly_recurring, false) then new.payment_plan := 'monthly'; end if;
    end if;
    new.billing_model := case when new.payment_plan in ('monthly', 'package') then 'package' else 'pay_per_session' end;
    new.monthly_recurring := new.payment_plan = 'monthly';
  elsif new.billing_model is distinct from old.billing_model or new.monthly_recurring is distinct from old.monthly_recurring then
    -- older screens change billing_model (e.g. recording a package for a weekly payer)
    new.payment_plan := case when new.billing_model = 'pay_per_session' then case when old.payment_plan = 'casual' then 'casual' else 'weekly' end
                             when new.monthly_recurring then 'monthly' else 'package' end;
  end if;
  if new.payment_plan <> 'casual' then new.casual_method := null; end if;
  return new;
end $$;
drop trigger if exists players_payment_plan on public.players;
create trigger players_payment_plan before insert or update on public.players
  for each row execute function public.players_payment_plan();

create or replace view public.player_balances with (security_invoker = true) as
with led as (
  select player_id, sum(sessions_delta) s, sum(analyses_delta) a, sum(pairs_delta) pr,
         max(effective_date) filter (where kind = 'purchase') last_purchase,
         min(expires_on) filter (where expires_on >= public.today_sydney()) next_expiry
    from public.credit_ledger group by player_id
), used as (
  select player_id, sum(sessions_used) s, sum(analyses_used) a, sum(pairs_used) pr from public.credit_usage group by player_id
), last_s as (
  select sp.player_id, max(s.session_date) last_session
    from public.sessions s join public.session_players sp on sp.session_id = s.id
   where s.outcome = 'attended' group by sp.player_id
), per_player as (
  select p.id as player_id, p.name, p.family, p.billing_model, p.active, p.main_coach_id, p.opening_confirmed,
         p.payment_plan, p.casual_method,
         case when p.billing_model = 'package' then coalesce(led.s, 0) - coalesce(used.s, 0) end as own_sessions_left,
         case when p.billing_model = 'package' then coalesce(led.a, 0) - coalesce(used.a, 0) end as own_analyses_left,
         coalesce(used.s, 0) as sessions_used_live,
         led.last_purchase, led.next_expiry, last_s.last_session,
         case when p.billing_model = 'package' then coalesce(led.pr, 0) - coalesce(used.pr, 0) end as own_pairs_left,
         coalesce(led.pr, 0) <> 0 as own_has_pairs
    from public.players p
    left join led on led.player_id = p.id
    left join used on used.player_id = p.id
    left join last_s on last_s.player_id = p.id
)
select pp.player_id, pp.name, pp.family, pp.billing_model, pp.active, pp.main_coach_id, pp.opening_confirmed,
       pp.own_sessions_left, pp.own_analyses_left, pp.sessions_used_live, pp.last_purchase, pp.next_expiry, pp.last_session,
       case when pp.family is null then pp.own_sessions_left
            else sum(pp.own_sessions_left) over (partition by pp.family) end as sessions_left,
       case when pp.family is null then pp.own_analyses_left
            else sum(pp.own_analyses_left) over (partition by pp.family) end as analyses_left,
       case when not (case when pp.family is null then pp.own_has_pairs
                           else bool_or(pp.own_has_pairs) over (partition by pp.family) end) then null
            when pp.family is null then pp.own_pairs_left
            else sum(pp.own_pairs_left) over (partition by pp.family) end as pairs_left,
       pp.payment_plan, pp.casual_method
  from per_player pp;

-- Weekly payers only (a casual player pays each session on its own)
create or replace view public.payg_weeks with (security_invoker = true) as
with charges as (
  select sp.player_id,
         (s.session_date - ((extract(isodow from s.session_date))::integer - 1)) as week_start,
         count(*) as sessions,
         sum(public.player_price(sp.player_id, s.format)) as owed
    from public.sessions s
    join public.session_players sp on sp.session_id = s.id
    join public.players p_1 on p_1.id = sp.player_id
   where not s.imported and public.outcome_counts(s.outcome)
     and s.format <> all (array['testing', 'assessment'])
     and s.payment_method is null and p_1.billing_model = 'pay_per_session' and p_1.payment_plan = 'weekly'
   group by sp.player_id, (s.session_date - ((extract(isodow from s.session_date))::integer - 1))
), paid as (
  select payments.player_id, payments.week_start, sum(payments.amount) as amount
    from public.payments group by payments.player_id, payments.week_start
)
select c.player_id, p.name, p.family, c.week_start, c.sessions, c.owed,
       coalesce(paid.amount, 0::numeric) as paid,
       c.owed - coalesce(paid.amount, 0::numeric) as outstanding
  from charges c
  join public.players p on p.id = c.player_id
  left join paid on paid.player_id = c.player_id and paid.week_start = c.week_start
 where public.is_admin();
