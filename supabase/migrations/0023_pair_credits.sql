-- Separate credit pool for 2:1 sessions (brothers or friends who train together, priced differently from 1:1).
-- A pool exists for a player or family once any 2:1 credits have been recorded. Until then 2:1 sessions
-- keep drawing from the normal session credits, so nobody else's balance changes.
-- One 2:1 session uses ONE 2:1 credit for the family (siblings share a pool), or one per player when
-- the two players belong to different families.

alter table public.credit_ledger add column pairs_delta numeric(6,2) not null default 0;

create or replace view public.credit_usage with (security_invoker = true) as
with base as (
  select sp.player_id, s.id as session_id, s.session_date, s.format, s.outcome,
         coalesce(p.family, p.id::text) as pool,
         exists (
           select 1 from public.credit_ledger l join public.players q on q.id = l.player_id
            where l.pairs_delta <> 0 and (q.id = p.id or (p.family is not null and q.family = p.family))
         ) as has_pairs
    from public.sessions s
    join public.session_players sp on sp.session_id = s.id
    join public.players p on p.id = sp.player_id
   where not s.imported
     and public.outcome_counts(s.outcome)
     and s.format not in ('testing', 'assessment')
     and s.payment_method is null
)
select player_id, session_id, session_date, format, outcome,
       case when format in ('1:1', '4:1') or (format = '2:1' and not has_pairs) then 1 else 0 end as sessions_used,
       case when format = 'analysis' then 1 else 0 end as analyses_used,
       case when format = '2:1' and has_pairs
            then round(1.0 / count(*) over (partition by session_id, pool), 4) else 0 end as pairs_used
  from base;

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
            else sum(pp.own_pairs_left) over (partition by pp.family) end as pairs_left
  from per_player pp;
