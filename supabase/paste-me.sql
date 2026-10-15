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
