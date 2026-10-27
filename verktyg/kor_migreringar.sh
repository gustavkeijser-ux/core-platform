#!/usr/bin/env bash
# Kör de migreringsfiler (supabase/migrations/AAAAMMDD_HHMM_*.sql) som inte redan körts
# mot databasen i $1 (en Postgres-adress, t.ex. GitHub-hemligheten PROD_DB_URL eller
# STAGING_DB_URL). Vilka som körts står i ce_drift.migreringar.
#
# Första gången tabellen skapas räknas alla filer till och med BASLINJE som redan körda:
# de kördes för hand innan testmiljön fanns (se ANDRINGSLOGG 27 okt).
#
# Varje fil körs i en egen transaktion och stoppar vid första fel (inget efter körs).
# Testmiljö (MILJO=test): schemalagda jobb som pekar på riktiga CRM:ets funktioner tas
# bort efteråt, så testmiljön aldrig skickar mejl eller rör riktiga data.
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
DB="${1:?Ange databasadress}"
BASLINJE="20261027_0000"
cd "$(dirname "$0")/.."

psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
create schema if not exists ce_drift;
revoke all on schema ce_drift from public, anon, authenticated;
create table if not exists ce_drift.migreringar (fil text primary key, kord timestamptz not null default now());
SQL

if [ "$(psql "$DB" -tAc "select count(*) from ce_drift.migreringar")" = "0" ]; then
  echo "Första körningen: markerar filer till och med $BASLINJE som redan körda."
  for f in supabase/migrations/2*.sql; do
    n=$(basename "$f")
    [[ "$n" < "${BASLINJE}~" ]] && psql "$DB" -v ON_ERROR_STOP=1 -qc "insert into ce_drift.migreringar (fil) values ('$n') on conflict do nothing"
  done
fi

kordes=0
for f in $(ls supabase/migrations/2*.sql | sort); do
  n=$(basename "$f")
  if [ "$(psql "$DB" -tAc "select count(*) from ce_drift.migreringar where fil = '$n'")" = "0" ]; then
    echo "Kör $n"
    psql "$DB" -v ON_ERROR_STOP=1 --single-transaction -q -f "$f"
    psql "$DB" -v ON_ERROR_STOP=1 -qc "insert into ce_drift.migreringar (fil) values ('$n')"
    kordes=$((kordes + 1))
  fi
done
echo "Klart: $kordes nya migreringar."

if [ "${MILJO:-}" = "test" ]; then
  psql "$DB" -v ON_ERROR_STOP=1 -qc "select cron.unschedule(jobid) from cron.job where command like '%gpxwfboyjwcaqeinxxwr%'" >/dev/null || true
  echo "Testmiljö: schemalagda jobb mot riktiga CRM:et borttagna."
fi
