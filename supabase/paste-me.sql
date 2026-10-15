-- Each player can have their own price per 1:1 session and per 2:1 session (per player), ex GST.
-- Shown on the player page; used for weekly payers and for cash a coach keeps.

alter table public.players add column if not exists pair_price numeric(10,2);
insert into public.settings (key, value) values ('default_pair_price', '75'::jsonb) on conflict (key) do nothing;

create or replace function public.player_price(p_player_id uuid, p_format text) returns numeric
language sql stable set search_path = public as $$
  select case when p_format = '2:1'
              then coalesce(p.pair_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_pair_price'))
              else coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price')) end
    from public.players p where p.id = p_player_id
$$;
grant execute on function public.player_price(uuid, text) to authenticated;

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
     and s.payment_method is null and p_1.billing_model = 'pay_per_session'
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
  return coalesce((select sum(public.player_price(sp.player_id, v_s.format))
                     from public.session_players sp where sp.session_id = p_session_id), 0);
end $$;
-- Game analysis keeps the opponent in the location field, so it is never suggested as a training location.
create or replace function public.last_location(p_player_id uuid) returns text
language sql stable security invoker set search_path = public as $$
  select x.location from (
    select s.location, s.session_date as d, s.logged_at as t
      from public.sessions s join public.session_players sp on sp.session_id = s.id
     where sp.player_id = p_player_id and not s.imported and s.format <> 'analysis'
    union all
    select b.location, b.session_date, b.created_at
      from public.bookings b join public.booking_players bp on bp.booking_id = b.id
     where bp.player_id = p_player_id and b.cancelled_at is null and b.session_date <= public.today_sydney() and b.format <> 'analysis'
    union all
    select pl.location, public.today_sydney() - 1, pl.created_at
      from public.session_plans pl join public.plan_players pp on pp.plan_id = pl.id
     where pp.player_id = p_player_id and (pl.ends_on is null or pl.ends_on >= public.today_sydney()) and pl.format <> 'analysis'
  ) x
  where nullif(trim(x.location), '') is not null
  order by x.d desc, x.t desc
  limit 1
$$;
