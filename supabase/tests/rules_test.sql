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

create temp table results (test text, ok boolean, detail text);
grant all on results to authenticated;

create or replace function pg_temp.check(t text, cond boolean, d text default null) returns void language sql as
$$ insert into results values (t, coalesce(cond, false), d) $$;

-- links by email (case-insensitive)
select pg_temp.check('coach linked to login by email', (select user_id from public.coaches where name='Tyler') = '00000000-0000-0000-0000-0000000000a2');

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
  '06:30', array['00000000-0000-0000-0000-0000000000ba']::uuid[], 'Moore Park', public.today_sydney() - 7);
select pg_temp.check('a weekly plan produces one session per week',
  (select count(*) from public.plan_occurrences(public.today_sydney() - 7, public.today_sydney())) = 2);
select public.confirm_plan_session((select id from public.session_plans limit 1), public.today_sydney(), 'attended', 'Passing', 'Good', null);
select pg_temp.check('confirming a planned session logs it with the plan details',
  (select s.location = 'Moore Park' and s.start_time = '06:30' and s.coach_id = '00000000-0000-0000-0000-0000000000c2'
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
do $$ begin
  begin
    update public.credit_ledger set sessions_delta = 50 where reason = 'Bought 5 pack after assessment';
    perform pg_temp.check('nobody can rewrite credit history', false);
  exception when others then perform pg_temp.check('nobody can rewrite credit history', true);
  end;
end $$;

select public.rename_player('00000000-0000-0000-0000-0000000000b3', 'Echo Sibling');
select pg_temp.check('Jan can rename any player', exists (select 1 from public.players where name = 'Echo Sibling'));

-- ---------- coach invoices ----------
reset role;
create or replace function pg_temp.last_sun() returns date language sql stable as
$$ select public.today_sydney() - extract(isodow from public.today_sydney())::int $$;
update public.settings set value = to_jsonb((public.today_sydney() - 60)::text) where key = 'invoices_from';
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
select public.confirm_booking(:'bk3', 'attended') as sid3 \gset
select pg_temp.check('the logged session keeps the planned length',
  (select minutes from public.sessions where id = :'sid3') = 60);
select pg_temp.check('a session logged on its own shows on the calendar',
  exists (select 1 from public.calendar(public.today_sydney() - 28, public.today_sydney())
           where kind = 'logged' and ref_id = '00000000-0000-0000-0000-00000000e001'));
select pg_temp.check('a confirmed plan is not listed twice',
  (select count(*) from public.calendar(public.today_sydney(), public.today_sydney()) where ref_id = :'bk3') = 1);

reset role;
select case when ok then 'PASS' else 'FAIL' end as result, test, detail from results order by ok, test;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from results;
