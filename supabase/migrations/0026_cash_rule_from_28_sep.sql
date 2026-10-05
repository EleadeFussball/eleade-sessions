-- Record of a live data change (5 Oct 2026): Tyler kept the cash for Jess DiBona (28 and 30 Sep) and Jay Maltz (29 Sep and 1 Oct),
-- so the cash rule starts on 28 Sep and his submitted invoice was corrected: those four lines became pay $60 less cash kept $120 = -$60,
-- invoice total $1,270 -> $790. Only Tyler had such sessions before 5 Oct (the other cash session was by a salaried coach).
update public.settings set value = '"2026-09-28"' where key = 'cash_kept_from';
