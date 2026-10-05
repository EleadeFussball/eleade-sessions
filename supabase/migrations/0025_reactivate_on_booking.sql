-- A player marked as not training comes back automatically when a session, booking or regular session is added for them,
-- so coaches can pick them like anyone else (they cannot edit players themselves).
create or replace function public.reactivate_player() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.players set active = true where id = new.player_id and not active;
  return new;
end $$;

create trigger session_players_reactivate after insert on public.session_players
  for each row execute function public.reactivate_player();
create trigger booking_players_reactivate after insert on public.booking_players
  for each row execute function public.reactivate_player();
create trigger plan_players_reactivate after insert on public.plan_players
  for each row execute function public.reactivate_player();
