-- Stripe payments for single sessions, not only assessments.
-- A payment moves through three steps: received -> belongs to a player -> used for one session.
-- "for_what" says whether it pays an assessment or an ordinary session.
-- Written without any removing statements so it can be applied directly.

alter table public.stripe_payments add column if not exists for_what text
  check (for_what in ('assessment', 'session'));

-- Payments recorded so far: tagged assessment links stay assessments; payments Jan assigned by hand
-- are assessments only when the amount is an assessment price (130 + GST), otherwise sessions.
update public.stripe_payments set for_what = case
    when purpose = 'assessment' and assigned_by is null then 'assessment'
    when purpose = 'assessment' and amount_total >= 140 then 'assessment'
    when purpose = 'assessment' then 'session'
  end
 where for_what is null;

insert into public.settings (key, value) values ('stripe_session_link', '""') on conflict (key) do nothing;

-- Match a player's unused payments to sessions waiting for them.
--   assessment payment -> the player's assessment waiting for payment
--   session payment    -> the player's session that the coach marked as paid by Stripe link
create or replace function public.apply_stripe_payments(p_player_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_pay record;
  v_session uuid;
  v_n int := 0;
begin
  for v_pay in
    select id, for_what from public.stripe_payments
     where player_id = p_player_id and applied_session_id is null and for_what is not null
     order by paid_at
  loop
    v_session := null;
    select s.id into v_session
      from public.sessions s join public.session_players sp on sp.session_id = s.id
     where sp.player_id = p_player_id and s.payment_status = 'awaiting'
       and ((v_pay.for_what = 'assessment' and s.format = 'assessment')
         or (v_pay.for_what = 'session' and s.format <> 'assessment' and s.payment_method = 'stripe'))
       and not exists (select 1 from public.stripe_payments x where x.applied_session_id = s.id)
     order by s.session_date, s.logged_at
     limit 1;
    if v_session is null then continue; end if;
    perform set_config('eleade.system', 'on', true);
    update public.sessions set payment_method = 'stripe', payment_status = 'confirmed' where id = v_session;
    perform set_config('eleade.system', 'off', true);
    update public.stripe_payments set applied_session_id = v_session where id = v_pay.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function public.apply_stripe_payments(uuid) from public, anon, authenticated;

-- The webhook: a link tagged "assessment_<player>" or "session_<player>" is matched at once.
create or replace function public.record_stripe_payment(
  p_stripe_session_id text, p_reference text, p_amount_total numeric, p_currency text,
  p_email text, p_name text, p_paid_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid;
  v_for text;
  v_purpose text := 'unknown';
  v_id uuid;
begin
  if p_reference ~ '^(assessment|session)_[0-9a-f-]{36}$' then
    v_for := split_part(p_reference, '_', 1);
    select id into v_player from public.players where id = substring(p_reference from char_length(v_for) + 2)::uuid;
    if v_for = 'assessment' then v_purpose := 'assessment'; end if;
  end if;
  insert into public.stripe_payments (stripe_session_id, purpose, for_what, player_id, amount_total, currency, customer_email, customer_name, paid_at)
  values (p_stripe_session_id, v_purpose, case when v_player is not null then v_for end, v_player,
          p_amount_total, coalesce(p_currency, 'aud'), p_email, p_name, coalesce(p_paid_at, now()))
  on conflict (stripe_session_id) do nothing
  returning id into v_id;
  if v_id is not null and v_player is not null then
    perform public.apply_stripe_payments(v_player);
  end if;
  return v_id;
end $$;
revoke execute on function public.record_stripe_payment(text, text, numeric, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_stripe_payment(text, text, numeric, text, text, text, timestamptz) to service_role;

-- Jan says who paid, and what for.
create or replace function public.assign_stripe_payment_for(p_payment_id uuid, p_player_id uuid, p_for text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can assign payments'; end if;
  if p_for not in ('assessment', 'session') then raise exception 'Choose assessment or session'; end if;
  update public.stripe_payments
     set player_id = p_player_id, for_what = p_for,
         purpose = case when p_for = 'assessment' then 'assessment' else 'unknown' end,
         assigned_by = auth.uid()
   where id = p_payment_id and applied_session_id is null;
  if not found then raise exception 'Payment not found, or already used for a session'; end if;
  perform public.apply_stripe_payments(p_player_id);
end $$;
revoke execute on function public.assign_stripe_payment_for(uuid, uuid, text) from public, anon;
grant execute on function public.assign_stripe_payment_for(uuid, uuid, text) to authenticated;

-- The older two-argument call keeps working: the amount decides what it was for.
create or replace function public.assign_stripe_payment(p_payment_id uuid, p_player_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_amount numeric;
begin
  select amount_total into v_amount from public.stripe_payments where id = p_payment_id;
  perform public.assign_stripe_payment_for(p_payment_id, p_player_id, case when v_amount >= 140 then 'assessment' else 'session' end);
end $$;
revoke execute on function public.assign_stripe_payment(uuid, uuid) from public, anon;
grant execute on function public.assign_stripe_payment(uuid, uuid) to authenticated;

-- Logged sessions a payment could pay for: the paying player's recent sessions with no Stripe payment yet.
create or replace function public.stripe_link_candidates(p_payment_id uuid)
returns table (session_id uuid, session_date date, format text, outcome text, coach_name text, payment_status text)
language sql stable security invoker set search_path = public as $$
  select s.id, s.session_date, s.format, s.outcome, c.name, s.payment_status
    from public.stripe_payments pay
    join public.session_players sp on sp.player_id = pay.player_id
    join public.sessions s on s.id = sp.session_id
    join public.coaches c on c.id = s.coach_id
   where pay.id = p_payment_id and pay.applied_session_id is null
     and not s.imported and public.outcome_counts(s.outcome)
     and s.session_date >= public.today_sydney() - 90
     and coalesce(s.payment_status, '') <> 'confirmed'
     and not exists (select 1 from public.stripe_payments x where x.applied_session_id = s.id)
   order by s.session_date desc
$$;
revoke execute on function public.stripe_link_candidates(uuid) from public, anon;
grant execute on function public.stripe_link_candidates(uuid) to authenticated;

-- Use a received payment for one session. Coaches can do this for their sessions, Jan for any.
create or replace function public.link_stripe_payment(p_payment_id uuid, p_session_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_pay public.stripe_payments%rowtype;
  v_s   public.sessions%rowtype;
begin
  if not (public.is_coach() or public.is_admin()) then raise exception 'Only coaches can link payments'; end if;
  select * into v_pay from public.stripe_payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_pay.applied_session_id is not null then raise exception 'This payment is already used for a session'; end if;
  if v_pay.player_id is null then raise exception 'Jan needs to say who this payment is from first'; end if;
  select * into v_s from public.sessions where id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  if not exists (select 1 from public.session_players where session_id = p_session_id and player_id = v_pay.player_id) then
    raise exception 'That session is not for the player who paid';
  end if;
  if not public.outcome_counts(v_s.outcome) then raise exception 'A session cancelled in time is free, so nothing is paid'; end if;
  if exists (select 1 from public.stripe_payments where applied_session_id = p_session_id) then
    raise exception 'This session already has a Stripe payment';
  end if;
  perform set_config('eleade.system', 'on', true);
  update public.sessions set payment_method = 'stripe', payment_status = 'confirmed' where id = p_session_id;
  perform set_config('eleade.system', 'off', true);
  update public.stripe_payments
     set applied_session_id = p_session_id,
         for_what = case when v_s.format = 'assessment' then 'assessment' else 'session' end
   where id = p_payment_id;
end $$;
revoke execute on function public.link_stripe_payment(uuid, uuid) from public, anon;
grant execute on function public.link_stripe_payment(uuid, uuid) to authenticated;

-- Jan can undo a link made by mistake: the session goes back to waiting for a payment check.
create or replace function public.unlink_stripe_payment(p_payment_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_session uuid;
begin
  if not public.is_admin() then raise exception 'Only Jan can undo a link'; end if;
  select applied_session_id into v_session from public.stripe_payments where id = p_payment_id;
  if v_session is null then return; end if;
  update public.stripe_payments set applied_session_id = null where id = p_payment_id;
  perform set_config('eleade.system', 'on', true);
  update public.sessions set payment_status = 'awaiting' where id = v_session;
  perform set_config('eleade.system', 'off', true);
end $$;
revoke execute on function public.unlink_stripe_payment(uuid) from public, anon;
grant execute on function public.unlink_stripe_payment(uuid) to authenticated;

-- When a session is logged for a player who has already paid, use the payment at once.
create or replace function public.session_players_apply_stripe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.sessions s where s.id = new.session_id and s.payment_status = 'awaiting'
               and (s.format = 'assessment' or s.payment_method = 'stripe'))
     and exists (select 1 from public.stripe_payments where player_id = new.player_id
                    and applied_session_id is null and for_what is not null) then
    perform public.apply_stripe_payments(new.player_id);
  end if;
  return new;
end $$;
revoke execute on function public.session_players_apply_stripe() from public, anon, authenticated;
