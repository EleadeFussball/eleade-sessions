-- Editing or deleting a package on the player page keeps the MYOB reminder in step.
-- Delete: the reminder goes back to open (or disappears if it no longer applies), so nothing waits for a package that is gone.
-- Edit: the sent invoice line shows the new sessions, analyses, 2:1 sessions and price.
-- Payment received unticked: the reminder waits for payment again.

create or replace function public.sync_reminder_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.invoice_reminders_done
     set package_name = coalesce(new.package_name, package_name),
         sessions = new.sessions_delta, analyses = new.analyses_delta, pairs = new.pairs_delta,
         amount_ex = coalesce(new.amount_paid, amount_ex),
         paid_at = case when new.payment_status = 'awaiting' then null else paid_at end,
         payment_method = case when new.payment_status = 'awaiting' then null else coalesce(new.payment_method, payment_method) end
   where ledger_id = new.id;
  return new;
end $$;
drop trigger if exists ledger_sync_reminder_edit on public.credit_ledger;
create trigger ledger_sync_reminder_edit after update on public.credit_ledger
  for each row when (old.* is distinct from new.*) execute function public.sync_reminder_edit();

create or replace function public.sync_reminder_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.invoice_reminders_done where ledger_id = old.id;
  return old;
end $$;
drop trigger if exists ledger_sync_reminder_delete on public.credit_ledger;
create trigger ledger_sync_reminder_delete before delete on public.credit_ledger
  for each row execute function public.sync_reminder_delete();

revoke execute on function public.sync_reminder_edit(), public.sync_reminder_delete() from public, anon, authenticated;
