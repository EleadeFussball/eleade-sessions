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
  ('Matraville', '{Matra,Mattraville,"Matraville Sports High School"}', 'Matraville Sports High School, Anzac Parade, Chifley NSW 2036', 'ChIJgyHYbuGzEmsRLqUJJm2mR6c'),
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
-- Matraville: Jan's pin for the access to the school field
update public.locations set maps_url = 'https://maps.app.goo.gl/ZtRGtbWWWaPo88129'
 where name = 'Matraville' and maps_url is null;

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
