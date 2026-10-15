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
