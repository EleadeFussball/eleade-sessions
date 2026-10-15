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
-- Every coach can work on enquiries (Tyler makes the calls). Pitch locations with Google Maps links.

-- ---------- pitch locations ----------
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  aliases    text[] not null default '{}',
  address    text,
  place_id   text,
  maps_url   text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.locations enable row level security;
drop policy if exists locations_read on public.locations;
create policy locations_read on public.locations for select to authenticated using (public.is_coach());
drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.locations to authenticated;

insert into public.locations (name, aliases, address, place_id) values
  ('Gunyama Park', '{Gunyama,Gunymana}', '138 Joynton Ave, Zetland NSW 2017', 'ChIJf7TVQ1GxEmsRWofVzSb26cg'),
  ('Waverley Oval', '{Waverley,Waverly,Waverely}', '49C Bondi Rd, Bondi Junction NSW 2022', 'ChIJJWXm44ytEmsRsdJ_OBqGo68'),
  ('Queens Park', '{"Queen''s Park"}', 'Darley Rd, Queens Park NSW 2022', 'ChIJ7UAgqQmyEmsRwBPy-Wh9AQ8'),
  ('Moore Park', '{"Moore Park Synthetic Field"}', 'Lang Rd, Moore Park NSW 2021', 'ChIJe2Wu8_yxEmsR0i-BuniVspM'),
  ('Rowland Park', '{Rowland,Rownad}', 'Bunnerong Rd, Daceyville NSW 2032', 'ChIJUWuIYYGxEmsRMCny-Wh9AQ8'),
  ('Heffron Park', '{Heffron}', '439 Bunnerong Rd, Maroubra NSW 2036', 'ChIJyz-4fGKxEmsRzrLVY5Mstds'),
  ('Matraville', '{Matra,Mattraville}', null, null),
  ('Allan Border Oval', '{"Allan Border"}', 'The Crescent, Mosman NSW 2088', 'ChIJrzrxIxusEmsRapWZthXVx5Q'),
  ('Village Green UNSW', '{"Village Green"}', 'University Mall, UNSW, Kensington NSW 2033', 'ChIJEZi59YuxEmsREWmDN_gQwbY'),
  ('Pioneers Park', '{Pioneers,"Pionners Park"}', '1160 Anzac Parade, Malabar NSW 2036', 'ChIJBUPL-sKzEmsRmTeXmzf5DDQ'),
  ('Peakhurst Park', '{Peakhurst}', '20 Trafalgar St, Peakhurst NSW 2210', 'ChIJHQwESwC5EmsR_G79JL4Puug'),
  ('David Phillips Sports Field', '{"David Philips","David Phillips"}', 'Banks Ave & Gwea Ave, Daceyville NSW 2032', 'ChIJA2VAs4OxEmsR0Th7sgltGck'),
  ('Rodney Reserve', '{Rodney}', 'Rodney St, Dover Heights NSW 2030', 'ChIJM5FIzPKtEmsRFsfB5gWNv_I'),
  ('Perry Park', '{Perry}', '1B Maddox St, Alexandria NSW 2015', 'ChIJF_H9m8exEmsRQCabXgulO5M'),
  ('Northbridge Oval', '{Northbridge}', '271 Sailors Bay Rd, Northbridge NSW 2063', 'ChIJz68gXLKuEmsR4Pzw-Wh9AQ8'),
  ('Balmoral Oval', '{Balmoral,Bermoal}', '42 Plunkett Rd, Mosman NSW 2088', 'ChIJy8-3fxKsEmsR6uQQHYzQK3k'),
  ('Cammeray Park', '{Cammery,Cammeray}', 'Ernest St & Park Ave, Cammeray NSW 2062', 'ChIJTS45-N-vEmsRLetanyjmwfk'),
  ('Christison Park', '{}', 'Old South Head Rd, Vaucluse NSW 2030', 'ChIJEW7KavesEmsRhvmpXwgFZqI'),
  ('Coral Sea Park', '{"Coral Sea"}', '53 Yorktown Parade, Maroubra NSW 2035', 'ChIJrZjwItCzEmsRkDLy-Wh9AQ8')
on conflict (name) do nothing;

-- ---------- enquiries: every coach ----------
alter table public.enquiries add column if not exists preferred_location text;
alter table public.enquiries add column if not exists ideal_times text;
alter table public.enquiries add column if not exists called_by uuid;
alter table public.enquiries add column if not exists whatsapp_group_at timestamptz;

drop policy if exists enquiries_read on public.enquiries;
create policy enquiries_read on public.enquiries for select to authenticated using (public.is_coach());

create or replace function public.enquiry_make_player(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e public.enquiries%rowtype;
  v_name text;
  v_player uuid;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  select * into e from public.enquiries where id = p_id for update;
  if not found then raise exception 'Enquiry not found'; end if;
  if e.player_id is not null then return e.player_id; end if;
  v_name := trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
  if v_name = '' then raise exception 'The enquiry has no player name'; end if;
  select id into v_player from public.players where lower(name) = lower(v_name);
  if v_player is null then
    insert into public.players (name, main_coach_id, created_by)
    values (v_name, e.coach_id, auth.uid()) returning id into v_player;
  end if;
  update public.enquiries set player_id = v_player where id = p_id;
  return v_player;
end $$;

-- Any coach (usually Tyler, after the call) hands the enquiry to a coach. The player is created straight away.
create or replace function public.assign_enquiry(p_id uuid, p_coach_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_player uuid; b public.bookings%rowtype; v_new uuid;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  if not exists (select 1 from public.coaches where id = p_coach_id and active) then raise exception 'Coach not found'; end if;
  update public.enquiries
     set coach_id = p_coach_id, assigned_at = now(), assigned_by = auth.uid(),
         status = case when status in ('new', 'declined') then 'assigned' else status end
   where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
  v_player := public.enquiry_make_player(p_id);
  update public.players set main_coach_id = p_coach_id
   where id = v_player and (main_coach_id is null or not exists (select 1 from public.session_players where player_id = v_player));
  -- a planned assessment moves to the new coach's calendar (bookings keep their coach, so it is re-created)
  select * into b from public.bookings
   where id = (select booking_id from public.enquiries where id = p_id) and session_id is null and cancelled_at is null;
  if found and b.coach_id <> p_coach_id then
    update public.bookings set cancelled_at = now() where id = b.id;
    insert into public.bookings (coach_id, session_date, start_time, format, location, note, minutes)
    values (p_coach_id, b.session_date, b.start_time, b.format, b.location, b.note, b.minutes) returning id into v_new;
    insert into public.booking_players (booking_id, player_id) select v_new, player_id from public.booking_players where booking_id = b.id;
    update public.enquiries set booking_id = v_new where id = p_id;
  end if;
  return v_player;
end $$;

create or replace function public.set_enquiry_status(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  if p_status not in ('new', 'assigned', 'contacted', 'booked', 'done', 'declined') then raise exception 'Unknown status'; end if;
  update public.enquiries set status = p_status, note = coalesce(p_note, note) where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
end $$;

create or replace function public.enquiry_book(p_id uuid, p_date date, p_time time, p_minutes int, p_location text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e public.enquiries%rowtype;
  v_booking uuid;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  select * into e from public.enquiries where id = p_id for update;
  if not found then raise exception 'Enquiry not found'; end if;
  if e.coach_id is null then raise exception 'Assign a coach first'; end if;
  if e.player_id is null then raise exception 'Create the player first'; end if;
  if e.booking_id is not null and exists (select 1 from public.bookings where id = e.booking_id and cancelled_at is null and session_id is null) then
    update public.bookings
       set session_date = p_date, start_time = p_time, minutes = coalesce(p_minutes, 60),
           location = nullif(trim(p_location), '')
     where id = e.booking_id;
    update public.enquiries set status = 'booked' where id = p_id;
    return e.booking_id;
  end if;
  insert into public.bookings (coach_id, session_date, start_time, format, location, note, minutes)
  values (e.coach_id, p_date, p_time, 'assessment', nullif(trim(p_location), ''), 'Assessment from website enquiry', coalesce(p_minutes, 60))
  returning id into v_booking;
  insert into public.booking_players (booking_id, player_id) values (v_booking, e.player_id);
  update public.enquiries set booking_id = v_booking, status = 'booked' where id = p_id;
  return v_booking;
end $$;

create or replace function public.add_enquiry(p_fields jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  if nullif(trim(p_fields ->> 'first_name'), '') is null then raise exception 'Add the player''s name'; end if;
  v_id := public.record_enquiry('manual-' || gen_random_uuid()::text, p_fields, jsonb_build_object('manual', true));
  update public.enquiries set source = 'manual' where id = v_id;
  return v_id;
end $$;

-- The call with the parents: notes, preferred pitch and ideal times.
drop function if exists public.enquiry_called(uuid, text);
create or replace function public.enquiry_called(p_id uuid, p_note text default null, p_location text default null, p_times text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  update public.enquiries
     set called_at = coalesce(called_at, now()), called_by = coalesce(called_by, auth.uid()),
         note = coalesce(nullif(trim(p_note), ''), note),
         preferred_location = coalesce(nullif(trim(p_location), ''), preferred_location),
         ideal_times = coalesce(nullif(trim(p_times), ''), ideal_times)
   where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
end $$;

create or replace function public.enquiry_whatsapp_group(p_id uuid, p_done boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  update public.enquiries set whatsapp_group_at = case when p_done then coalesce(whatsapp_group_at, now()) end where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
end $$;

create or replace function public.set_enquiry_outcome(p_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_coach() then raise exception 'Sign in as a coach'; end if;
  if p_outcome not in ('package5', 'package10', 'handover', 'not_continuing') then raise exception 'Unknown outcome'; end if;
  update public.enquiries set outcome = p_outcome, outcome_at = now(), status = 'done' where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
end $$;

revoke execute on function public.enquiry_called(uuid, text, text, text), public.enquiry_whatsapp_group(uuid, boolean) from public, anon;
grant execute on function public.enquiry_called(uuid, text, text, text), public.enquiry_whatsapp_group(uuid, boolean) to authenticated;
