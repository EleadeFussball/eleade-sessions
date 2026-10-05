-- Data from Jan (5 Oct 2026): Sasi Kumar 2:1 sessions move into the new 2:1 pool; the Vergis-Knight brothers become one family.

-- Sasi Kumar family: 60 x 1:1 and 20 x 2:1 sessions paid. 2:1 sessions are counted per session (both boys in one session = 1 credit).
do $$
declare v_sasi uuid := '41ba019d-851c-55d4-abe0-1a99e61b9660';
begin
  if not exists (select 1 from public.credit_ledger where player_id = v_sasi and pairs_delta <> 0) then
    insert into public.credit_ledger (player_id, kind, sessions_delta, analyses_delta, pairs_delta, package_name, reason, effective_date) values
      (v_sasi, 'correction', -40, 0, 0, null, '2:1 purchase moved from the 1:1 credits to the separate 2:1 credits (counted per session, not per player)', public.today_sydney()),
      (v_sasi, 'purchase', 0, 0, 20, '20 sessions (2:1)', 'From the Abrechnung (KW39): 20 x 2:1 sessions paid so far (date not recorded)', date '2025-01-01'),
      (v_sasi, 'correction', 24, 0, -12, null, '2:1 sessions used before the app moved to the 2:1 credits (12 sessions)', public.today_sydney());
  end if;
end $$;

-- Vergis-Knight: Jamie and Elliot share one family. The old combined "Vergis Knight" entry is replaced by the two brothers.
do $$
declare v_old uuid := '5ecca99f-4ef8-5880-95a5-2452ca774819'; v_jamie uuid := '4580dc22-a7a0-4d83-abf4-ca269f584d38'; v_elliot uuid;
begin
  select id into v_elliot from public.players where lower(name) = 'elliot vergis-knight';
  if v_elliot is null then
    insert into public.players (name, family, billing_model) values ('Elliot Vergis-Knight', 'Vergis-Knight', 'package') returning id into v_elliot;
  end if;
  update public.players set family = 'Vergis-Knight' where id in (v_jamie, v_elliot);
  if exists (select 1 from public.players where id = v_old) then
    insert into public.session_players (session_id, player_id)
      select session_id, v_jamie from public.session_players where player_id = v_old on conflict do nothing;
    insert into public.session_players (session_id, player_id)
      select session_id, v_elliot from public.session_players where player_id = v_old on conflict do nothing;
    delete from public.session_players where player_id = v_old;
    delete from public.players where id = v_old;
  end if;
end $$;
