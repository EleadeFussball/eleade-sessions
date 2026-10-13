-- Jan can edit or remove any credit entry (package, correction, opening balance) from the player page.
-- Coaches still only add packages; nothing they can change after saving.

alter table public.credit_ledger add column if not exists edited_by uuid;
alter table public.credit_ledger add column if not exists edited_at timestamptz;

create or replace function public.ledger_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if not public.is_admin() and auth.uid() is not null then
      new.payment_status := 'awaiting';   -- a coach records it, Jan confirms it
    end if;
  elsif public.is_admin() then
    -- Jan may correct the entry itself; who and when is kept
    new.player_id := old.player_id; new.created_by := old.created_by; new.created_at := old.created_at;
    if (new.kind, new.sessions_delta, new.analyses_delta, new.pairs_delta, new.package_name, new.amount_paid,
        new.reason, new.effective_date, new.expires_on, new.payment_method)
       is distinct from
       (old.kind, old.sessions_delta, old.analyses_delta, old.pairs_delta, old.package_name, old.amount_paid,
        old.reason, old.effective_date, old.expires_on, old.payment_method) then
      new.edited_by := auth.uid();
      new.edited_at := now();
    end if;
  else
    -- only the payment check may change on an existing ledger row
    new.player_id := old.player_id; new.kind := old.kind;
    new.sessions_delta := old.sessions_delta; new.analyses_delta := old.analyses_delta; new.pairs_delta := old.pairs_delta;
    new.package_name := old.package_name; new.amount_paid := old.amount_paid;
    new.reason := old.reason; new.effective_date := old.effective_date;
    new.expires_on := old.expires_on; new.created_by := old.created_by; new.created_at := old.created_at;
    new.edited_by := old.edited_by; new.edited_at := old.edited_at;
  end if;
  if new.payment_status = 'confirmed' and (tg_op = 'INSERT' or old.payment_status is distinct from 'confirmed') then
    new.confirmed_by := auth.uid();
    new.confirmed_at := now();
  end if;
  return new;
end $$;

drop policy if exists ledger_delete on public.credit_ledger;
create policy ledger_delete on public.credit_ledger for delete to authenticated using (public.is_admin());
grant update, delete on public.credit_ledger to authenticated;
