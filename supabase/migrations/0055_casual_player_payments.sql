-- Casual sessions are paid per player. In a 2:1 session each boy can pay on his own day, so Jan confirms
-- a payment for one player without touching the other. The session counts as paid once every player has paid.
create table public.session_player_payments (
  session_id     uuid not null references public.sessions(id) on delete cascade,
  player_id      uuid not null references public.players(id),
  payment_method text check (payment_method in ('stripe', 'cash', 'bank', 'other')),
  confirmed_at   timestamptz not null default now(),
  confirmed_by   uuid references auth.users(id),
  primary key (session_id, player_id)
);
alter table public.session_player_payments enable row level security;
grant select, insert, update, delete on public.session_player_payments to authenticated;
create policy session_player_payments_admin on public.session_player_payments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.confirm_session_player_payment(p_session uuid, p_player uuid, p_method text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only Jan can confirm payments'; end if;
  if not exists (select 1 from public.sessions where id = p_session and payment_status = 'awaiting') then
    raise exception 'This session is not waiting for a payment';
  end if;
  if not exists (select 1 from public.session_players where session_id = p_session and player_id = p_player) then
    raise exception 'That player was not in this session';
  end if;
  insert into public.session_player_payments (session_id, player_id, payment_method, confirmed_by)
  values (p_session, p_player, coalesce(p_method, (select payment_method from public.sessions where id = p_session)), auth.uid())
  on conflict (session_id, player_id) do update set payment_method = excluded.payment_method, confirmed_at = now(), confirmed_by = auth.uid();
  if not exists (select 1 from public.session_players sp where sp.session_id = p_session
                   and not exists (select 1 from public.session_player_payments x where x.session_id = sp.session_id and x.player_id = sp.player_id)) then
    update public.sessions set payment_status = 'confirmed' where id = p_session;
  end if;
end $$;
revoke execute on function public.confirm_session_player_payment(uuid, uuid, text) from public, anon;
grant execute on function public.confirm_session_player_payment(uuid, uuid, text) to authenticated;

-- changing how the session was paid starts the payment check again for everyone
create or replace function public.reset_player_payments() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.payment_method is distinct from old.payment_method then
    delete from public.session_player_payments where session_id = new.id;
  end if;
  return null;
end $$;
revoke execute on function public.reset_player_payments() from public, anon, authenticated;
create trigger sessions_reset_player_payments after update of payment_method on public.sessions
  for each row execute function public.reset_player_payments();

create or replace view public.payments_to_confirm with (security_invoker = true) as
select 'session'::text as kind, s.id as item_id, sp.player_id, p.name, s.session_date as item_date,
       case when s.format = 'assessment' then 'Assessment'
            when s.payment_method = 'cash' then 'Session paid in cash'
            when s.payment_method = 'stripe' then 'Session paid by Stripe link'
            when s.payment_method = 'bank' then 'Session paid by bank transfer'
            else 'Session paid separately' end as what,
       case when s.format = 'assessment'
            then (select (value #>> '{}')::numeric from public.settings where key = 'assessment_price')
            when s.format = '2:1'
            then coalesce(p.pair_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_pair_price'))
            else coalesce(p.session_price, (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))
       end as amount,
       s.payment_method, c.name as recorded_by
  from public.sessions s
  join public.session_players sp on sp.session_id = s.id
  join public.players p on p.id = sp.player_id
  join public.coaches c on c.id = s.coach_id
 where s.payment_status = 'awaiting' and public.is_admin()
   and not exists (select 1 from public.session_player_payments x where x.session_id = s.id and x.player_id = sp.player_id)
union all
select 'package', l.id, l.player_id, p.name, l.effective_date,
       coalesce(l.package_name, 'Package'), l.amount_paid, l.payment_method,
       (select name from public.coaches where user_id = l.created_by)
  from public.credit_ledger l
  join public.players p on p.id = l.player_id
 where l.payment_status = 'awaiting' and public.is_admin();

-- casual sessions that were logged before the player was set to casual get the player's way of paying
do $$
begin
  perform set_config('eleade.system', 'on', true);
  update public.sessions s set payment_method = public.casual_session_method(s.id)
   where s.payment_method is null and not s.imported and s.format not in ('testing', 'assessment')
     and public.outcome_counts(s.outcome) and public.casual_session_method(s.id) is not null;
end $$;
