#!/usr/bin/env bash
# Applies new files in supabase/migrations to the live database, in order, each in one transaction.
# Already applied files are recorded in public.app_migrations, so each file runs once.
set -euo pipefail
[ -n "${SUPABASE_DB_URL:-}" ] || { echo "::notice::No SUPABASE_DB_URL secret: database changes are pasted by hand (supabase/paste-me.sql)."; exit 0; }
cd "$(dirname "$0")/../../supabase/migrations"
P=(psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -t -A)

"${P[@]}" -c "create table if not exists public.app_migrations (name text primary key, applied_at timestamptz not null default now());
              alter table public.app_migrations enable row level security;
              revoke all on public.app_migrations from anon, authenticated;" >/dev/null

# First run: everything up to 0039 was already applied by hand (pasted) before this job was switched on.
if [ "$("${P[@]}" -c "select count(*) from public.app_migrations")" = "0" ]; then
  for f in *.sql; do
    [[ "$f" < "0040" ]] && "${P[@]}" -c "insert into public.app_migrations (name) values ('$f') on conflict do nothing" >/dev/null
  done
  echo "Recorded the migrations applied by hand before this job (up to 0039)."
fi

applied=0
for f in $(ls *.sql | sort); do
  if [ "$("${P[@]}" -c "select count(*) from public.app_migrations where name = '$f'")" = "0" ]; then
    echo "Applying $f"
    "${P[@]}" -1 -f "$f" -c "insert into public.app_migrations (name) values ('$f')" >/dev/null
    applied=$((applied + 1))
  fi
done
echo "Done: $applied new migration(s) applied."
