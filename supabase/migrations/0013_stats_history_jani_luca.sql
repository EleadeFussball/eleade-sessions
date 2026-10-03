-- Stats before the app: Jani's sessions are not a coach cost (he is salaried), Luca was paid $55.
-- Written without any removing statements so it can be applied directly.
update public.stats_history set pay = 0 where coach_name = 'Jani';
update public.stats_history set pay = sessions * 55 where coach_name = 'Luca';
