-- Coach pay for the 2026 weeks before the app, fixed at the rates Jan gave on 4 Oct 2026:
-- Tyler $60, Paul $60, David $50, Jani $120 per session; $60 per game analysis for everyone.
-- Stored on each row so later rate changes don't rewrite history. Luca has no rate (left empty).
-- Written without any removing statements so it can be applied directly.

alter table public.stats_history add column if not exists pay numeric(10,2);

update public.stats_history set pay = sessions * case coach_name
    when 'Tyler' then 60 when 'Paul' then 60 when 'David' then 50 when 'Jani' then 120 end
 where coach_name is not null;
update public.stats_history set pay = analyses * 60 where coach_name is null;

-- Same analysis rate in the app going forward.
update public.coach_rates set analysis = 60
 where coach_id in (select id from public.coaches where name in ('Tyler', 'Paul', 'David', 'Jani'));
