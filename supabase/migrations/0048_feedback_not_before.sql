-- Player reviews (feedback) are not due before the end of November 2026.
-- The Sep-Oct reviews stay as they are but become due on 30 Nov instead of 25 Oct.
insert into public.settings (key, value) values ('feedback_not_before', '"2026-11-30"') on conflict (key) do update set value = excluded.value;

create or replace function public.feedback_periods() returns table (period_start date, period_end date, due_on date)
language sql stable set search_path = public as $$
  select s::date, (s + interval '2 months' - interval '1 day')::date,
         greatest((s + interval '1 month' + interval '24 days')::date,
                  coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_not_before'), date '2000-01-01'))
    from generate_series(
           date_trunc('month', coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_from'), date '2026-09-01')),
           public.today_sydney(), interval '2 months') s
   where greatest((s + interval '1 month' + interval '24 days')::date,
                  coalesce((select (value #>> '{}')::date from public.settings where key = 'feedback_not_before'), date '2000-01-01')) <= public.today_sydney()
$$;
