-- Coach meetings: shown in the invited coaches' calendars, never use credits. Only an admin can add or change them.
create table public.meetings (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (length(btrim(title)) > 0),
  meeting_date date not null,
  start_time   time not null,
  minutes      int  not null default 60 check (minutes between 5 and 600),
  mode         text not null check (mode in ('online', 'in_person')),
  location     text,          -- in person: the address or place
  link         text,          -- online: the Zoom link
  note         text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  check ((mode = 'in_person' and length(btrim(coalesce(location, ''))) > 0)
      or (mode = 'online' and length(btrim(coalesce(link, ''))) > 0))
);
create table public.meeting_coaches (
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  coach_id   uuid not null references public.coaches(id),
  primary key (meeting_id, coach_id)
);
create index meeting_coaches_coach on public.meeting_coaches (coach_id);
create index meetings_date on public.meetings (meeting_date);

grant select, insert, update, delete on public.meetings, public.meeting_coaches to authenticated;
alter table public.meetings enable row level security;
alter table public.meeting_coaches enable row level security;

create policy meetings_admin on public.meetings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create or replace function public.is_invited(p_meeting uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.meeting_coaches where meeting_id = p_meeting and coach_id = public.current_coach_id())
$$;
grant execute on function public.is_invited(uuid) to authenticated;
create policy meetings_invited on public.meetings for select to authenticated using (public.is_invited(id));
create policy meeting_coaches_admin on public.meeting_coaches for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- coaches see who else is invited to a meeting they are invited to
create policy meeting_coaches_invited on public.meeting_coaches for select to authenticated using (public.is_invited(meeting_id));

create or replace function public.create_meeting(
  p_title text, p_date date, p_start time, p_minutes int, p_mode text,
  p_location text, p_link text, p_note text, p_coach_ids uuid[]
) returns uuid language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Only Jan can add coach meetings'; end if;
  if p_coach_ids is null or cardinality(p_coach_ids) = 0 then raise exception 'Invite at least one coach'; end if;
  if p_mode = 'in_person' and length(btrim(coalesce(p_location, ''))) = 0 then raise exception 'Add the location of the meeting'; end if;
  if p_mode = 'online' and length(btrim(coalesce(p_link, ''))) = 0 then raise exception 'Add the Zoom link'; end if;
  insert into public.meetings (title, meeting_date, start_time, minutes, mode, location, link, note, created_by)
  values (btrim(p_title), p_date, p_start, p_minutes, p_mode,
          case when p_mode = 'in_person' then btrim(p_location) end,
          case when p_mode = 'online' then btrim(p_link) end,
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  insert into public.meeting_coaches (meeting_id, coach_id) select v_id, unnest(p_coach_ids);
  return v_id;
end $$;

create or replace function public.update_meeting(
  p_id uuid, p_title text, p_date date, p_start time, p_minutes int, p_mode text,
  p_location text, p_link text, p_note text, p_coach_ids uuid[]
) returns void language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can change coach meetings'; end if;
  if p_coach_ids is null or cardinality(p_coach_ids) = 0 then raise exception 'Invite at least one coach'; end if;
  if p_mode = 'in_person' and length(btrim(coalesce(p_location, ''))) = 0 then raise exception 'Add the location of the meeting'; end if;
  if p_mode = 'online' and length(btrim(coalesce(p_link, ''))) = 0 then raise exception 'Add the Zoom link'; end if;
  update public.meetings set title = btrim(p_title), meeting_date = p_date, start_time = p_start, minutes = p_minutes, mode = p_mode,
    location = case when p_mode = 'in_person' then btrim(p_location) end,
    link = case when p_mode = 'online' then btrim(p_link) end,
    note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_id;
  if not found then raise exception 'Meeting not found'; end if;
  delete from public.meeting_coaches where meeting_id = p_id and coach_id <> all (p_coach_ids);
  insert into public.meeting_coaches (meeting_id, coach_id) select p_id, unnest(p_coach_ids) on conflict do nothing;
end $$;

revoke execute on function public.create_meeting(text, date, time, int, text, text, text, text, uuid[]) from public, anon;
revoke execute on function public.update_meeting(uuid, text, date, time, int, text, text, text, text, uuid[]) from public, anon;
grant execute on function public.create_meeting(text, date, time, int, text, text, text, text, uuid[]) to authenticated;
grant execute on function public.update_meeting(uuid, text, date, time, int, text, text, text, text, uuid[]) to authenticated;
