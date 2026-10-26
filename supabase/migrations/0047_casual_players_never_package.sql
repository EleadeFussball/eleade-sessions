-- Casual players (a few sessions here and there, no package) are never logged as "package credit".
-- Every counted session for a casual player gets a payment method: the way that player is set to pay,
-- or "Other" when they pay Jan directly (new option "Pays Jan directly").
-- Sessions with no method used to take a package credit; for a casual player that left the session
-- unpaid and invisible. Now it shows as awaiting payment until Jan confirms it.

alter table public.players drop constraint if exists players_casual_method_check;
alter table public.players add constraint players_casual_method_check
  check (casual_method is null or casual_method in ('stripe', 'cash', 'bank', 'other'));

-- The payment method every player on the session is set to, or null when any player is not casual.
create or replace function public.casual_session_method(p_session uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
           when count(*) = 0 or bool_or(p.payment_plan is distinct from 'casual') then null
           when count(p.casual_method) = count(*) and count(distinct p.casual_method) = 1 then min(p.casual_method)
           else 'other'
         end
    from public.session_players sp join public.players p on p.id = sp.player_id
   where sp.session_id = p_session
$$;
revoke execute on function public.casual_session_method(uuid) from public, anon, authenticated;

-- New session: the players are added right after the session row.
create or replace function public.casual_default_on_player() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.sessions s set payment_method = public.casual_session_method(s.id)
   where s.id = new.session_id and s.payment_method is null and not s.imported
     and s.format not in ('testing', 'assessment') and public.outcome_counts(s.outcome)
     and public.casual_session_method(s.id) is not null;
  return null;
end $$;
revoke execute on function public.casual_default_on_player() from public, anon, authenticated;
drop trigger if exists session_players_casual on public.session_players;
create trigger session_players_casual after insert on public.session_players
  for each row execute function public.casual_default_on_player();

-- Existing session changed (outcome confirmed, "package credit" picked again, players edited).
create or replace function public.sessions_casual_default() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_method text;
begin
  if new.payment_method is null and not new.imported and new.format not in ('testing', 'assessment')
     and public.outcome_counts(new.outcome) then
    v_method := public.casual_session_method(new.id);
    if v_method is not null then new.payment_method := v_method; end if;
  end if;
  return new;
end $$;
revoke execute on function public.sessions_casual_default() from public, anon, authenticated;
drop trigger if exists sessions_a_casual on public.sessions;
create trigger sessions_a_casual before update on public.sessions
  for each row execute function public.sessions_casual_default();

-- Sessions already logged without a method for a casual player.
do $$
begin
  perform set_config('eleade.system', 'on', true);
  update public.sessions s set payment_method = public.casual_session_method(s.id)
   where s.payment_method is null and not s.imported and s.format not in ('testing', 'assessment')
     and public.outcome_counts(s.outcome) and public.casual_session_method(s.id) is not null;
end $$;
