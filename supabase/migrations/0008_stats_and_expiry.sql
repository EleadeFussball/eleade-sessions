-- Jan's Stats page (business numbers, cancellation rates) and package expiry reminders.
-- Jan only. Written without any removing statements so it can be applied directly.

-- Estimated income from one player in one session, ex GST.
--   assessments: the assessment price; paid separately or weekly payers: their session price;
--   package players: price per session of their latest package (family packages count), else the default price.
--   Game analyses and testing are counted as included (0).
create or replace function public.session_income(p_session_id uuid, p_player_id uuid)
returns numeric
language sql stable security invoker set search_path = public as $$
  with s as (select * from public.sessions where id = p_session_id),
       p as (select * from public.players where id = p_player_id),
       d as (select (value #>> '{}')::numeric v from public.settings where key = 'default_session_price'),
       pkg as (
         select l.amount_paid / l.sessions_delta as per_session
           from public.credit_ledger l, s, p
          where l.kind = 'purchase' and l.amount_paid > 0 and l.sessions_delta > 0
            and (l.player_id = p.id or (p.family is not null and l.player_id in (select id from public.players where family = p.family)))
          order by (l.effective_date <= s.session_date) desc, l.effective_date desc
          limit 1)
  select case
           when not public.outcome_counts(s.outcome) then 0
           when s.format = 'assessment' then (select (value #>> '{}')::numeric from public.settings where key = 'assessment_price')
           when s.format in ('testing', 'analysis') then 0
           when s.payment_method is not null or p.billing_model = 'pay_per_session' then coalesce(p.session_price, (select v from d))
           else coalesce((select per_session from pkg), (select v from d))
         end
    from s, p
$$;

-- One row per session (logged in the app, not imported).
create or replace view public.stats_sessions with (security_invoker = true) as
select s.id as session_id, s.session_date,
       (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
       s.coach_id, c.name as coach_name, s.format, s.outcome, s.plan_id is not null as regular,
       (select count(*) from public.session_players sp where sp.session_id = s.id) as players,
       (select string_agg(pl.name, ', ' order by pl.name) from public.session_players sp
          join public.players pl on pl.id = sp.player_id where sp.session_id = s.id) as player_names,
       coalesce(cp.pay, 0) as coach_pay,
       (select coalesce(sum(public.session_income(s.id, sp.player_id)), 0)
          from public.session_players sp where sp.session_id = s.id) as est_income
  from public.sessions s
  join public.coaches c on c.id = s.coach_id
  left join public.coach_pay cp on cp.session_id = s.id
 where not s.imported and public.is_admin();

-- Cancellations by player, one row per player per session.
create or replace view public.stats_player_outcomes with (security_invoker = true) as
select sp.player_id, p.name, s.session_date, s.coach_id, s.outcome
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
  join public.players p on p.id = sp.player_id
 where not s.imported and public.is_admin();

-- Money received, by day: packages, weekly transfers and separately paid sessions.
create or replace view public.stats_money_in with (security_invoker = true) as
select l.effective_date as received_on, 'Packages'::text as source, l.amount_paid as amount
  from public.credit_ledger l
 where l.kind = 'purchase' and coalesce(l.amount_paid, 0) > 0 and public.is_admin()
union all
select pm.received_on, 'Weekly payers', pm.amount
  from public.payments pm
 where public.is_admin()
union all
select s.session_date,
       case when s.format = 'assessment' then 'Assessments' else 'Single sessions' end,
       public.session_income(s.id, sp.player_id)
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
 where not s.imported and s.payment_status = 'confirmed' and public.is_admin();

-- Regular sessions moved to another day or time.
create or replace view public.stats_moves with (security_invoker = true) as
select ch.plan_id, ch.plan_date, ch.new_date, ch.new_time, pl.coach_id, c.name as coach_name, ch.created_at,
       (select string_agg(p.name, ', ' order by p.name) from public.plan_players pp
          join public.players p on p.id = pp.player_id where pp.plan_id = ch.plan_id) as players
  from public.plan_changes ch
  join public.session_plans pl on pl.id = ch.plan_id
  join public.coaches c on c.id = pl.coach_id
 where public.is_admin();

-- Packages that expire within 4 weeks (or lapsed in the last 2) while credits are still left,
-- and that have not been replaced by a newer package.
create or replace view public.expiring_packages with (security_invoker = true) as
with last_pkg as (
  select distinct on (coalesce(p.family, p.id::text))
         l.id, l.player_id, coalesce(p.family, p.id::text) as pool, p.family,
         l.package_name, l.effective_date, l.expires_on
    from public.credit_ledger l
    join public.players p on p.id = l.player_id
   where l.kind = 'purchase'
   order by coalesce(p.family, p.id::text), l.effective_date desc, l.created_at desc
)
select lp.player_id, b.name, lp.family, lp.package_name, lp.effective_date as bought_on, lp.expires_on,
       lp.expires_on - public.today_sydney() as days_left, b.sessions_left, b.analyses_left, b.main_coach_id
  from last_pkg lp
  join public.player_balances b on b.player_id = lp.player_id
 where lp.expires_on is not null
   and lp.expires_on between public.today_sydney() - 14 and public.today_sydney() + 28
   and (coalesce(b.sessions_left, 0) > 0 or coalesce(b.analyses_left, 0) > 0)
   and b.active;

revoke execute on function public.session_income(uuid, uuid) from public, anon;
grant execute on function public.session_income(uuid, uuid) to authenticated;
grant select on public.stats_sessions, public.stats_player_outcomes, public.stats_money_in,
  public.stats_moves, public.expiring_packages to authenticated;

revoke all on public.stats_sessions, public.stats_player_outcomes, public.stats_money_in,
  public.stats_moves, public.expiring_packages from anon;
