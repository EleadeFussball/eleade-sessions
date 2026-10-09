-- Jan's own weekly figures (admin only): salary cost, Elle Academy income and Tyler's Elle commission.
-- The stats page uses them to show what the business generates overall.

create table if not exists public.owner_weeks (
  week_start date primary key check (extract(isodow from week_start) = 1),
  salary_cost numeric(10,2) not null default 0,       -- Jan's gross salary + super for this week
  elle_hours numeric(5,2) not null default 0,
  elle_rate numeric(8,2) not null default 70,
  elle_amount numeric(10,2) not null default 0,       -- paid by Elle Academy to Eleade
  tyler_elle_sessions integer not null default 0,
  tyler_commission_rate numeric(8,2) not null default 20,
  tyler_commission numeric(10,2) not null default 0,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.owner_weeks enable row level security;
drop policy if exists owner_weeks_admin on public.owner_weeks;
create policy owner_weeks_admin on public.owner_weeks for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.owner_weeks to authenticated;
grant select on public.owner_weeks to service_role;

-- Fortnightly $3,500 gross + $420 super = $1,960 a week, from KW41 2026 (week starting 5 Oct 2026).
-- A week without its own row uses the salary of the latest earlier row. Kept here, not in settings, so only Jan can see it.
insert into public.owner_weeks (week_start, salary_cost, elle_hours, elle_amount)
values ('2026-10-05', 1960, 0, 0)
on conflict (week_start) do nothing;
