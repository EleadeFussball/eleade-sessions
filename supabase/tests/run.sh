#!/usr/bin/env bash
# Rebuild a scratch database and run the rules tests.
set -euo pipefail
cd "$(dirname "$0")/.."
P="psql -h /var/tmp -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c 'drop database if exists eleade_test' -c 'create database eleade_test'
$P -d eleade_test -f tests/shim.sql -f migrations/0001_init.sql -f migrations/0002_hardening.sql -f migrations/0003_assessments_and_payments.sql -f migrations/0004_rename_delete_players.sql
$P -d eleade_test -f tests/rules_test.sql
