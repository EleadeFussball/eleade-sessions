-- Enquiries (expressions of interest) from the website form.
-- The website sends each submission to the "enquiry-webhook" function, which records it here.
-- Jan assigns a coach; the app then creates the player, prepares the parent's message with the
-- payment link tagged for that player, and books the assessment in the coach's calendar.
-- Written without any removing statements so it can be applied directly.

-- A place for keys that only Jan may see (the website's webhook key).
create table public.private_keys (
  name       text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);
alter table public.private_keys enable row level security;
revoke all on public.private_keys from anon, authenticated;
grant select on public.private_keys to service_role;

create table public.enquiries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  external_id   text unique,                 -- the website's own id for the submission, to ignore repeats
  source        text not null default 'website',
  first_name    text,
  last_name     text,
  parent_name   text,
  email         text,
  phone         text,
  dob           text,
  gender        text,
  age_group     text,
  position      text,
  foot          text,
  club          text,
  heard_from    text,
  message       text,
  player_type   text,                        -- new or returning, as the parent chose it
  raw           jsonb,
  status        text not null default 'new'
                check (status in ('new', 'assigned', 'contacted', 'booked', 'done', 'declined')),
  coach_id      uuid references public.coaches(id),
  assigned_at   timestamptz,
  assigned_by   uuid,
  player_id     uuid references public.players(id),
  booking_id    uuid references public.bookings(id),
  note          text
);
create index enquiries_coach_idx on public.enquiries (coach_id, status);
alter table public.enquiries enable row level security;
create policy enquiries_read on public.enquiries for select to authenticated
  using (public.is_admin() or (public.is_coach() and coach_id = public.current_coach_id()));
revoke all on public.enquiries from anon, authenticated;
grant select on public.enquiries to authenticated;

-- Called by the webhook (service role only).
create or replace function public.record_enquiry(p_external_id text, p_fields jsonb, p_raw jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.enquiries (external_id, first_name, last_name, parent_name, email, phone, dob, gender,
                                age_group, position, foot, club, heard_from, message, player_type, raw)
  values (nullif(p_external_id, ''),
          nullif(trim(p_fields ->> 'first_name'), ''), nullif(trim(p_fields ->> 'last_name'), ''),
          nullif(trim(p_fields ->> 'parent_name'), ''), nullif(trim(p_fields ->> 'email'), ''),
          nullif(trim(p_fields ->> 'phone'), ''), nullif(trim(p_fields ->> 'dob'), ''),
          nullif(trim(p_fields ->> 'gender'), ''), nullif(trim(p_fields ->> 'age_group'), ''),
          nullif(trim(p_fields ->> 'position'), ''), nullif(trim(p_fields ->> 'foot'), ''),
          nullif(trim(p_fields ->> 'club'), ''), nullif(trim(p_fields ->> 'heard_from'), ''),
          nullif(trim(p_fields ->> 'message'), ''), nullif(trim(p_fields ->> 'player_type'), ''), p_raw)
  on conflict (external_id) do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.record_enquiry(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_enquiry(text, jsonb, jsonb) to service_role;

-- Jan creates or replaces the key the website uses to send enquiries.
create or replace function public.rotate_enquiry_key() returns text
language plpgsql security definer set search_path = public as $$
declare v_key text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  insert into public.private_keys (name, value) values ('enquiry_webhook', v_key)
  on conflict (name) do update set value = excluded.value, created_at = now();
  return v_key;
end $$;
revoke execute on function public.rotate_enquiry_key() from public, anon;
grant execute on function public.rotate_enquiry_key() to authenticated;

create or replace function public.get_enquiry_key() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  return (select value from public.private_keys where name = 'enquiry_webhook');
end $$;
revoke execute on function public.get_enquiry_key() from public, anon;
grant execute on function public.get_enquiry_key() to authenticated;

-- Create the player for an enquiry, or link the one with the same name (a returning player).
create or replace function public.enquiry_make_player(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e public.enquiries%rowtype;
  v_name text;
  v_player uuid;
begin
  select * into e from public.enquiries where id = p_id for update;
  if not found then raise exception 'Enquiry not found'; end if;
  if not (public.is_admin() or (public.is_coach() and e.coach_id = public.current_coach_id())) then
    raise exception 'This enquiry is not assigned to you';
  end if;
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
revoke execute on function public.enquiry_make_player(uuid) from public, anon;
grant execute on function public.enquiry_make_player(uuid) to authenticated;

-- Jan hands the enquiry to a coach. The player is created straight away so the payment link is ready.
create or replace function public.assign_enquiry(p_id uuid, p_coach_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_player uuid;
begin
  if not public.is_admin() then raise exception 'Only Jan can assign a coach'; end if;
  if not exists (select 1 from public.coaches where id = p_coach_id and active) then raise exception 'Coach not found'; end if;
  update public.enquiries
     set coach_id = p_coach_id, assigned_at = now(), assigned_by = auth.uid(),
         status = case when status in ('new', 'declined') then 'assigned' else status end
   where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
  v_player := public.enquiry_make_player(p_id);
  update public.players set main_coach_id = coalesce(main_coach_id, p_coach_id) where id = v_player;
  return v_player;
end $$;
revoke execute on function public.assign_enquiry(uuid, uuid) from public, anon;
grant execute on function public.assign_enquiry(uuid, uuid) to authenticated;

create or replace function public.set_enquiry_status(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e public.enquiries%rowtype;
begin
  if p_status not in ('new', 'assigned', 'contacted', 'booked', 'done', 'declined') then raise exception 'Unknown status'; end if;
  select * into e from public.enquiries where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
  if not (public.is_admin() or (public.is_coach() and e.coach_id = public.current_coach_id())) then
    raise exception 'This enquiry is not assigned to you';
  end if;
  update public.enquiries set status = p_status, note = coalesce(p_note, note) where id = p_id;
end $$;
revoke execute on function public.set_enquiry_status(uuid, text, text) from public, anon;
grant execute on function public.set_enquiry_status(uuid, text, text) to authenticated;

-- Put the assessment in the assigned coach's calendar.
create or replace function public.enquiry_book(p_id uuid, p_date date, p_time time, p_minutes int, p_location text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e public.enquiries%rowtype;
  v_booking uuid;
begin
  select * into e from public.enquiries where id = p_id for update;
  if not found then raise exception 'Enquiry not found'; end if;
  if not (public.is_admin() or (public.is_coach() and e.coach_id = public.current_coach_id())) then
    raise exception 'This enquiry is not assigned to you';
  end if;
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
revoke execute on function public.enquiry_book(uuid, date, time, int, text) from public, anon;
grant execute on function public.enquiry_book(uuid, date, time, int, text) to authenticated;
