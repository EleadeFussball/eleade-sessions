-- Enquiries follow the way Eleade works:
--   form arrives -> Jan reviews and phones the parents -> coach assigned, assessment booked ->
--   coach sends the payment link -> assessment -> coach sends the summary ->
--   parents commit to 5 or 10 sessions, or the family is handed to Jan for the sales call.
-- Written without any removing statements so it can be applied directly.

alter table public.enquiries add column if not exists parent_email text;
alter table public.enquiries add column if not exists parent_phone text;
alter table public.enquiries add column if not exists called_at timestamptz;     -- Jan has spoken to the parents
alter table public.enquiries add column if not exists outcome text
  check (outcome in ('package5', 'package10', 'handover', 'not_continuing'));
alter table public.enquiries add column if not exists outcome_at timestamptz;

create or replace function public.record_enquiry(p_external_id text, p_fields jsonb, p_raw jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.enquiries (external_id, first_name, last_name, parent_name, parent_email, parent_phone, email, phone,
                                dob, gender, age_group, position, foot, club, heard_from, message, player_type, raw)
  values (nullif(p_external_id, ''),
          nullif(trim(p_fields ->> 'first_name'), ''), nullif(trim(p_fields ->> 'last_name'), ''),
          nullif(trim(p_fields ->> 'parent_name'), ''), nullif(trim(p_fields ->> 'parent_email'), ''),
          nullif(trim(p_fields ->> 'parent_phone'), ''), nullif(trim(p_fields ->> 'email'), ''),
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

-- Jan types in an enquiry by hand (for example from the emailed form).
create or replace function public.add_enquiry(p_fields jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_admin() then raise exception 'Only Jan can add an enquiry'; end if;
  if nullif(trim(p_fields ->> 'first_name'), '') is null then raise exception 'Add the player''s name'; end if;
  v_id := public.record_enquiry('manual-' || gen_random_uuid()::text, p_fields, jsonb_build_object('manual', true));
  update public.enquiries set source = 'manual' where id = v_id;
  return v_id;
end $$;
revoke execute on function public.add_enquiry(jsonb) from public, anon;
grant execute on function public.add_enquiry(jsonb) to authenticated;

-- Jan has phoned the parents (note optional).
create or replace function public.enquiry_called(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can do this'; end if;
  update public.enquiries
     set called_at = coalesce(called_at, now()), note = coalesce(nullif(trim(p_note), ''), note)
   where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
end $$;
revoke execute on function public.enquiry_called(uuid, text) from public, anon;
grant execute on function public.enquiry_called(uuid, text) to authenticated;

-- What the parents decided after the assessment. Jan or the assigned coach records it.
create or replace function public.set_enquiry_outcome(p_id uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
declare e public.enquiries%rowtype;
begin
  if p_outcome not in ('package5', 'package10', 'handover', 'not_continuing') then raise exception 'Unknown outcome'; end if;
  select * into e from public.enquiries where id = p_id;
  if not found then raise exception 'Enquiry not found'; end if;
  if not (public.is_admin() or (public.is_coach() and e.coach_id = public.current_coach_id())) then
    raise exception 'This enquiry is not assigned to you';
  end if;
  update public.enquiries set outcome = p_outcome, outcome_at = now(), status = 'done' where id = p_id;
end $$;
revoke execute on function public.set_enquiry_outcome(uuid, text) from public, anon;
grant execute on function public.set_enquiry_outcome(uuid, text) to authenticated;
