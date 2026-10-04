#!/usr/bin/env bash
# Rebuild a scratch database and run the rules tests.
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -h /var/tmp -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c 'drop database if exists eleade_test' -c 'create database eleade_test'
$P -d eleade_test -f tests/shim.sql -f migrations/0001_init.sql -f migrations/0002_hardening.sql -f migrations/0003_assessments_and_payments.sql -f migrations/0004_rename_players.sql -f migrations/0005_regular_sessions.sql -f migrations/0006_session_payment_edit.sql -f migrations/0007_coach_invoices.sql -f migrations/0008_stats_and_expiry.sql -f migrations/0009_stripe_payments.sql -f migrations/0010_stats_include_documentation.sql -f migrations/0011_stats_history.sql -f migrations/0012_stats_history_pay.sql -f migrations/0013_stats_history_jani_luca.sql -f migrations/0014_bookings_and_schedule.sql
$P -d eleade_test -f tests/rules_test.sql
