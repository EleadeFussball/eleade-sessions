-- 1. Coaches can send an invoice at any time, not only on Sunday. It holds every session not yet invoiced
--    up to the chosen date (never later than today). The invoice shows the Monday of that week to the date.
-- 2. The payment link has a "Player Name" field. The webhook matches it to a player (exact name, ignoring case
--    and spacing) and the payment is then linked to that player's waiting session.
-- Written without any removing statements so it can be applied directly.

create or replace function public.submit_invoice(p_coach_id uuid, p_until date)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_coach public.coaches%rowtype;
  v_det   public.coach_details%rowtype;
  v_total numeric;
  v_n     int;
  v_no    int;
  v_id    uuid;
begin
  if not (public.is_admin() or p_coach_id = public.current_coach_id()) then
    raise exception 'You can only submit your own invoice';
  end if;
  select * into v_coach from public.coaches where id = p_coach_id for update;
  if not found then raise exception 'Coach not found'; end if;
  if v_coach.salaried then raise exception '% is salaried, so no invoice is needed', v_coach.name; end if;
  if p_until > public.today_sydney() then raise exception 'An invoice can only run up to today'; end if;

  select * into v_det from public.coach_details where coach_id = p_coach_id;
  if not v_coach.paid_separately then
    if not found or coalesce(trim(v_det.legal_name), '') = '' or v_det.abn is null or v_det.bsb is null
       or v_det.account_number is null or coalesce(trim(v_det.account_name), '') = '' then
      raise exception 'Add your name, ABN and bank details on the Account page first';
    end if;
  end if;

  if exists (select 1 from public.invoice_draft(p_coach_id, p_until) d where d.no_rate) then
    raise exception 'Some session types have no pay rate yet. Ask Jan to set it on the Team page';
  end if;
  select count(*), coalesce(sum(d.amount), 0) into v_n, v_total from public.invoice_draft(p_coach_id, p_until) d;
  if v_n = 0 or v_total <= 0 then raise exception 'Nothing to invoice up to %', to_char(p_until, 'DD Mon'); end if;

  select coalesce(max(number), 0) + 1 into v_no from public.coach_invoices where coach_id = p_coach_id;
  insert into public.coach_invoices (coach_id, number, period_start, period_end, total, coach_name,
        coach_legal_name, coach_abn, bsb, account_number, account_name, business_name, business_abn, submitted_by)
  values (p_coach_id, v_no, p_until - (extract(isodow from p_until)::int - 1), p_until, v_total, v_coach.name,
          coalesce(nullif(trim(v_det.legal_name), ''), v_coach.name), coalesce(v_det.abn, ''), coalesce(v_det.bsb, ''),
          coalesce(v_det.account_number, ''), coalesce(trim(v_det.account_name), ''),
          (select value #>> '{}' from public.settings where key = 'business_name'),
          nullif((select value #>> '{}' from public.settings where key = 'business_abn'), ''),
          auth.uid())
  returning id into v_id;
  insert into public.invoice_lines (invoice_id, session_id, line_date, description, amount, is_correction)
  select v_id, d.session_id, d.line_date, d.description, d.amount, d.is_correction
    from public.invoice_draft(p_coach_id, p_until) d;
  return v_id;
end $$;
revoke execute on function public.submit_invoice(uuid, date) from public, anon;
grant execute on function public.submit_invoice(uuid, date) to authenticated;

-- ---------------------------------------------------------------- payment link: Player Name
alter table public.stripe_payments add column if not exists player_name_entered text;

create or replace function public.record_stripe_payment_named(
  p_stripe_session_id text, p_reference text, p_amount_total numeric, p_currency text,
  p_email text, p_name text, p_paid_at timestamptz, p_player_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_player uuid;
  v_n int;
  v_clean text := lower(regexp_replace(trim(coalesce(p_player_name, '')), '\s+', ' ', 'g'));
begin
  v_id := public.record_stripe_payment(p_stripe_session_id, p_reference, p_amount_total, p_currency, p_email, p_name, p_paid_at);
  if v_id is null then return null; end if;   -- already recorded
  if coalesce(trim(p_player_name), '') <> '' then
    update public.stripe_payments set player_name_entered = trim(p_player_name) where id = v_id;
  end if;
  -- a tagged link already found the player; otherwise use the name typed on the link
  if v_clean <> '' and (select player_id from public.stripe_payments where id = v_id) is null then
    select count(*), min(id::text)::uuid into v_n, v_player
      from public.players
     where lower(regexp_replace(trim(name), '\s+', ' ', 'g')) = v_clean;
    if v_n = 1 then
      update public.stripe_payments
         set player_id = v_player, for_what = case when p_amount_total >= 140 then 'assessment' else 'session' end,
             purpose = case when p_amount_total >= 140 then 'assessment' else 'unknown' end
       where id = v_id;
      perform public.apply_stripe_payments(v_player);
    end if;
  end if;
  return v_id;
end $$;
revoke execute on function public.record_stripe_payment_named(text, text, numeric, text, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_stripe_payment_named(text, text, numeric, text, text, text, timestamptz, text) to service_role;
