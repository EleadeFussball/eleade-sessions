-- Google Drive: Jan connects info@eleadefussball.com once; coaches upload session clips into the player's folder.
-- The Google key is stored encrypted. Only the app server (Vercel) holds the key to unlock it.

create table if not exists public.drive_connection (
  id                int primary key default 1 check (id = 1),
  refresh_token_enc text,
  connected_email   text,
  players_folder_id text not null default '108n5P9gy-SvBD93kCH-ISQSCJv4I5xsj',
  connected_at      timestamptz,
  connected_by      uuid
);
alter table public.drive_connection enable row level security;  -- no policies: only the functions below
insert into public.drive_connection (id) values (1) on conflict (id) do nothing;

alter table public.players add column if not exists drive_folder_id text;
alter table public.players add column if not exists drive_folder_name text;

create table if not exists public.drive_clips (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.players(id) on delete cascade,
  coach_id    uuid references public.coaches(id),
  file_id     text,
  file_name   text not null,
  created_at  timestamptz not null default now()
);
alter table public.drive_clips enable row level security;
drop policy if exists drive_clips_read on public.drive_clips;
create policy drive_clips_read on public.drive_clips for select to authenticated using (public.current_coach_id() is not null);
grant select on public.drive_clips to authenticated;

-- Status for the app: any coach may see whether Drive is connected.
create or replace function public.drive_status() returns table (connected boolean, connected_email text, connected_at timestamptz, players_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.refresh_token_enc is not null, d.connected_email, d.connected_at, d.players_folder_id
    from public.drive_connection d where public.current_coach_id() is not null
$$;

-- The encrypted key, for the app server acting for a signed-in coach. Useless without the server's key.
create or replace function public.drive_secret() returns table (refresh_token_enc text, players_folder_id text)
language sql stable security definer set search_path = public as $$
  select d.refresh_token_enc, d.players_folder_id from public.drive_connection d
   where public.current_coach_id() is not null and d.refresh_token_enc is not null
$$;

create or replace function public.drive_connect(p_token_enc text, p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can connect Google Drive'; end if;
  update public.drive_connection set refresh_token_enc = nullif(p_token_enc, ''), connected_email = p_email,
         connected_at = case when nullif(p_token_enc, '') is null then null else now() end, connected_by = auth.uid()
   where id = 1;
end $$;

-- Link players to their folders: [{"player_id": "...", "folder_id": "...", "folder_name": "..."}]; folder_id null unlinks.
create or replace function public.set_player_folders(p_links jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not public.is_admin() then raise exception 'Only Jan can link player folders'; end if;
  update public.players p set drive_folder_id = nullif(l->>'folder_id', ''), drive_folder_name = nullif(l->>'folder_name', '')
    from jsonb_array_elements(p_links) l where p.id = (l->>'player_id')::uuid;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.record_clip(p_player_id uuid, p_file_id text, p_file_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if public.current_coach_id() is null then raise exception 'Sign in as a coach'; end if;
  insert into public.drive_clips (player_id, coach_id, file_id, file_name)
  values (p_player_id, public.current_coach_id(), nullif(p_file_id, ''), p_file_name) returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.drive_status(), public.drive_secret(), public.drive_connect(text, text),
  public.set_player_folders(jsonb), public.record_clip(uuid, text, text) from public, anon;
grant execute on function public.drive_status(), public.drive_secret(), public.drive_connect(text, text),
  public.set_player_folders(jsonb), public.record_clip(uuid, text, text) to authenticated;
