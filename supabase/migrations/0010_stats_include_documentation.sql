-- Stats: count the sessions from the 2026 documentation files too (sessions and analyses conducted).
-- Their pay and value stay out: they were paid through the old invoices.
-- Written without any removing statements so it can be applied directly.

create or replace view public.stats_sessions with (security_invoker = true) as
select s.id as session_id, s.session_date,
       (s.session_date - ((extract(isodow from s.session_date)::int) - 1))::date as week_start,
       s.coach_id, c.name as coach_name, s.format, s.outcome, s.plan_id is not null as regular,
       (select count(*) from public.session_players sp where sp.session_id = s.id) as players,
       (select string_agg(pl.name, ', ' order by pl.name) from public.session_players sp
          join public.players pl on pl.id = sp.player_id where sp.session_id = s.id) as player_names,
       coalesce(cp.pay, 0) as coach_pay,
       case when s.imported then 0 else
         (select coalesce(sum(public.session_income(s.id, sp.player_id)), 0)
            from public.session_players sp where sp.session_id = s.id) end as est_income,
       s.imported
  from public.sessions s
  join public.coaches c on c.id = s.coach_id
  left join public.coach_pay cp on cp.session_id = s.id
 where public.is_admin();
