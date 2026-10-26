-- Behaviour tests for the Eleade schema. Run after shim.sql + migrations on an empty database.
\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- ---------- fixtures (as superuser) ----------
insert into public.coaches (id, name, email, is_admin) values
  ('00000000-0000-0000-0000-0000000000c1', 'Jani',  'jan@test',   true),
  ('00000000-0000-0000-0000-0000000000c2', 'Tyler', 'tyler@test', false),
  ('00000000-0000-0000-0000-0000000000c3', 'Paul',  'paul@test',  false);
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'jan@test'),
  ('00000000-0000-0000-0000-0000000000a2', 'TYLER@test'),
  ('00000000-0000-0000-0000-0000000000a3', 'paul@test'),
  ('00000000-0000-0000-0000-0000000000a9', 'stranger@test');
insert into public.coach_rates (coach_id, one_to_one) values
  ('00000000-0000-0000-0000-0000000000c1', 0),
  ('00000000-0000-0000-0000-0000000000c2', 65),
  ('00000000-0000-0000-0000-0000000000c3', 60);
insert into public.players (id, name, family, billing_model, session_price) values
  ('00000000-0000-0000-0000-0000000000b1', 'Alpha Pack', null, 'package', null),
  ('00000000-0000-0000-0000-0000000000b2', 'Delta Sib', 'Sib', 'package', null),
  ('00000000-0000-0000-0000-0000000000b3', 'Echo Sib', 'Sib', 'package', null),
  ('00000000-0000-0000-0000-0000000000b4', 'Charlie Weekly', null, 'pay_per_session', 130),
  ('00000000-0000-0000-0000-0000000000b5', 'Regular Ray', null, 'package', null);
insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, reason) values
  ('00000000-0000-0000-0000-0000000000b1', 'opening', 5, 1, 'Opening balance'),
  ('00000000-0000-0000-0000-0000000000b2', 'opening', 3, 0, 'Opening balance'),
  ('00000000-0000-0000-0000-0000000000b3', 'opening', 3, 0, 'Opening balance'),
  ('00000000-0000-0000-0000-0000000000b5', 'opening', 10, 0, 'Opening balance');

-- regular player history: sessions 4, 3 and 2 weeks back, nothing last week
insert into public.sessions (id, session_date, coach_id, format, outcome, logged_at) values
  ('00000000-0000-0000-0000-00000000e001', public.today_sydney() - 28, '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended', now()),
  ('00000000-0000-0000-0000-00000000e002', public.today_sydney() - 21, '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended', now()),
  ('00000000-0000-0000-0000-00000000e003', public.today_sydney() - 14, '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended', now());
insert into public.session_players values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000b5'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000b5'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000000b5');
-- imported history must never touch credits
insert into public.sessions (id, session_date, coach_id, format, outcome, imported) values
  ('00000000-0000-0000-0000-00000000f001', date '2026-03-01', '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended', true);
insert into public.session_players values ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-0000000000b1');

-- The tests run at midday Sydney time, whatever the real time is.
create or replace function public.sydney_now() returns timestamp language sql stable as
$$ select public.today_sydney()::timestamp + interval '12 hours' $$;

create temp table results (test text, ok boolean, detail text);
grant all on results to authenticated;

create or replace function pg_temp.check(t text, cond boolean, d text default null) returns void language sql as
$$ insert into results values (t, coalesce(cond, false), d) $$;

-- links by email (case-insensitive)
select pg_temp.check('coach linked to login by email', (select user_id from public.coaches where name='Tyler') = '00000000-0000-0000-0000-0000000000a2');

-- cash kept by coaches is switched on later in this file; keep the older cash tests date-independent
update public.settings set value = '"2999-01-01"' where key = 'cash_kept_from';

-- ---------- as Tyler ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';

select pg_temp.check('coach sees all players', (select count(*) from public.players) = 5);
select pg_temp.check('imported history does not use credits',
  (select sessions_left from public.player_balances where name='Alpha Pack') = 5);

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'Moore Park', null, 'First touch', 'Good scanning', 'Weak foot');
select pg_temp.check('attended 1:1 uses one credit', (select sessions_left from public.player_balances where name='Alpha Pack') = 4);

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'cancelled_in_time',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
select pg_temp.check('cancelled in time is free', (select sessions_left from public.player_balances where name='Alpha Pack') = 4);

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'cancelled_late',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'no_show',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
select pg_temp.check('late cancel and no show use credits', (select sessions_left from public.player_balances where name='Alpha Pack') = 2);

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', 'analysis', 'attended',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
select pg_temp.check('analysis uses an analysis credit, not a session',
  (select sessions_left = 2 and analyses_left = 0 from public.player_balances where name='Alpha Pack'));

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '2:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b3']::uuid[]);
select pg_temp.check('2:1 uses one credit from each player',
  (select bool_and(own_sessions_left = 2) from public.player_balances where family='Sib'));
select pg_temp.check('siblings share one family credit pool',
  (select bool_and(sessions_left = 4) from public.player_balances where family='Sib'));

select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b4']::uuid[]);
select pg_temp.check('pay per session player has no credit balance',
  (select sessions_left is null from public.player_balances where name='Charlie Weekly'));

-- Tyler pay this week: 65 (attended) + 0 (in time) + 65 + 65 + 60 (analysis) + 70 (2:1) + 65 (payg) = 390
select pg_temp.check('coach pay: rates, group paid once, in-time cancel unpaid',
  (select sum(pay) from public.coach_pay where session_date = public.today_sydney()) = 390,
  (select sum(pay)::text from public.coach_pay where session_date = public.today_sydney()));
select pg_temp.check('coach sees only own rate', (select count(*) from public.coach_rates) = 1);
select pg_temp.check('coach sees only own pay rows', (select bool_and(coach_name='Tyler') from public.coach_pay));
select pg_temp.check('coach cannot see weekly payments owed', (select count(*) from public.payg_weeks) = 0);
select pg_temp.check('coach can see sessions logged by others', (select count(*) from public.sessions where coach_id='00000000-0000-0000-0000-0000000000c3') = 3);

do $$ begin
  begin
    insert into public.credit_ledger (player_id, kind, sessions_delta, reason)
    values ('00000000-0000-0000-0000-0000000000b1', 'free', 1, 'Coach giving free session');
    perform pg_temp.check('coach cannot add credits', false);
  exception when others then perform pg_temp.check('coach cannot add credits', true, sqlerrm);
  end;
  begin
    perform public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended',
      array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
    perform pg_temp.check('coach cannot log under another coach''s name', false);
  exception when others then perform pg_temp.check('coach cannot log under another coach''s name', true, sqlerrm);
  end;
  begin
    perform public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
      array['00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2']::uuid[]);
    perform pg_temp.check('1:1 with two players is refused', false);
  exception when others then perform pg_temp.check('1:1 with two players is refused', true, sqlerrm);
  end;
  begin
    perform public.log_session(public.today_sydney() + 1, '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
      array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
    perform pg_temp.check('future date is refused', false);
  exception when others then perform pg_temp.check('future date is refused', true, sqlerrm);
  end;
end $$;

-- Tyler logs a cover session for Paul's regular player under his own name: allowed
select public.log_session(public.today_sydney() - 35, '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b5']::uuid[]);
select pg_temp.check('coach can log a cover session for any player', (select sessions_left from public.player_balances where name='Regular Ray') = 6);

with u as (update public.sessions set topic = 'hacked' where coach_id = '00000000-0000-0000-0000-0000000000c3' returning 1)
select pg_temp.check('coach cannot edit another coach''s session', (select count(*) from u) = 0);
with u as (update public.sessions set topic = 'Edited own note' where coach_id = '00000000-0000-0000-0000-0000000000c2' and format='analysis' returning 1)
select pg_temp.check('coach can edit own recent session', (select count(*) from u) = 1);
with u as (delete from public.sessions where imported returning 1)
select pg_temp.check('coach cannot delete imported history', (select count(*) from u) = 0);

insert into public.player_notes (player_id, body) values ('00000000-0000-0000-0000-0000000000b1', 'Prefers left side');
select pg_temp.check('coach can add a profile note', (select count(*) from public.player_notes) = 1);

-- ---------- assessments and coach-recorded packages (as Tyler) ----------
insert into public.players (id, name, main_coach_id) values
  ('00000000-0000-0000-0000-0000000000b9', 'New Kid', '00000000-0000-0000-0000-0000000000c2');
select pg_temp.check('coach can add a new player', exists (select 1 from public.players where name = 'New Kid'));
insert into public.players (name) values ('  Typo   nme ');
select pg_temp.check('new player names are tidied', exists (select 1 from public.players where name = 'Typo nme'));
select public.rename_player((select id from public.players where name = 'Typo nme'), 'Typo Name');
select pg_temp.check('coach can rename a player they added', exists (select 1 from public.players where name = 'Typo Name'));
do $$ begin
  begin
    perform public.rename_player('00000000-0000-0000-0000-0000000000b1', 'Someone Else');
    perform pg_temp.check('coach cannot rename a player someone else added', false);
  exception when others then perform pg_temp.check('coach cannot rename a player someone else added', true);
  end;
  begin
    perform public.rename_player('00000000-0000-0000-0000-0000000000b9', 'alpha pack');
    perform pg_temp.check('renaming to an existing name is refused', false);
  exception when others then perform pg_temp.check('renaming to an existing name is refused', true);
  end;
end $$;
do $$ begin
  begin
    insert into public.players (name, opening_confirmed) values ('Sneaky', true);
    perform pg_temp.check('coach cannot add a player with a confirmed balance', false);
  exception when others then perform pg_temp.check('coach cannot add a player with a confirmed balance', true);
  end;
end $$;
select public.log_session(public.today_sydney() - 2, '00000000-0000-0000-0000-0000000000c2', 'assessment', 'attended',
  array['00000000-0000-0000-0000-0000000000b9']::uuid[], 'Moore Park', null, 'Assessment', 'Strong left foot', null, 'stripe');
select pg_temp.check('assessment is awaiting payment check',
  (select payment_status = 'awaiting' and payment_method = 'stripe' from public.sessions where format = 'assessment'));
select pg_temp.check('assessment pays the coach their 1:1 rate',
  (select pay from public.coach_pay where format = 'assessment') = 65);
select pg_temp.check('assessment uses no package credits',
  (select sessions_left from public.player_balances where name = 'New Kid') = 0);
update public.sessions set payment_status = 'confirmed' where format = 'assessment';
select pg_temp.check('coach cannot mark an assessment as paid',
  (select payment_status from public.sessions where format = 'assessment') = 'awaiting');
do $$ begin
  begin
    perform public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', 'assessment', 'attended',
      array['00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000b1']::uuid[]);
    perform pg_temp.check('assessment with two players is refused', false);
  exception when others then perform pg_temp.check('assessment with two players is refused', true);
  end;
end $$;

insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, package_name, amount_paid, payment_method, reason)
  values ('00000000-0000-0000-0000-0000000000b9', 'purchase', 5, 0, '5 pack', 650, 'stripe', 'Bought 5 pack after assessment');
select public.log_session(public.today_sydney() - 2, '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b4']::uuid[], null, null, null, null, null, 'cash');
select pg_temp.check('a cash session waits for Jan to confirm the cash',
  (select payment_status from public.sessions where payment_method = 'cash') = 'awaiting');
select pg_temp.check('a cash session from a weekly payer is not added to their transfer',
  not exists (select 1 from public.credit_usage cu join public.sessions s on s.id = cu.session_id where s.payment_method = 'cash'));
select pg_temp.check('coach-recorded package adds credits straight away',
  (select sessions_left from public.player_balances where name = 'New Kid') = 5);
select pg_temp.check('coach-recorded package awaits payment check',
  (select payment_status from public.credit_ledger where reason = 'Bought 5 pack after assessment') = 'awaiting');
do $$ begin
  begin
    insert into public.credit_ledger (player_id, kind, sessions_delta, reason, payment_status)
    values ('00000000-0000-0000-0000-0000000000b9', 'free', 1, 'free one', 'confirmed');
    perform pg_temp.check('coach cannot give free sessions', false);
  exception when others then perform pg_temp.check('coach cannot give free sessions', true);
  end;
end $$;
with u as (update public.credit_ledger set payment_status = 'confirmed' where reason = 'Bought 5 pack after assessment' returning 1)
select pg_temp.check('coach cannot confirm a package payment', (select count(*) from u) = 0);
select pg_temp.check('coach cannot see the payments to confirm', (select count(*) from public.payments_to_confirm) = 0);
select public.log_session(public.today_sydney() - 1, '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b9']::uuid[], null, null, 'Stripe paid', null, null, 'stripe');
select pg_temp.check('a session paid by Stripe link uses no credit and waits for a check',
  (select sessions_left from public.player_balances where name = 'New Kid') = 5
  and (select payment_status from public.sessions where topic = 'Stripe paid') = 'awaiting');
update public.sessions set payment_method = null where topic = 'Stripe paid';
select pg_temp.check('switching a session to package credit uses a credit and clears the payment check',
  (select sessions_left from public.player_balances where name = 'New Kid') = 4
  and (select payment_status from public.sessions where topic = 'Stripe paid') is null);
update public.sessions set payment_method = 'cash' where topic = 'Stripe paid';
select pg_temp.check('switching back to cash frees the credit and asks for a check again',
  (select sessions_left from public.player_balances where name = 'New Kid') = 5
  and (select payment_status from public.sessions where topic = 'Stripe paid') = 'awaiting');
update public.sessions set payment_method = null where topic = 'Stripe paid';

-- ---------- regular sessions (as Tyler, then Paul) ----------
insert into public.players (id, name) values ('00000000-0000-0000-0000-0000000000ba', 'Plan Kid');
select public.create_plan('00000000-0000-0000-0000-0000000000c2', '1:1', extract(isodow from public.today_sydney())::int,
  '00:00', array['00000000-0000-0000-0000-0000000000ba']::uuid[], 'Moore Park', public.today_sydney() - 7);
select public.set_plan_minutes((select id from public.session_plans limit 1), 15);
select pg_temp.check('a weekly plan produces one session per week',
  (select count(*) from public.plan_occurrences(public.today_sydney() - 7, public.today_sydney())) = 2);
select public.confirm_plan_session((select id from public.session_plans limit 1), public.today_sydney(), 'attended', 'Passing', 'Good', null);
select pg_temp.check('confirming a planned session logs it with the plan details',
  (select s.location = 'Moore Park' and s.start_time = '00:00' and s.coach_id = '00000000-0000-0000-0000-0000000000c2'
     from public.sessions s where s.plan_date = public.today_sydney()));
select pg_temp.check('a confirmed planned session shows as handled',
  (select session_id is not null from public.plan_occurrences(public.today_sydney(), public.today_sydney())));
do $$ begin
  begin
    perform public.confirm_plan_session((select id from public.session_plans limit 1), public.today_sydney(), 'attended');
    perform pg_temp.check('a planned session cannot be confirmed twice', false);
  exception when others then perform pg_temp.check('a planned session cannot be confirmed twice', true);
  end;
  begin
    perform public.confirm_plan_session((select id from public.session_plans limit 1), public.today_sydney() + 7, 'attended');
    perform pg_temp.check('a future planned session cannot be confirmed', false);
  exception when others then perform pg_temp.check('a future planned session cannot be confirmed', true);
  end;
end $$;
select public.move_plan_session((select id from public.session_plans limit 1), public.today_sydney() - 7, public.today_sydney() - 6, '17:00');
select pg_temp.check('a moved session appears on its new day and time',
  (select session_date = public.today_sydney() - 6 and start_time = '17:00' and moved
     from public.plan_occurrences(public.today_sydney() - 7, public.today_sydney()) where plan_date = public.today_sydney() - 7));
select public.confirm_plan_session((select id from public.session_plans limit 1), public.today_sydney() - 7, 'cancelled_late');
select pg_temp.check('a planned session can be recorded as a late cancellation on its moved date',
  (select outcome = 'cancelled_late' and session_date = public.today_sydney() - 6 from public.sessions where plan_date = public.today_sydney() - 7));

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  begin
    perform public.move_plan_session((select id from public.session_plans limit 1), public.today_sydney() + 7, public.today_sydney() + 8, '07:00');
    perform pg_temp.check('another coach cannot move someone else''s regular session', false);
  exception when others then perform pg_temp.check('another coach cannot move someone else''s regular session', true);
  end;
end $$;
with u as (update public.session_plans set ends_on = public.today_sydney() returning 1)
select pg_temp.check('another coach cannot stop someone else''s regular session', (select count(*) from u) = 0);
select pg_temp.check('every coach can see the regular sessions', (select count(*) from public.session_plans) = 1);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
update public.session_plans set ends_on = public.today_sydney();
select pg_temp.check('a stopped regular session produces no future sessions',
  (select count(*) from public.plan_occurrences(public.today_sydney() + 1, public.today_sydney() + 30)) = 0);
select pg_temp.check('stopping keeps the history',
  (select count(*) from public.plan_occurrences(public.today_sydney() - 7, public.today_sydney())) = 2);

-- ---------- stranger (logged in, not a coach) ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a9';
select pg_temp.check('non-coach login sees no players', (select count(*) from public.players) = 0);
select pg_temp.check('non-coach login sees no sessions', (select count(*) from public.sessions) = 0);

-- ---------- as Jan (admin) ----------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('admin sees every coach rate', (select count(*) from public.coach_rates) = 3);
select pg_temp.check('admin sees what weekly families owe',
  (select outstanding from public.payg_weeks where name='Charlie Weekly') = 130,
  (select string_agg(outstanding::text, ',') from public.payg_weeks));
insert into public.payments (player_id, week_start, amount)
  select '00000000-0000-0000-0000-0000000000b4', week_start, 130 from public.payg_weeks where name='Charlie Weekly';
select pg_temp.check('marking a week paid clears it', (select outstanding from public.payg_weeks where name='Charlie Weekly') = 0);
insert into public.credit_ledger (player_id, kind, sessions_delta, reason, package_name, amount_paid)
  values ('00000000-0000-0000-0000-0000000000b1', 'purchase', 5, 'Bought 5 pack', '5 pack', 650);
select pg_temp.check('admin purchase adds credits', (select sessions_left from public.player_balances where name='Alpha Pack') = 7);
do $$ begin
  begin
    insert into public.credit_ledger (player_id, kind, sessions_delta, reason) values ('00000000-0000-0000-0000-0000000000b1', 'free', 1, '  ');
    perform pg_temp.check('credit change without reason is refused', false);
  exception when others then perform pg_temp.check('credit change without reason is refused', true);
  end;
end $$;
select pg_temp.check('ledger records who made the change',
  (select created_by from public.credit_ledger where kind='purchase' and reason='Bought 5 pack') = '00000000-0000-0000-0000-0000000000a1');
select pg_temp.check('regular player with no session last week is flagged',
  exists (select 1 from public.missing_sessions where name='Regular Ray'), (select string_agg(name, ',') from public.missing_sessions));
select pg_temp.check('a player who trained this week is not flagged',
  not exists (select 1 from public.missing_sessions where name='Alpha Pack'));
select pg_temp.check('low-volume players are not flagged',
  not exists (select 1 from public.missing_sessions where name='Alpha Pack'));

-- ---------- payment checks (as Jan) ----------
select pg_temp.check('Jan sees the assessment and the package to confirm',
  (select count(*) from public.payments_to_confirm where name = 'New Kid') = 2);
select pg_temp.check('Jan sees the cash session to confirm, at the player''s price',
  (select amount from public.payments_to_confirm where what = 'Session paid in cash') = 130);
select pg_temp.check('the weekly payer owes nothing extra for the cash session',
  (select coalesce(sum(sessions), 0) from public.payg_weeks where name = 'Charlie Weekly') = 1);
update public.sessions set payment_status = 'confirmed' where payment_method = 'cash';
update public.sessions set payment_status = 'confirmed' where format = 'assessment';
update public.credit_ledger set payment_status = 'confirmed' where reason = 'Bought 5 pack after assessment';
select pg_temp.check('confirming clears the list', (select count(*) from public.payments_to_confirm) = 0);
select pg_temp.check('confirmation records who and when',
  (select confirmed_by = '00000000-0000-0000-0000-0000000000a1' and confirmed_at is not null
     from public.credit_ledger where reason = 'Bought 5 pack after assessment'));
update public.credit_ledger set reason = 'Bought 5 pack after assessment (edited)' where reason = 'Bought 5 pack after assessment';
update public.credit_ledger set reason = 'Bought 5 pack after assessment' where reason = 'Bought 5 pack after assessment (edited)';
select pg_temp.check('Jan''s own changes to credit history are stamped with who and when',
  (select edited_by = '00000000-0000-0000-0000-0000000000a1' and edited_at is not null from public.credit_ledger where reason = 'Bought 5 pack after assessment'));

select public.rename_player('00000000-0000-0000-0000-0000000000b3', 'Echo Sibling');
select pg_temp.check('Jan can rename any player', exists (select 1 from public.players where name = 'Echo Sibling'));

-- ---------- coach invoices ----------
reset role;
create or replace function pg_temp.last_sun() returns date language sql stable as
$$ select public.today_sydney() - extract(isodow from public.today_sydney())::int $$;
update public.settings set value = to_jsonb((public.today_sydney() - 60)::text) where key = 'invoices_from';
update public.settings set value = '"2999-01-01"' where key = 'docs_required_from';  -- the documentation rule has its own test
update public.coaches set salaried = true where name = 'Jani';
insert into public.coaches (id, name, email) values ('00000000-0000-0000-0000-0000000000c4', 'David', 'david@test');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a4', 'david@test');
insert into public.coach_rates (coach_id, one_to_one, two_to_one) values ('00000000-0000-0000-0000-0000000000c4', 50, 70);
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-0000000d0001', pg_temp.last_sun() - 2, '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended'),
  ('00000000-0000-0000-0000-0000000d0002', pg_temp.last_sun() - 1, '00000000-0000-0000-0000-0000000000c4', '2:1', 'no_show'),
  ('00000000-0000-0000-0000-0000000d0003', pg_temp.last_sun() - 1, '00000000-0000-0000-0000-0000000000c4', '1:1', 'cancelled_in_time'),
  ('00000000-0000-0000-0000-0000000d0004', pg_temp.last_sun() + 1, '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended');
insert into public.session_players values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000000b1');

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.check('invoice draft holds the week''s paid sessions only',
  (select count(*) = 2 and sum(amount) = 120 from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun())));
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun());
    perform pg_temp.check('no invoice without ABN and bank details', false);
  exception when others then perform pg_temp.check('no invoice without ABN and bank details', sqlerrm like 'Add your name%');
  end;
end $$;
insert into public.coach_details (coach_id, legal_name, abn, bsb, account_number, account_name)
values ('00000000-0000-0000-0000-0000000000c4', 'David Test', '51824753556', '082001', '123456789', 'D Test');
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun() + 14);
    perform pg_temp.check('no invoice for a week that has not finished', false);
  exception when others then perform pg_temp.check('no invoice for a week that has not finished', true);
  end;
end $$;
select public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun()) as inv1 \gset
select pg_temp.check('coach submits the weekly invoice',
  (select total = 120 and number = 1 and coach_abn = '51824753556' from public.coach_invoices where id = :'inv1'));
select pg_temp.check('invoice has one line per paid session', (select count(*) from public.invoice_lines) = 2);
select pg_temp.check('nothing left to invoice after submitting',
  not exists (select 1 from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun())));
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun());
    perform pg_temp.check('the same week cannot be invoiced twice', false);
  exception when others then perform pg_temp.check('the same week cannot be invoiced twice', sqlerrm like 'Nothing to invoice%');
  end;
end $$;
do $$ begin
  begin
    insert into public.coach_invoices (coach_id, number, period_start, period_end, total, coach_name, coach_legal_name, coach_abn, bsb, account_number, account_name)
    values ('00000000-0000-0000-0000-0000000000c4', 9, current_date, current_date, 999, 'x', 'x', '1', '1', '1', '1');
    perform pg_temp.check('coaches cannot write invoices directly', false);
  exception when others then perform pg_temp.check('coaches cannot write invoices directly', true);
  end;
  begin
    perform public.mark_invoices_paid(array(select id from public.coach_invoices));
    perform pg_temp.check('coaches cannot mark invoices paid', false);
  exception when others then perform pg_temp.check('coaches cannot mark invoices paid', true);
  end;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.check('other coaches cannot see an invoice or bank details',
  (select count(*) from public.coach_invoices) = 0 and (select count(*) from public.coach_details) = 0);
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun());
    perform pg_temp.check('a coach cannot submit another coach''s invoice', false);
  exception when others then perform pg_temp.check('a coach cannot submit another coach''s invoice', sqlerrm like 'You can only%');
  end;
end $$;

-- a change after invoicing becomes a correction on the next invoice
reset role;
update public.sessions set outcome = 'cancelled_in_time' where id = '00000000-0000-0000-0000-0000000d0002';
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-0000000d0005', pg_temp.last_sun() - 3, '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended'),
  ('00000000-0000-0000-0000-0000000d0006', pg_temp.last_sun(), '00000000-0000-0000-0000-0000000000c4', '2:1', 'attended');
insert into public.session_players values
  ('00000000-0000-0000-0000-0000000d0005', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000d0006', '00000000-0000-0000-0000-0000000000b1');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.check('a changed session shows as a correction',
  (select amount = -70 and is_correction and description like 'Correction:%'
     from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun()) where session_id = '00000000-0000-0000-0000-0000000d0002'));
select public.submit_invoice('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun()) as inv2 \gset
select pg_temp.check('second invoice nets the correction',
  (select total = 50 and number = 2 from public.coach_invoices where id = :'inv2'));

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c1', pg_temp.last_sun());
    perform pg_temp.check('salaried staff do not invoice', false);
  exception when others then perform pg_temp.check('salaried staff do not invoice', sqlerrm like '%salaried%');
  end;
end $$;
select pg_temp.check('salaried staff have no session pay',
  coalesce((select sum(pay) from public.coach_pay where coach_name = 'Jani'), 0) = 0);
select pg_temp.check('Jan sees every invoice', (select count(*) from public.coach_invoices) = 2);
select pg_temp.check('Jan marks invoices paid', public.mark_invoices_paid(array(select id from public.coach_invoices)) = 2);
select pg_temp.check('Jan reads the bank file settings', (select user_id_number from public.bank_file_settings) = '000000');

-- ---------- stats and expiry ----------
reset role;
insert into public.credit_ledger (player_id, kind, sessions_delta, package_name, amount_paid, reason, effective_date, expires_on) values
  ('00000000-0000-0000-0000-0000000000b5', 'purchase', 5, '5 pack', 600, 'Stats test pack', public.today_sydney() - 60, public.today_sydney() + 10);
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-00000000aa01', public.today_sydney(), '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended'),
  ('00000000-0000-0000-0000-00000000aa02', public.today_sydney(), '00000000-0000-0000-0000-0000000000c3', '1:1', 'cancelled_late');
insert into public.session_players values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b5'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000b5');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('package session is valued at the package price per session',
  (select est_income from public.stats_sessions where session_id = '00000000-0000-0000-0000-00000000aa01') = 120);
select pg_temp.check('a late cancellation still counts as income and pay',
  (select est_income = 120 and coach_pay = 60 from public.stats_sessions where session_id = '00000000-0000-0000-0000-00000000aa02'));
select pg_temp.check('weekly payer is valued at their session price',
  exists (select 1 from public.stats_sessions where player_names = 'Charlie Weekly' and est_income = 130));
select pg_temp.check('money in includes the package bought',
  exists (select 1 from public.stats_money_in where source = 'Packages' and amount = 600));
select pg_temp.check('package expiring with credits left is flagged',
  exists (select 1 from public.expiring_packages where name = 'Regular Ray' and days_left = 10));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.check('coaches cannot see the business numbers',
  (select count(*) from public.stats_sessions) = 0 and (select count(*) from public.stats_money_in) = 0);
select pg_temp.check('coaches see expiring packages', exists (select 1 from public.expiring_packages where name = 'Regular Ray'));

-- ---------- stripe assessment payments ----------
reset role;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-00000000bb01', public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', 'assessment', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000b1');
select pg_temp.check('a new assessment waits for payment',
  (select payment_status from public.sessions where id = '00000000-0000-0000-0000-00000000bb01') = 'awaiting');
select public.record_stripe_payment('cs_test_1', 'assessment_00000000-0000-0000-0000-0000000000b1', 143, 'aud', 'parent@test', 'A Parent', now());
select pg_temp.check('Stripe payment confirms the logged assessment',
  (select payment_status = 'confirmed' and payment_method = 'stripe' from public.sessions where id = '00000000-0000-0000-0000-00000000bb01'));
select pg_temp.check('a repeated Stripe notice is ignored',
  public.record_stripe_payment('cs_test_1', 'assessment_00000000-0000-0000-0000-0000000000b1', 143, 'aud', null, null, now()) is null
  and (select count(*) from public.stripe_payments) = 1);
select public.record_stripe_payment('cs_test_2', 'assessment_00000000-0000-0000-0000-0000000000b5', 143, 'aud', null, null, now());
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-00000000bb02', public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', 'assessment', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-0000000000b5');
select pg_temp.check('paid in advance: the assessment is confirmed when logged',
  (select payment_status from public.sessions where id = '00000000-0000-0000-0000-00000000bb02') = 'confirmed');
select public.record_stripe_payment('cs_test_3', null, 143, 'aud', 'other@test', 'Other Parent', now());
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-00000000bb03', public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', 'assessment', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-0000000000b3');
select pg_temp.check('a payment without a player stays unmatched',
  (select purpose = 'unknown' and player_id is null from public.stripe_payments where stripe_session_id = 'cs_test_3')
  and (select payment_status from public.sessions where id = '00000000-0000-0000-0000-00000000bb03') = 'awaiting');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin
    perform public.record_stripe_payment('cs_fake', 'assessment_00000000-0000-0000-0000-0000000000b3', 143, 'aud', null, null, now());
    perform pg_temp.check('coaches cannot fake a Stripe payment', false);
  exception when others then perform pg_temp.check('coaches cannot fake a Stripe payment', true);
  end;
  begin
    perform public.assign_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_test_3'), '00000000-0000-0000-0000-0000000000b3');
    perform pg_temp.check('coaches cannot assign Stripe payments', false);
  exception when others then perform pg_temp.check('coaches cannot assign Stripe payments', true);
  end;
end $$;
select pg_temp.check('coaches see Stripe payments', (select count(*) from public.stripe_payments) = 3);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.assign_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_test_3'), '00000000-0000-0000-0000-0000000000b3');
select pg_temp.check('Jan assigns an unmatched payment and it confirms the assessment',
  (select payment_status from public.sessions where id = '00000000-0000-0000-0000-00000000bb03') = 'confirmed');
select pg_temp.check('Stripe-confirmed assessments are not on the Monday list',
  not exists (select 1 from public.payments_to_confirm where item_id in ('00000000-0000-0000-0000-00000000bb01','00000000-0000-0000-0000-00000000bb02','00000000-0000-0000-0000-00000000bb03')));

select pg_temp.check('stats count documented sessions without pay or value',
  (select imported and est_income = 0 and coach_pay = 0 from public.stats_sessions where session_id = '00000000-0000-0000-0000-00000000f001'));

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('Abrechnung history: week 38 has 53 sessions',
  (select sum(sessions) from public.stats_history where iso_week = 38) = 53);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('coaches cannot read the history', (select count(*) from public.stats_history) = 0);

-- ---------- calendar: one-off bookings ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select sessions_left as bal_alpha from public.player_balances where name = 'Alpha Pack' \gset
select sessions_left as bal_delta from public.player_balances where name = 'Delta Sib' \gset
select public.create_booking('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '16:00', '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'Moore Park', 'Bring cones') as bk \gset
select pg_temp.check('a one-off session is on the schedule',
  (select count(*) from public.calendar(public.today_sydney(), public.today_sydney())
    where kind = 'once' and ref_id = :'bk' and players = 'Alpha Pack' and location = 'Moore Park') = 1);
select pg_temp.check('a planned session uses no credit yet',
  (select sessions_left from public.player_balances where name = 'Alpha Pack') = :bal_alpha);
do $$ begin
  begin
    perform public.create_booking('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '17:00', '1:1',
      array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2']::uuid[]);
    perform pg_temp.check('a 1:1 cannot hold two players', false);
  exception when others then perform pg_temp.check('a 1:1 cannot hold two players', true);
  end;
end $$;
select public.move_booking(:'bk', public.today_sydney(), time '17:30');
select pg_temp.check('a one-off session can be moved',
  (select start_time from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk') = time '17:30');

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  begin
    perform public.move_booking((select id from public.bookings order by created_at limit 1), public.today_sydney(), time '18:00');
    perform pg_temp.check('another coach cannot move it', false);
  exception when others then perform pg_temp.check('another coach cannot move it', true);
  end;
end $$;
select pg_temp.check('every coach sees the schedule',
  (select count(*) from public.calendar(public.today_sydney(), public.today_sydney()) where kind = 'once') = 1);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.reschedule('once', :'bk', null, public.today_sydney(), time '00:00', 15);
select public.confirm_booking(:'bk', 'attended', 'Finishing', 'Sharp today', 'Weak foot') as sid \gset
select pg_temp.check('confirming a one-off session logs it and uses a credit',
  (select sessions_left from public.player_balances where name = 'Alpha Pack') = :bal_alpha - 1
  and (select topic from public.sessions where id = :'sid') = 'Finishing');
select pg_temp.check('the schedule shows it as done',
  (select outcome from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk') = 'attended');
do $$ begin
  begin
    perform public.confirm_booking((select id from public.bookings where session_id is not null limit 1), 'attended');
    perform pg_temp.check('a session cannot be confirmed twice', false);
  exception when others then perform pg_temp.check('a session cannot be confirmed twice', sqlerrm like '%already confirmed%');
  end;
end $$;
select public.create_booking('00000000-0000-0000-0000-0000000000c2', public.today_sydney() + 3, time '16:00', '2:1',
  array['00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b3']::uuid[]) as bk2 \gset
do $$ begin
  begin
    perform public.confirm_booking((select id from public.bookings where session_id is null and cancelled_at is null limit 1), 'attended');
    perform pg_temp.check('a future session cannot be confirmed yet', false);
  exception when others then perform pg_temp.check('a future session cannot be confirmed yet', sqlerrm like '%future%');
  end;
end $$;
select public.cancel_booking(:'bk2');
select pg_temp.check('a cancelled plan leaves the calendar and charges nobody',
  not exists (select 1 from public.calendar(public.today_sydney(), public.today_sydney() + 7) where ref_id = :'bk2')
  and (select sessions_left from public.player_balances where name = 'Delta Sib') = :bal_delta);

-- ---------- durations on the calendar ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '07:00', 90, '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], null, null) as bk3 \gset
select pg_temp.check('a session can be longer than an hour',
  (select minutes from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk3') = 90);
select public.reschedule('once', :'bk3', null, public.today_sydney(), time '08:00', 60);
select pg_temp.check('moving can change the length too',
  (select start_time = time '08:00' and minutes = 60 from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk3'));
select pg_temp.check('a session planned without a length runs an hour',
  (select minutes from public.bookings where id = :'bk3') = 60);
do $$ begin
  begin
    perform public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '09:00', 1000, '1:1',
      array['00000000-0000-0000-0000-0000000000b1']::uuid[], null, null);
    perform pg_temp.check('a session cannot run for eight hours plus', false);
  exception when others then perform pg_temp.check('a session cannot run for eight hours plus', true);
  end;
end $$;
select public.reschedule('once', :'bk3', null, public.today_sydney(), time '00:00', 60);
select public.confirm_booking(:'bk3', 'attended') as sid3 \gset
select pg_temp.check('the logged session keeps the planned length',
  (select minutes from public.sessions where id = :'sid3') = 60);
select pg_temp.check('a session logged on its own shows on the calendar',
  exists (select 1 from public.calendar(public.today_sydney() - 28, public.today_sydney())
           where kind = 'logged' and ref_id = '00000000-0000-0000-0000-00000000e001'));
select pg_temp.check('a confirmed plan is not listed twice',
  (select count(*) from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk3') = 1);


-- ---------- completing a session: five minutes after it ends ----------
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '23:30', 15, '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], null, null) as bkl \gset
do $$ begin
  begin
    perform public.confirm_booking((select id from public.bookings where start_time = time '23:30' and session_id is null limit 1), 'attended');
    perform pg_temp.check('a coach cannot complete a session before it has ended', false);
  exception when others then perform pg_temp.check('a coach cannot complete a session before it has ended', sqlerrm like '%five minutes after it ends%');
  end;
end $$;
select public.confirm_booking(:'bkl', 'cancelled_late');
select pg_temp.check('a late cancellation can be recorded before the session time',
  (select outcome from public.sessions where id = (select session_id from public.bookings where id = :'bkl')) = 'cancelled_late');
select public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney(), time '23:30', 15, '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], null, null) as bkl2 \gset
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.confirm_booking(:'bkl2', 'attended');
select pg_temp.check('Jan can complete a session at any time',
  (select outcome from public.sessions where id = (select session_id from public.bookings where id = :'bkl2')) = 'attended');

-- ---------- Stripe payments for single sessions ----------
reset role;
insert into public.players (id, name) values
  ('00000000-0000-0000-0000-0000000000c9', 'Noah Test'),
  ('00000000-0000-0000-0000-0000000000ca', 'Prepaid Pat'),
  ('00000000-0000-0000-0000-0000000000cb', 'Later Larry');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.log_session(public.today_sydney() - 1, '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000c9']::uuid[]) as noah_s \gset
select pg_temp.check('a session logged without payment uses a credit (balance goes below zero)',
  (select sessions_left from public.player_balances where name = 'Noah Test') = -1);
reset role;
select public.record_stripe_payment('cs_sess_1', null, 132, 'aud', 'noah@test', 'Noah Parent', now());
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.assign_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'), '00000000-0000-0000-0000-0000000000c9');
select pg_temp.check('a 132 dollar payment assigned by Jan is a session payment, not an assessment',
  (select for_what = 'session' and player_id is not null and applied_session_id is null from public.stripe_payments where stripe_session_id = 'cs_sess_1'));
select pg_temp.check('the payment lists the player''s session as a candidate',
  exists (select 1 from public.stripe_link_candidates((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1')) where session_id = :'noah_s'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.link_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'), :'noah_s');
select pg_temp.check('linking marks the session paid by Stripe and confirmed',
  (select payment_method = 'stripe' and payment_status = 'confirmed' from public.sessions where id = :'noah_s')
  and (select applied_session_id = :'noah_s' from public.stripe_payments where stripe_session_id = 'cs_sess_1'));
select pg_temp.check('a session paid by Stripe no longer uses a credit',
  (select sessions_left from public.player_balances where name = 'Noah Test') = 0);
do $$ begin
  begin
    perform public.link_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'), (select id from public.sessions where topic = 'First touch' limit 1));
    perform pg_temp.check('a payment cannot be used twice', false);
  exception when others then perform pg_temp.check('a payment cannot be used twice', sqlerrm like '%already used%');
  end;
  begin
    perform public.assign_stripe_payment_for((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'), '00000000-0000-0000-0000-0000000000c9', 'session');
    perform pg_temp.check('coaches cannot assign payments', false);
  exception when others then perform pg_temp.check('coaches cannot assign payments', sqlerrm like '%Only Jan%');
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.unlink_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'));
select pg_temp.check('Jan can undo a link',
  (select applied_session_id is null from public.stripe_payments where stripe_session_id = 'cs_sess_1')
  and (select payment_status = 'awaiting' from public.sessions where id = :'noah_s'));
select public.link_stripe_payment((select id from public.stripe_payments where stripe_session_id = 'cs_sess_1'), :'noah_s');

-- paid in advance with a tagged session link, then the coach logs "paid by Stripe"
reset role;
select public.record_stripe_payment('cs_sess_2', 'session_00000000-0000-0000-0000-0000000000ca', 132, 'aud', null, null, now());
select pg_temp.check('a tagged session link is matched to the player at once',
  (select player_id = '00000000-0000-0000-0000-0000000000ca' and for_what = 'session' from public.stripe_payments where stripe_session_id = 'cs_sess_2'));
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000ca']::uuid[], null, null, null, null, null, 'stripe') as pat_s \gset
select pg_temp.check('paid by Stripe in advance: the session is confirmed when logged',
  (select payment_status = 'confirmed' from public.sessions where id = :'pat_s')
  and (select applied_session_id = :'pat_s' from public.stripe_payments where stripe_session_id = 'cs_sess_2'));

-- the coach logs "paid by Stripe" first, the payment arrives later
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000cb']::uuid[], null, null, null, null, null, 'stripe') as larry_s \gset
select pg_temp.check('paid by Stripe but not received yet: waits for the check',
  (select payment_status from public.sessions where id = :'larry_s') = 'awaiting');
reset role;
select public.record_stripe_payment('cs_sess_3', 'session_00000000-0000-0000-0000-0000000000cb', 132, 'aud', null, null, now());
select pg_temp.check('the payment arriving later confirms the waiting session',
  (select payment_status = 'confirmed' from public.sessions where id = :'larry_s'));
select pg_temp.check('an assessment payment never pays an ordinary session',
  (select count(*) from public.stripe_payments where for_what = 'assessment' and applied_session_id in (:'noah_s', :'pat_s', :'larry_s')) = 0);

-- ---------- enquiries ----------
select public.record_enquiry('wix-1', '{"first_name":"Zed","last_name":"Enquiry","email":"zed.parent@test","phone":"0400 000 000","age_group":"U12"}'::jsonb, '{}'::jsonb) as enq \gset
select pg_temp.check('an enquiry is recorded', :'enq' is not null);
select pg_temp.check('a repeated submission is ignored',
  public.record_enquiry('wix-1', '{"first_name":"Zed"}'::jsonb, '{}'::jsonb) is null
  and (select count(*) from public.enquiries) = 1);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('every coach sees new enquiries', (select count(*) from public.enquiries) = 1);
do $$ begin
  begin
    perform public.rotate_enquiry_key();
    perform pg_temp.check('a coach cannot create the website key', false);
  exception when others then perform pg_temp.check('a coach cannot create the website key', true);
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('Jan sees the new enquiry', (select count(*) from public.enquiries where status = 'new') = 1);
select public.assign_enquiry(:'enq', '00000000-0000-0000-0000-0000000000c2') as enq_player \gset
select pg_temp.check('assigning creates the player and moves the enquiry on',
  (select status = 'assigned' and player_id = :'enq_player' and coach_id = '00000000-0000-0000-0000-0000000000c2' from public.enquiries where id = :'enq')
  and (select name = 'Zed Enquiry' and main_coach_id = '00000000-0000-0000-0000-0000000000c2' from public.players where id = :'enq_player'));
select public.rotate_enquiry_key() as newkey \gset
select pg_temp.check('the website key can be created and read by Jan',
  length(:'newkey') = 64 and public.get_enquiry_key() = :'newkey');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('the assigned coach sees the enquiry', (select count(*) from public.enquiries) = 1);
select public.enquiry_book(:'enq', public.today_sydney() + 2, time '16:00', 60, 'Moore Park') as enq_bk \gset
select pg_temp.check('the assessment lands in the coach''s calendar',
  exists (select 1 from public.calendar(public.today_sydney() + 2, public.today_sydney() + 2)
           where ref_id = :'enq_bk' and format = 'assessment' and coach_id = '00000000-0000-0000-0000-0000000000c2' and start_time = time '16:00'));
select pg_temp.check('the enquiry shows as booked', (select status from public.enquiries where id = :'enq') = 'booked');
select public.enquiry_book(:'enq', public.today_sydney() + 3, time '17:00', 60, null);
select pg_temp.check('booking again moves the same assessment',
  (select count(*) from public.bookings where id = :'enq_bk' and session_date = public.today_sydney() + 3 and cancelled_at is null) = 1);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select public.enquiry_book(:'enq', public.today_sydney() + 4, time '10:00', 60, 'Gunyama Park');
select pg_temp.check('another coach (for example Tyler) can move the assessment',
  (select session_date = public.today_sydney() + 4 and location = 'Gunyama Park' and coach_id = '00000000-0000-0000-0000-0000000000c2' from public.bookings where id = :'enq_bk'));
select public.assign_enquiry(:'enq', '00000000-0000-0000-0000-0000000000c3');
select pg_temp.check('reassigning moves the planned assessment to the new coach',
  (select b.coach_id = '00000000-0000-0000-0000-0000000000c3' and b.location = 'Gunyama Park' from public.enquiries e join public.bookings b on b.id = e.booking_id where e.id = :'enq')
  and (select cancelled_at is not null from public.bookings where id = :'enq_bk'));
select public.assign_enquiry(:'enq', '00000000-0000-0000-0000-0000000000c2');


-- ---------- last location ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('the last place a player was coached is found',
  public.last_location('00000000-0000-0000-0000-0000000000b1') = 'Moore Park');
select pg_temp.check('a player never coached anywhere has no last place',
  public.last_location('00000000-0000-0000-0000-0000000000cb') is null);


-- ---------- enquiry process ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.add_enquiry('{"first_name":"Manual","last_name":"Entry","parent_name":"Mum Entry","parent_phone":"0411 222 333","parent_email":"mum@test"}'::jsonb) as man \gset
select pg_temp.check('Jan can add an enquiry by hand',
  (select parent_phone = '0411 222 333' and parent_email = 'mum@test' and source = 'manual' from public.enquiries where id = :'man'));
select public.enquiry_called(:'man', 'Keen, wants Wednesdays', 'Queens Park', 'Wed after 4pm');
select pg_temp.check('the call is recorded with a note, pitch and ideal times',
  (select called_at is not null and note = 'Keen, wants Wednesdays' and preferred_location = 'Queens Park' and ideal_times = 'Wed after 4pm' from public.enquiries where id = :'man'));
select public.enquiry_whatsapp_group(:'man');
select pg_temp.check('the WhatsApp group is ticked off', (select whatsapp_group_at is not null from public.enquiries where id = :'man'));
select public.assign_enquiry(:'man', '00000000-0000-0000-0000-0000000000c2');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.set_enquiry_outcome(:'man', 'handover');
select pg_temp.check('the coach hands the family over to Jan after the assessment',
  (select outcome = 'handover' and status = 'done' from public.enquiries where id = :'man'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  null;
end $$;
select pg_temp.check('any coach can add an enquiry by hand', public.add_enquiry('{"first_name":"Phone","last_name":"Call"}'::jsonb) is not null);
select pg_temp.check('coaches see the pitch list with addresses', (select count(*) >= 15 and count(*) filter (where place_id is not null) >= 15 from public.locations));
do $$ begin
  begin
    insert into public.locations (name) values ('Sneaky Park');
    perform pg_temp.check('only Jan edits the pitch list', false);
  exception when others then perform pg_temp.check('only Jan edits the pitch list', true);
  end;
end $$;
set role anon;
do $$ declare n int; begin
  begin select count(*) into n from public.enquiries; perform set_config('test.anon_enq', n::text, false);
  exception when others then perform set_config('test.anon_enq', 'denied', false); end;
end $$;
reset role;
select pg_temp.check('strangers cannot see enquiries', current_setting('test.anon_enq') in ('denied', '0'));
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a9';
select pg_temp.check('a signed-in non-coach sees no enquiries', (select count(*) from public.enquiries) = 0);

-- ---------- cash kept by the coach is settled on the invoice ----------
reset role;
update public.settings set value = '"2000-01-01"' where key = 'cash_kept_from';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], null, null, null, null, null, 'cash') as cashs \gset
select pg_temp.check('a coach''s cash session needs no check from Jan',
  (select payment_status = 'confirmed' from public.sessions where id = :'cashs'));
select pg_temp.check('the pay for the cash session is unchanged and the cash kept is the player''s price',
  (select pay = 50 and cash_kept = coalesce((select session_price from public.players where id = '00000000-0000-0000-0000-0000000000b1'),
        (select (value #>> '{}')::numeric from public.settings where key = 'default_session_price'))
     from public.coach_pay where session_id = :'cashs'));
select pg_temp.check('the invoice line is pay minus the cash kept, so the total drops',
  (select amount = 50 - cash_kept from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', public.today_sydney() + 7) d
     join public.coach_pay cp on cp.session_id = d.session_id where d.session_id = :'cashs'));
select pg_temp.check('the cash line says how it was worked out',
  (select description like '%cash $%kept, less pay $50.00%' from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', public.today_sydney() + 7) where session_id = :'cashs'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c1', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b4']::uuid[], null, null, null, null, null, 'cash') as janis \gset
select pg_temp.check('a salaried coach''s cash still waits for Jan to confirm',
  (select payment_status = 'awaiting' from public.sessions where id = :'janis'));
select pg_temp.check('a salaried coach has nothing deducted',
  (select cash_kept = 0 from public.coach_pay where session_id = :'janis'));

-- ---------- a coach who is paid separately invoices without ABN or bank details ----------
reset role;
update public.coaches set paid_separately = true where id = '00000000-0000-0000-0000-0000000000c3';
update public.coach_rates set one_to_one = 55 where coach_id = '00000000-0000-0000-0000-0000000000c3';
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-0000000d0099', pg_temp.last_sun() - 1, '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-0000000d0099', '00000000-0000-0000-0000-0000000000b1');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
select public.submit_invoice('00000000-0000-0000-0000-0000000000c3', pg_temp.last_sun()) as paulinv \gset
select pg_temp.check('Paul can invoice without ABN or bank details',
  (select total > 0 and bsb = '' and coach_abn = '' and coach_legal_name = 'Paul' from public.coach_invoices where id = :'paulinv'));

-- ---------- 2:1 credits are a separate pool for families that have them ----------
reset role;
insert into public.players (id, name, family) values
  ('00000000-0000-0000-0000-0000000e0001', 'Pair Brother A', 'Pair Family'),
  ('00000000-0000-0000-0000-0000000e0002', 'Pair Brother B', 'Pair Family'),
  ('00000000-0000-0000-0000-0000000e0003', 'Plain Friend', null);
insert into public.credit_ledger (player_id, kind, sessions_delta, pairs_delta, reason) values
  ('00000000-0000-0000-0000-0000000e0001', 'purchase', 10, 5, 'test'),
  ('00000000-0000-0000-0000-0000000e0003', 'purchase', 4, 0, 'test');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c1', '2:1', 'attended',
  array['00000000-0000-0000-0000-0000000e0001','00000000-0000-0000-0000-0000000e0002']::uuid[]) as pair1 \gset
select pg_temp.check('a 2:1 with both brothers uses one 2:1 credit for the family and no 1:1 credit',
  (select pairs_left = 4 and sessions_left = 10 from public.player_balances where player_id = '00000000-0000-0000-0000-0000000e0002'));
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c1', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000e0002']::uuid[]) as pair2 \gset
select pg_temp.check('a 1:1 for one brother uses the shared 1:1 credits only',
  (select pairs_left = 4 and sessions_left = 9 from public.player_balances where player_id = '00000000-0000-0000-0000-0000000e0001'));
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c1', '2:1', 'attended',
  array['00000000-0000-0000-0000-0000000e0003','00000000-0000-0000-0000-0000000e0001']::uuid[]) as pair3 \gset
select pg_temp.check('without a 2:1 pool a 2:1 still uses a normal credit, and the family pool uses one',
  (select sessions_left = 3 and pairs_left is null from public.player_balances where player_id = '00000000-0000-0000-0000-0000000e0003')
  and (select pairs_left = 3 from public.player_balances where player_id = '00000000-0000-0000-0000-0000000e0001'));

-- ---------- a player who is not training comes back when a session is booked for them ----------
reset role;
update public.players set active = false where id = '00000000-0000-0000-0000-0000000e0003';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c1', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000e0003']::uuid[]) as react1 \gset
select pg_temp.check('logging a session for an inactive player makes them active again',
  (select active from public.players where id = '00000000-0000-0000-0000-0000000e0003'));

-- ---------- invoice at any time ----------
reset role;
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-0000000d0009', public.today_sydney(), '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-0000000d0009', '00000000-0000-0000-0000-0000000000b1');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
select public.submit_invoice('00000000-0000-0000-0000-0000000000c4', public.today_sydney()) as inv_mid \gset
select pg_temp.check('a coach can send an invoice on any day, up to today',
  (select total > 0 and period_end = public.today_sydney() and extract(isodow from period_start) = 1 from public.coach_invoices where id = :'inv_mid'));
do $$ begin
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c4', public.today_sydney() + 1);
    perform pg_temp.check('an invoice cannot run past today', false);
  exception when others then perform pg_temp.check('an invoice cannot run past today', sqlerrm like '%up to today%');
  end;
end $$;


-- ---------- correcting a sent invoice ----------
reset role;
insert into public.sessions (id, session_date, coach_id, format, outcome) values
  ('00000000-0000-0000-0000-0000000d0010', public.today_sydney(), '00000000-0000-0000-0000-0000000000c4', '1:1', 'attended');
insert into public.session_players values ('00000000-0000-0000-0000-0000000d0010', '00000000-0000-0000-0000-0000000000b1');
select total as mid_total, number as mid_no from public.coach_invoices where id = :'inv_mid' \gset
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
select public.update_invoice(:'inv_mid');
select pg_temp.check('a coach can update this week''s invoice: the new session is added, same number',
  (select total > :mid_total and number = :mid_no from public.coach_invoices where id = :'inv_mid')
  and (select count(*) = 1 from public.invoice_lines where session_id = '00000000-0000-0000-0000-0000000d0010'));
do $$ begin
  begin
    perform public.update_invoice((select id from public.coach_invoices where period_end < public.today_sydney() - extract(isodow from public.today_sydney())::int + 1 order by period_end limit 1));
    perform pg_temp.check('last week''s invoice is closed for the coach', false);
  exception when others then perform pg_temp.check('last week''s invoice is closed for the coach', sqlerrm like '%Sunday 8pm%' or sqlerrm like '%already paid%', sqlerrm);
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.mark_invoices_paid(array[:'inv_mid']::uuid[]);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a4';
do $$ begin
  begin
    perform public.update_invoice((select id from public.coach_invoices where status = 'paid' order by period_end desc limit 1));
    perform pg_temp.check('a paid invoice cannot be changed', false);
  exception when others then perform pg_temp.check('a paid invoice cannot be changed', sqlerrm like '%already paid%', sqlerrm);
  end;
end $$;
select pg_temp.check('the coach sees the invoice as paid', (select status = 'paid' and paid_at is not null from public.coach_invoices where id = :'inv_mid'));


-- ---------- planning a session before it happens ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney() + 2, time '15:00', 60, '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'Park', null) as prep_bk \gset
select public.save_prep('once', :'prep_bk', null, '  Weak foot finishing  ');
select pg_temp.check('a coach can plan their session ahead',
  (select topic = 'Weak foot finishing' from public.session_prep where booking_id = :'prep_bk'));
select public.save_prep('once', :'prep_bk', null, 'Weak foot finishing, 1v1');
select pg_temp.check('saving again replaces the plan',
  (select count(*) = 1 and max(topic) = 'Weak foot finishing, 1v1' from public.session_prep where booking_id = :'prep_bk'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  begin
    perform public.save_prep('once', (select booking_id from public.session_prep limit 1), null, 'Mine now');
    perform pg_temp.check('a coach cannot plan another coach''s session', false);
  exception when others then perform pg_temp.check('a coach cannot plan another coach''s session', sqlerrm like '%your own%');
  end;
end $$;
select pg_temp.check('other coaches can read the plan', (select count(*) >= 1 from public.session_prep));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.save_prep('once', :'prep_bk', null, '');
select pg_temp.check('an empty plan clears it', not exists (select 1 from public.session_prep where booking_id = :'prep_bk'));


-- ---------- private calendar link ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.my_calendar_token() as tok1 \gset
select pg_temp.check('a coach gets a long private calendar token, the same each time',
  length(:'tok1') = 64 and public.my_calendar_token() = :'tok1');
set role anon;
select (select count(*) > 0 and bool_and(coach_name = 'Tyler') from public.calendar_feed(:'tok1')) as feed_ok,
       (select count(*) = 0 from public.calendar_feed('nope')) as wrong_ok \gset
reset role;
select pg_temp.check('the token table cannot be read without signing in', not has_table_privilege('anon', 'public.calendar_feeds', 'select'));
select pg_temp.check('the calendar link shows only that coach''s sessions', :'feed_ok'::boolean);
select pg_temp.check('a wrong token shows nothing', :'wrong_ok'::boolean);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.my_calendar_token(true) as tok2 \gset
set role anon;
select (select count(*) = 0 from public.calendar_feed(:'tok1')) as reset_ok \gset
reset role;
select pg_temp.check('resetting the link stops the old one', :'reset_ok'::boolean and :'tok1' <> :'tok2');


-- ---------- invoice reminders for MYOB ----------
reset role;
insert into public.players (id, name, billing_model) values ('00000000-0000-0000-0000-0000000e00c1', 'Renew Rita', 'package');
insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, package_name, amount_paid, reason, effective_date)
values ('00000000-0000-0000-0000-0000000e00c1', 'purchase', 1, 0, '5 pack', 600, 'Bought 5 pack', public.today_sydney() - 20);
insert into public.players (id, name, billing_model, monthly_recurring) values ('00000000-0000-0000-0000-0000000e00c2', 'Monthly Max', 'package', true);
insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, package_name, amount_paid, reason, effective_date)
values ('00000000-0000-0000-0000-0000000e00c2', 'purchase', 4, 1, 'Monthly', 650, 'Bought Monthly', public.today_sydney() - 27);
insert into public.owner_weeks (week_start, salary_cost, elle_hours, elle_rate, elle_amount, tyler_elle_sessions, tyler_commission_rate, tyler_commission)
values (date_trunc('week', public.today_sydney() - 7)::date, 1960, 7.5, 70, 525, 3, 20, 60)
on conflict (week_start) do update set elle_hours = 7.5, elle_amount = 525, tyler_elle_sessions = 3, tyler_commission = 60;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('a package with one credit left asks for a renewal invoice at the new price plus GST',
  (select amount_ex = 650 and gst = 65 and total = 715 and item = 'eleade 5 pack' from public.invoice_reminders() where bill_to = 'Renew Rita'));
select pg_temp.check('a recurring monthly package asks for next month''s invoice',
  exists (select 1 from public.invoice_reminders() where kind = 'monthly' and bill_to = 'Monthly Max' and amount_ex = 650));
select pg_temp.check('last week''s Elle figures give one invoice: hours and Tyler''s commission, plus GST',
  (select amount_ex = 585 and total = 643.5 and details like '%7.5 hours%' and details like '%3 sessions%' from public.invoice_reminders() where kind = 'elle' and due_from = date_trunc('week', public.today_sydney() - 7)::date + 6));
insert into public.invoice_reminders_done (key) select key from public.invoice_reminders() where bill_to = 'Renew Rita';
select pg_temp.check('older package names count as the standard package',
  public.package_kind('10 sessions + 1 analysis') = '10 pack' and public.package_price('5 sessions + 1 analysis', null) = 650
  and public.package_price('8 sessions + 1 analysis', 900) = 900);
select pg_temp.check('a ticked-off reminder shows as done',
  (select done_at is not null from public.invoice_reminders() where bill_to = 'Renew Rita'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin
    perform 1 from public.invoice_reminders();
    perform pg_temp.check('coaches cannot see invoice reminders', false);
  exception when others then perform pg_temp.check('coaches cannot see invoice reminders', sqlerrm like 'Only Jan%');
  end;
end $$;

reset role;

-- ---------- Jan edits a package entry ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, package_name, amount_paid, reason, effective_date)
values ('00000000-0000-0000-0000-0000000e00c1', 'purchase', 10, 1, '10 pack', 1250, 'Bought 10 pack', public.today_sydney()) returning id as led1 \gset
update public.credit_ledger set sessions_delta = 11, package_name = 'Tailored package', amount_paid = 1375 where id = :'led1';
select pg_temp.check('Jan can change a package after saving it, and the change is stamped',
  (select sessions_delta = 11 and package_name = 'Tailored package' and edited_at is not null from public.credit_ledger where id = :'led1'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
update public.credit_ledger set sessions_delta = 50 where id = :'led1';
delete from public.credit_ledger where id = :'led1';
reset role;
select pg_temp.check('a coach cannot change or remove a package entry',
  (select sessions_delta = 11 from public.credit_ledger where id = :'led1'));
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
delete from public.credit_ledger where id = :'led1';
reset role;
select pg_temp.check('Jan can remove a wrong entry', not exists (select 1 from public.credit_ledger where id = :'led1'));

reset role;

-- ---------- cancelling a session in advance ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.book_session('00000000-0000-0000-0000-0000000000c2', public.today_sydney() + 1, time '16:00', 60, '1:1',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'Park', null) as cx_bk \gset
select sessions_left as cx_before from public.player_balances where player_id = '00000000-0000-0000-0000-0000000000b1' \gset
select public.confirm_booking(:'cx_bk', 'cancelled_in_time') as cx_s \gset
select pg_temp.check('a coach can cancel tomorrow''s session in advance; it stays in the calendar as cancelled',
  exists (select 1 from public.calendar(public.today_sydney() + 1, public.today_sydney() + 1) c where c.ref_id = :'cx_bk' and c.outcome = 'cancelled_in_time'));
select pg_temp.check('a session cancelled in advance uses no credit',
  (select sessions_left = :cx_before from public.player_balances where player_id = '00000000-0000-0000-0000-0000000000b1'));
select pg_temp.check('a session cancelled in advance is not on the coach invoice',
  not exists (select 1 from public.invoice_draft('00000000-0000-0000-0000-0000000000c2', public.today_sydney() + 1) d where d.session_id = :'cx_s'));
select public.undo_cancellation(:'cx_s');
select pg_temp.check('the cancellation can be undone, and the session is planned again',
  exists (select 1 from public.calendar(public.today_sydney() + 1, public.today_sydney() + 1) c where c.ref_id = :'cx_bk' and c.session_id is null));
do $$ begin
  begin
    perform public.confirm_booking((select id from public.bookings where session_date = public.today_sydney() + 1 and location = 'Park' limit 1), 'attended');
    perform pg_temp.check('a future session still cannot be marked completed', false);
  exception when others then perform pg_temp.check('a future session still cannot be marked completed', sqlerrm like '%future%');
  end;
end $$;

reset role;

-- ---------- 2:1 price per player ----------
reset role;
update public.players set pair_price = 80 where id = '00000000-0000-0000-0000-0000000000b4';
select pg_temp.check('a 2:1 is charged at the player''s 2:1 price, a 1:1 at the 1:1 price, defaults otherwise',
  public.player_price('00000000-0000-0000-0000-0000000000b4', '2:1') = 80
  and public.player_price('00000000-0000-0000-0000-0000000000b4', '1:1') = 130
  and public.player_price('00000000-0000-0000-0000-0000000000b1', '2:1') = 75);

reset role;
-- ---------- Player Name on the payment link ----------
reset role;
insert into public.players (id, name) values ('00000000-0000-0000-0000-0000000e00a1', 'Named Nina');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '1:1', 'attended',
  array['00000000-0000-0000-0000-0000000e00a1']::uuid[], null, null, null, null, null, 'stripe') as nina_s \gset
reset role;
select public.record_stripe_payment_named('cs_name_1', null, 132, 'aud', 'p@test', 'Nina Parent', now(), '  named   NINA ');
select pg_temp.check('the Player Name on the link finds the player and pays the waiting session',
  (select player_id = '00000000-0000-0000-0000-0000000e00a1' and applied_session_id = :'nina_s' and player_name_entered = 'named   NINA' from public.stripe_payments where stripe_session_id = 'cs_name_1')
  and (select payment_status = 'confirmed' from public.sessions where id = :'nina_s'));
select public.record_stripe_payment_named('cs_name_3', null, 132, 'aud', 'p@test', 'Parent', now(), 'Nobody Known');
select pg_temp.check('an unknown name is left for Jan to assign',
  (select player_id is null from public.stripe_payments where stripe_session_id = 'cs_name_3'));

-- ---------- editing a completed session ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.log_session(public.today_sydney(), '00000000-0000-0000-0000-0000000000c2', '2:1', 'attended',
  array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b5']::uuid[]) as ed1 \gset
select sessions_left as ray_before from public.player_balances where player_id = '00000000-0000-0000-0000-0000000000b5' \gset
select public.edit_session(:'ed1', public.today_sydney(), '17:00', 90, '1:1', 'attended', ' Moore Park ',
  array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'Finishing', null, null, null);
select pg_temp.check('a coach can turn their 2:1 into a 1:1 with one player',
  (select format = '1:1' and minutes = 90 and start_time = '17:00' and location = 'Moore Park' and topic = 'Finishing' from public.sessions where id = :'ed1')
  and (select count(*) = 1 from public.session_players where session_id = :'ed1'));
select pg_temp.check('the removed player gets the credit back',
  (select sessions_left = :ray_before + 1 from public.player_balances where player_id = '00000000-0000-0000-0000-0000000000b5'));
do $$ begin
  begin
    perform public.edit_session((select id from public.sessions where format = '1:1' and coach_id = '00000000-0000-0000-0000-0000000000c1' and not imported limit 1),
      public.today_sydney(), null, 60, '1:1', 'attended', null, array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
    perform pg_temp.check('a coach cannot edit another coach''s session', false);
  exception when others then perform pg_temp.check('a coach cannot edit another coach''s session', sqlerrm like '%your own%');
  end;
  begin
    perform public.edit_session((select id from public.sessions where topic = 'Finishing' and coach_id = '00000000-0000-0000-0000-0000000000c2' limit 1), public.today_sydney(), null, 60, '2:1', 'attended', null,
      array['00000000-0000-0000-0000-0000000000b1']::uuid[]);
    perform pg_temp.check('a 2:1 needs two players', false);
  exception when others then perform pg_temp.check('a 2:1 needs two players', sqlerrm like '%at least 2%', sqlerrm);
  end;
end $$;

-- ---------- Jan's own weekly figures are private ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('a coach cannot see Jan''s salary and Elle figures', (select count(*) = 0 from public.owner_weeks));
do $$ begin
  begin
    insert into public.owner_weeks (week_start, salary_cost) values ('2026-10-12', 1);
    perform pg_temp.check('a coach cannot write Jan''s weekly figures', false);
  exception when others then perform pg_temp.check('a coach cannot write Jan''s weekly figures', true);
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into public.owner_weeks (week_start, salary_cost, elle_hours, elle_amount, tyler_elle_sessions, tyler_commission)
values ('2026-08-03', 1960, 7.5, 525, 3, 60);
select pg_temp.check('Jan can save his weekly figures and sees them',
  (select salary_cost = 1960 and elle_amount = 525 from public.owner_weeks where week_start = '2026-08-03'));

-- ---------- Google Drive ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin
    perform public.drive_connect('x', 'someone@example.com');
    perform pg_temp.check('a coach cannot connect Google Drive', false);
  exception when others then perform pg_temp.check('a coach cannot connect Google Drive', sqlerrm like '%Only Jan%');
  end;
  begin
    perform public.set_player_folders('[{"player_id":"00000000-0000-0000-0000-0000000000b1","folder_id":"f1"}]');
    perform pg_temp.check('a coach cannot link player folders', false);
  exception when others then perform pg_temp.check('a coach cannot link player folders', sqlerrm like '%Only Jan%');
  end;
end $$;
do $$ declare n int; begin
  select count(*) into n from public.drive_connection;
  perform pg_temp.check('a coach cannot read the Drive table directly', n = 0);
exception when others then perform pg_temp.check('a coach cannot read the Drive table directly', true);
end $$;
select pg_temp.check('nothing to fetch before Drive is connected', (select count(*) = 0 from public.drive_secret()));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select public.drive_connect('enc-token', 'info@eleadefussball.com');
select pg_temp.check('Jan links a player to a folder', public.set_player_folders('[{"player_id":"00000000-0000-0000-0000-0000000000b1","folder_id":"f1","folder_name":"Folder 1"}]') = 1);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('a coach sees Drive is connected', (select connected and connected_email = 'info@eleadefussball.com' from public.drive_status()));
select pg_temp.check('the app server gets the encrypted key for a coach', (select refresh_token_enc = 'enc-token' from public.drive_secret()));
select public.record_clip('00000000-0000-0000-0000-0000000000b1', 'file1', '2026-10-15 clip.mp4');
select pg_temp.check('a coach records an uploaded clip', (select count(*) = 1 from public.drive_clips where player_id = '00000000-0000-0000-0000-0000000000b1'));
reset role;
set role anon;
do $$ begin
  begin
    perform public.drive_secret();
    perform set_config('test.anon_drive', 'allowed', false);
  exception when others then perform set_config('test.anon_drive', 'denied', false);
  end;
end $$;
reset role;
select pg_temp.check('a stranger cannot fetch the Drive key', current_setting('test.anon_drive') = 'denied');

-- ---------- Friday-paid coach: planned weekend sessions on the invoice ----------
reset role;
insert into public.coaches (id, name, email, is_admin, invoice_planned, paid_separately) values
  ('00000000-0000-0000-0000-0000000000c9', 'Freddie', 'freddie@test', false, true, true);
insert into public.coach_rates (coach_id, one_to_one, analysis) values ('00000000-0000-0000-0000-0000000000c9', 50, 40);
insert into public.sessions (id, session_date, coach_id, format, outcome, logged_at) values
  ('00000000-0000-0000-0000-0000000f0001', pg_temp.last_sun() - 4, '00000000-0000-0000-0000-0000000000c9', '1:1', 'attended', now());
insert into public.session_players (session_id, player_id) values ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000000b1');
insert into public.bookings (id, coach_id, session_date, start_time, format, minutes) values
  ('00000000-0000-0000-0000-0000000fb001', '00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun() - 1, '09:00', '1:1', 60),
  ('00000000-0000-0000-0000-0000000fb002', '00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun(), '10:00', 'analysis', 60),
  ('00000000-0000-0000-0000-0000000fb003', '00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun() - 1, '11:00', '1:1', 60);
insert into public.booking_players (booking_id, player_id) values
  ('00000000-0000-0000-0000-0000000fb001', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000fb002', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000fb003', '00000000-0000-0000-0000-0000000000b3');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('a Friday invoice includes the planned Saturday and Sunday sessions',
  (select count(*) = 4 and sum(amount) = 190 and count(*) filter (where description like 'Planned:%') = 3
     from public.invoice_draft('00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun() - 2)));
select public.submit_invoice('00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun() - 2) as finv \gset
select pg_temp.check('the Friday invoice covers the week to Sunday',
  (select period_end = pg_temp.last_sun() and total = 190 from public.coach_invoices where id = :'finv'));
-- the weekend: one session happens, one is cancelled in time, one is taken off the calendar
select public.confirm_booking('00000000-0000-0000-0000-0000000fb001', 'attended');
select public.confirm_booking('00000000-0000-0000-0000-0000000fb003', 'cancelled_in_time');
update public.bookings set cancelled_at = now() where id = '00000000-0000-0000-0000-0000000fb002';
select pg_temp.check('a planned session that happened is not paid twice, the others come off the next invoice',
  (select count(*) = 2 and sum(amount) = -90 and bool_and(is_correction)
     from public.invoice_draft('00000000-0000-0000-0000-0000000000c9', pg_temp.last_sun() + 5)));
select pg_temp.check('other coaches still invoice only what is logged',
  not exists (select 1 from public.invoice_draft('00000000-0000-0000-0000-0000000000c4', pg_temp.last_sun() - 2) where description like 'Planned:%'));

-- ---------- documentation, training videos, admin hours ----------
reset role;
update public.settings set value = to_jsonb((public.today_sydney() - 30)::text) where key = 'docs_reminder_from';
update public.settings set value = to_jsonb((public.today_sydney() - 3)::text) where key = 'docs_required_from';
update public.sessions set topic = 'Earlier work' where coach_id = '00000000-0000-0000-0000-0000000000c9';
insert into public.sessions (id, session_date, coach_id, format, outcome, logged_at, topic) values
  ('00000000-0000-0000-0000-0000000d0c01', public.today_sydney() - 1, '00000000-0000-0000-0000-0000000000c9', '1:1', 'attended', now(), null),
  ('00000000-0000-0000-0000-0000000d0c02', public.today_sydney() - 10, '00000000-0000-0000-0000-0000000000c9', '1:1', 'attended', now(), ' '),
  ('00000000-0000-0000-0000-0000000d0c03', public.today_sydney() - 1, '00000000-0000-0000-0000-0000000000c9', '1:1', 'cancelled_late', now(), null);
insert into public.session_players (session_id, player_id) values
  ('00000000-0000-0000-0000-0000000d0c01', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000d0c02', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000d0c03', '00000000-0000-0000-0000-0000000000b1');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a8', 'freddie@test');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a8';
select pg_temp.check('the coach sees attended sessions without notes (old ones too, not cancellations)',
  (select count(*) = 2 from public.undocumented_sessions('00000000-0000-0000-0000-0000000000c9')
    where session_id in ('00000000-0000-0000-0000-0000000d0c01', '00000000-0000-0000-0000-0000000d0c02')));
select public.add_admin_hours(public.today_sydney() - 1, 1.5, 'Planning') as ah \gset
do $$ begin
  begin
    perform public.add_admin_hours(public.today_sydney(), 1.3);
    perform pg_temp.check('admin hours go in quarter hours', false);
  exception when others then perform pg_temp.check('admin hours go in quarter hours', sqlerrm like '%quarter%');
  end;
  begin
    perform public.submit_invoice('00000000-0000-0000-0000-0000000000c9', public.today_sydney());
    perform pg_temp.check('no invoice while a recent session has no notes', false);
  exception when others then perform pg_temp.check('no invoice while a recent session has no notes', sqlerrm like '%What you worked on%1 session%');
  end;
end $$;
select pg_temp.check('admin hours appear on the draft at $30 an hour',
  (select amount = 45 and description like 'Admin: 1.5 h%Planning%' from public.invoice_draft('00000000-0000-0000-0000-0000000000c9', public.today_sydney()) where admin_hours_id = :'ah'));
select public.save_session_notes('00000000-0000-0000-0000-0000000d0c01', 'Weak foot finishing', 'Sharp', null);
select pg_temp.check('notes saved from the list', (select topic = 'Weak foot finishing' and observations = 'Sharp' from public.sessions where id = '00000000-0000-0000-0000-0000000d0c01'));
select public.submit_invoice('00000000-0000-0000-0000-0000000000c9', public.today_sydney()) as ahinv \gset
select pg_temp.check('the invoice goes through once recent sessions are documented, with the admin hours on it',
  exists (select 1 from public.invoice_lines where invoice_id = :'ahinv' and admin_hours_id = :'ah' and amount = 45));
select pg_temp.check('admin hours are paid once', not exists (select 1 from public.invoice_draft('00000000-0000-0000-0000-0000000000c9', public.today_sydney()) where admin_hours_id is not null));
do $$ begin
  begin
    perform public.remove_admin_hours((select id from public.admin_hours limit 1));
    perform pg_temp.check('invoiced admin hours cannot be removed by the coach', false);
  exception when others then perform pg_temp.check('invoiced admin hours cannot be removed by the coach', true);
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  begin
    perform public.save_session_notes('00000000-0000-0000-0000-0000000d0c02', 'Sneaky');
    perform pg_temp.check('a coach cannot document another coach''s session', false);
  exception when others then perform pg_temp.check('a coach cannot document another coach''s session', true);
  end;
end $$;
select pg_temp.check('other coaches do not see someone else''s documentation list',
  (select count(*) = 0 from public.undocumented_sessions('00000000-0000-0000-0000-0000000000c9')));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('training videos are due 4 to 6 weeks after the start',
  (select bool_and(due_on between greatest(coalesce(last_clip, date '2000-01-01'), (select (value #>> '{}')::date from public.settings where key = 'videos_from')) + 28
                               and greatest(coalesce(last_clip, date '2000-01-01'), (select (value #>> '{}')::date from public.settings where key = 'videos_from')) + 42)
     from public.videos_due('00000000-0000-0000-0000-0000000000c2')));

-- ---------- MYOB reminders: edit the package, send, then confirm the payment ----------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select key as mkey from public.invoice_reminders() where kind = 'monthly' and bill_to = 'Monthly Max' \gset
select public.save_reminder_package(:'mkey', 'Tailored', 6, 1, 0, 800);
select pg_temp.check('an edited package shows its new sessions and price',
  (select sessions = 6 and analyses = 1 and amount_ex = 800 and total = 880 and status = 'open' from public.invoice_reminders() where key = :'mkey'));
select public.send_reminder(:'mkey');
select pg_temp.check('sent in MYOB: the package is recorded with payment awaiting and the reminder waits for the payment',
  (select status = 'waiting' and ledger_id is not null from public.invoice_reminders() where key = :'mkey')
  and (select sessions_delta = 6 and analyses_delta = 1 and amount_paid = 800 and payment_status = 'awaiting'
         from public.credit_ledger where id = (select ledger_id from public.invoice_reminders_done where key = :'mkey')));
select public.reminder_paid(:'mkey', true, 'stripe');
select pg_temp.check('confirming the payment marks the package paid',
  (select status = 'paid' from public.invoice_reminders() where key = :'mkey')
  and (select payment_status = 'confirmed' and payment_method = 'stripe' from public.credit_ledger where id = (select ledger_id from public.invoice_reminders_done where key = :'mkey')));
select key as ekey from public.invoice_reminders() where kind = 'elle' and status = 'open' limit 1 \gset
select public.send_reminder(:'ekey', true);
select public.undo_reminder(:'ekey');
select pg_temp.check('undo puts a reminder back on the list', (select status = 'open' from public.invoice_reminders() where key = :'ekey'));

-- ---------- payment plans ----------
reset role;
select pg_temp.check('existing weekly payers keep paying weekly', (select payment_plan = 'weekly' from public.players where id = '00000000-0000-0000-0000-0000000000b4'));
update public.players set payment_plan = 'monthly' where id = '00000000-0000-0000-0000-0000000000b5';
select pg_temp.check('monthly package: package billing, recurring, credits carried over',
  (select billing_model = 'package' and monthly_recurring from public.players where id = '00000000-0000-0000-0000-0000000000b5')
  and (select sessions_left is not null and payment_plan = 'monthly' from public.player_balances where player_id = '00000000-0000-0000-0000-0000000000b5'));
update public.players set payment_plan = 'casual', casual_method = 'stripe' where id = '00000000-0000-0000-0000-0000000000b4';
select pg_temp.check('casual: pays per session with a set method, not on the weekly list',
  (select billing_model = 'pay_per_session' and casual_method = 'stripe' from public.players where id = '00000000-0000-0000-0000-0000000000b4'));
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('a casual player is left off the weekly payers list',
  not exists (select 1 from public.payg_weeks where player_id = '00000000-0000-0000-0000-0000000000b4'));
reset role;
update public.players set payment_plan = 'weekly' where id = '00000000-0000-0000-0000-0000000000b4';
select pg_temp.check('switching away from casual clears the set method', (select casual_method is null from public.players where id = '00000000-0000-0000-0000-0000000000b4'));
update public.players set billing_model = 'package' where id = '00000000-0000-0000-0000-0000000000b4';
select pg_temp.check('recording a package for a weekly payer moves them to a casual package', (select payment_plan = 'package' from public.players where id = '00000000-0000-0000-0000-0000000000b4'));

-- ---------- player details and two-monthly feedback ----------
reset role;
select pg_temp.check('dates of birth from the form are read in every format',
  public.parse_dob('29 January 2007') = date '2007-01-29' and public.parse_dob('2008-04-05') = date '2008-04-05'
  and public.parse_dob('05/02/2013') = date '2013-02-05' and public.parse_dob('soon') is null);
select public.record_enquiry('wix-details', '{"first_name":"Dora","last_name":"Details","parent_name":"Dad Details","email":"dad@test","phone":"0400 111 222","dob":"5 February 2013","club":"UNSW"}'::jsonb, '{}'::jsonb) as denq \gset
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.assign_enquiry(:'denq', '00000000-0000-0000-0000-0000000000c2') as dplayer \gset
select pg_temp.check('a player from the website form gets the parent, date of birth, email, phone and club',
  (select parent_name = 'Dad Details' and dob = date '2013-02-05' and email = 'dad@test' and phone = '0400 111 222' and club = 'UNSW' and enquiry_id = :'denq'
     from public.players where id = :'dplayer'));
reset role;
update public.settings set value = to_jsonb(to_char(date_trunc('month', public.today_sydney()) - interval '3 months', 'YYYY-MM-DD')) where key = 'feedback_from';
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('feedback periods are two months long and due from the 25th of the second month',
  (select bool_and(period_end = (period_start + interval '2 months' - interval '1 day')::date and due_on = (period_start + interval '1 month' + interval '24 days')::date
                   and due_on <= public.today_sydney()) from public.feedback_periods()));
reset role;
insert into public.players (id, name, main_coach_id) values ('00000000-0000-0000-0000-0000000fee01', 'Fiona Feedback', '00000000-0000-0000-0000-0000000000c2');
insert into public.sessions (id, session_date, coach_id, format, outcome, logged_at, topic) values
  ('00000000-0000-0000-0000-0000000fee11', (select min(period_start) + 5 from public.feedback_periods()), '00000000-0000-0000-0000-0000000000c3', '1:1', 'attended', now(), 'x');
insert into public.session_players (session_id, player_id) values ('00000000-0000-0000-0000-0000000fee11', '00000000-0000-0000-0000-0000000fee01');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.check('the main coach is asked for feedback on a player trained in the period (even by another coach)',
  exists (select 1 from public.feedback_due('00000000-0000-0000-0000-0000000000c2') where player_id = '00000000-0000-0000-0000-0000000fee01'));
select period_start as fbp from public.feedback_due('00000000-0000-0000-0000-0000000000c2') where player_id = '00000000-0000-0000-0000-0000000fee01' \gset
select public.save_feedback('00000000-0000-0000-0000-0000000fee01', :'fbp', '• Better first touch', '• Scanning', null) as fbid \gset
select pg_temp.check('once written, it is off the coach''s list',
  not exists (select 1 from public.feedback_due('00000000-0000-0000-0000-0000000000c2') where player_id = '00000000-0000-0000-0000-0000000fee01'));
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.check('Jan sees it ready to send', (select status = 'ready' and progress like '%first touch%' from public.feedback_overview() where player_id = '00000000-0000-0000-0000-0000000fee01'));
select public.feedback_sent(:'fbid');
select pg_temp.check('and marks it sent', (select status = 'sent' from public.feedback_overview() where player_id = '00000000-0000-0000-0000-0000000fee01'));

-- ---------- changing a regular session going forward ----------
reset role;
insert into public.players (id, name) values ('00000000-0000-0000-0000-0000000000bb', 'Change Kid');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select public.create_plan('00000000-0000-0000-0000-0000000000c2', '1:1', extract(isodow from public.today_sydney())::int,
  '00:00', array['00000000-0000-0000-0000-0000000000bb']::uuid[], 'Moore Park', public.today_sydney() - 14) as chg_old \gset
select public.set_plan_minutes(:'chg_old', 15);
select public.confirm_plan_session(:'chg_old', public.today_sydney(), 'attended', 'Passing', 'Good', null);
select set_config('t.old', :'chg_old', false);
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  begin
    perform public.change_plan(current_setting('t.old')::uuid, public.today_sydney() + 3, 3, '18:30', 45, null);
    perform pg_temp.check('another coach cannot change someone else''s regular session', false);
  exception when others then perform pg_temp.check('another coach cannot change someone else''s regular session', true);
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin
    perform public.change_plan(current_setting('t.old')::uuid, public.today_sydney() - 1, 3, '18:30', 45, null);
    perform pg_temp.check('a regular session cannot be changed from a past date', false);
  exception when others then perform pg_temp.check('a regular session cannot be changed from a past date', true);
  end;
end $$;
select public.change_plan(:'chg_old', public.today_sydney() + 3, 3, '18:30', 45, 'Rushcutters Bay') as chg_new \gset
select pg_temp.check('changing from a date starts a new plan and ends the old one the day before',
  :'chg_new' <> :'chg_old'
  and (select ends_on = public.today_sydney() + 2 from public.session_plans where id = :'chg_old')
  and (select weekday = 3 and start_time = '18:30' and minutes = 45 and location = 'Rushcutters Bay' and starts_on = public.today_sydney() + 3
              and coach_id = '00000000-0000-0000-0000-0000000000c2' and format = '1:1' and ends_on is null
         from public.session_plans where id = :'chg_new')
  and (select count(*) from public.plan_players where plan_id = :'chg_new' and player_id = '00000000-0000-0000-0000-0000000000bb') = 1);
select pg_temp.check('sessions before the change stay on the old plan, later ones come from the new plan',
  (select bool_and(plan_id = :'chg_old') and count(*) > 0 from public.plan_occurrences(public.today_sydney() - 7, public.today_sydney() + 2) where plan_id in (:'chg_old', :'chg_new'))
  and (select bool_and(plan_id = :'chg_new' and extract(isodow from plan_date) = 3) and count(*) > 0
         from public.plan_occurrences(public.today_sydney() + 3, public.today_sydney() + 30) where plan_id in (:'chg_old', :'chg_new')));
do $$ begin
  begin
    perform public.change_plan(current_setting('t.old')::uuid, public.today_sydney(), 4, '09:00', null, null);
    perform pg_temp.check('a change cannot start before sessions that are already logged', false);
  exception when others then perform pg_temp.check('a change cannot start before sessions that are already logged', true);
  end;
end $$;

reset role;
select case when ok then 'PASS' else 'FAIL' end as result, test, detail from results order by ok, test;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from results;
