-- Rename players.
-- Jan can rename any player. A coach can rename players they added themselves.
-- Players are never removed: a wrong name is fixed by renaming, and inactive players are marked not training.

alter table public.players add column if not exists created_by uuid;

create or replace function public.players_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.name := regexp_replace(trim(new.name), '\s+', ' ', 'g');
  return new;
end $$;
create or replace trigger players_stamp before insert on public.players
  for each row execute function public.players_stamp();
revoke execute on function public.players_stamp() from public, anon, authenticated;

create or replace function public.rename_player(p_player_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_creator uuid;
begin
  select created_by into v_creator from public.players where id = p_player_id;
  if not found then raise exception 'Player not found'; end if;
  if not coalesce(public.is_admin() or (public.is_coach() and v_creator is not null and v_creator = auth.uid()), false) then
    raise exception 'Only Jan, or the coach who added this player, can rename them';
  end if;
  if length(v_name) < 2 then raise exception 'Type the player''s full name'; end if;
  if exists (select 1 from public.players where lower(name) = lower(v_name) and id <> p_player_id) then
    raise exception 'Another player is already called %', v_name;
  end if;
  update public.players set name = v_name where id = p_player_id;
end $$;

revoke execute on function public.rename_player(uuid, text) from public, anon;
grant execute on function public.rename_player(uuid, text) to authenticated;
