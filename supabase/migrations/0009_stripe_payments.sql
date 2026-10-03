-- Stripe payments for assessments. A parent pays the assessment Payment Link tagged with the
-- player (client_reference_id = "assessment_<player id>"). The Stripe webhook records it here,
-- and it confirms the player's assessment: straight away if the assessment is already logged,
-- or as soon as it is logged if the parent paid in advance.
-- Written without any removing statements so it can be applied directly.

insert into public.settings (key, value) values ('stripe_assessment_link', '""') on conflict (key) do nothing;

create table public.stripe_payments (
  id                 uuid primary key default gen_random_uuid(),
  stripe_session_id  text not null unique,
  purpose            text not null default 'unknown' check (purpose in ('assessment', 'unknown')),
  player_id          uuid references public.players(id),
  amount_total       numeric(10,2) not null,       -- what the parent paid, incl. GST
  currency           text not null default 'aud',
  customer_email     text,
  customer_name      text,
  paid_at            timestamptz not null default now(),
  applied_session_id uuid references public.sessions(id),
  assigned_by        uuid,
  created_at         timestamptz not null default now()
);
alter table public.stripe_payments enable row level security;
create policy stripe_read on public.stripe_payments for select to authenticated using (public.is_coach());
revoke all on public.stripe_payments from anon, authenticated;
grant select on public.stripe_payments to authenticated;

-- System changes (from Stripe) may set payment fields like Jan can.
create or replace function public.sessions_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean := public.is_admin() or coalesce(current_setting('eleade.system', true), '') = 'on';
  v_charged boolean;
begin
  if tg_op = 'INSERT' then
    new.logged_by := coalesce(auth.uid(), new.logged_by);
    new.logged_at := coalesce(new.logged_at, now());
    if not v_admin then
      new.payment_status := null;
      new.payment_confirmed_by := null;
      new.payment_confirmed_at := null;
    end if;
  else
    new.logged_by := old.logged_by;
    new.logged_at := old.logged_at;
    new.imported  := old.imported;
    if not v_admin then
      new.payment_status := old.payment_status;
      new.payment_confirmed_by := old.payment_confirmed_by;
      new.payment_confirmed_at := old.payment_confirmed_at;
      if new.payment_method is distinct from old.payment_method then
        new.payment_status := null;
        new.payment_confirmed_by := null;
        new.payment_confirmed_at := null;
      end if;
    end if;
  end if;

  v_charged := public.charged_separately(new.format, new.payment_method) and public.outcome_counts(new.outcome);
  if not v_charged then
    new.payment_status := null;
    new.payment_confirmed_by := null;
    new.payment_confirmed_at := null;
  elsif new.payment_status is null then
    new.payment_status := 'awaiting';
  end if;

  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.payment_confirmed_by := auth.uid();
    new.payment_confirmed_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.sessions_stamp() from public, anon, authenticated;

-- Match a player's unused Stripe assessment payments to their assessments waiting for payment.
create or replace function public.apply_stripe_payments(p_player_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_pay record;
  v_session uuid;
  v_n int := 0;
begin
  for v_pay in
    select id from public.stripe_payments
     where player_id = p_player_id and purpose = 'assessment' and applied_session_id is null
     order by paid_at
  loop
    select s.id into v_session
      from public.sessions s join public.session_players sp on sp.session_id = s.id
     where sp.player_id = p_player_id and s.format = 'assessment' and s.payment_status = 'awaiting'
       and not exists (select 1 from public.stripe_payments x where x.applied_session_id = s.id)
     order by s.session_date
     limit 1;
    exit when v_session is null;
    perform set_config('eleade.system', 'on', true);
    update public.sessions set payment_method = 'stripe', payment_status = 'confirmed' where id = v_session;
    perform set_config('eleade.system', 'off', true);
    update public.stripe_payments set applied_session_id = v_session where id = v_pay.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function public.apply_stripe_payments(uuid) from public, anon, authenticated;

-- Called by the Stripe webhook (service role only).
create or replace function public.record_stripe_payment(
  p_stripe_session_id text, p_reference text, p_amount_total numeric, p_currency text,
  p_email text, p_name text, p_paid_at timestamptz
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid;
  v_purpose text := 'unknown';
  v_id uuid;
begin
  if p_reference ~ '^assessment_[0-9a-f-]{36}$' then
    v_purpose := 'assessment';
    select id into v_player from public.players where id = substring(p_reference from 12)::uuid;
  end if;
  insert into public.stripe_payments (stripe_session_id, purpose, player_id, amount_total, currency, customer_email, customer_name, paid_at)
  values (p_stripe_session_id, v_purpose, v_player, p_amount_total, coalesce(p_currency, 'aud'), p_email, p_name, coalesce(p_paid_at, now()))
  on conflict (stripe_session_id) do nothing
  returning id into v_id;
  if v_id is not null and v_player is not null then
    perform public.apply_stripe_payments(v_player);
  end if;
  return v_id;
end $$;
revoke execute on function public.record_stripe_payment(text, text, numeric, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_stripe_payment(text, text, numeric, text, text, text, timestamptz) to service_role;

-- Jan links a payment that came in without a player (e.g. the plain link was used).
create or replace function public.assign_stripe_payment(p_payment_id uuid, p_player_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can assign payments'; end if;
  update public.stripe_payments set player_id = p_player_id, purpose = 'assessment', assigned_by = auth.uid()
   where id = p_payment_id and applied_session_id is null;
  perform public.apply_stripe_payments(p_player_id);
end $$;
revoke execute on function public.assign_stripe_payment(uuid, uuid) from public, anon;
grant execute on function public.assign_stripe_payment(uuid, uuid) to authenticated;

-- When an assessment is logged for a player who already paid, confirm it at once.
create or replace function public.session_players_apply_stripe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.sessions where id = new.session_id and format = 'assessment' and payment_status = 'awaiting')
     and exists (select 1 from public.stripe_payments where player_id = new.player_id and applied_session_id is null and purpose = 'assessment') then
    perform public.apply_stripe_payments(new.player_id);
  end if;
  return new;
end $$;
revoke execute on function public.session_players_apply_stripe() from public, anon, authenticated;
create or replace trigger session_players_apply_stripe after insert on public.session_players
  for each row execute function public.session_players_apply_stripe();
