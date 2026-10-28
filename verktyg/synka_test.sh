#!/usr/bin/env bash
# Kopierar riktiga CRM:ets databas till testmiljön (Supabase-grenen "test").
#   verktyg/synka_test.sh "$PROD_DB_URL" "$STAGING_DB_URL"
# Körs av GitHub-flödet "Synka testmiljön" (manuellt). Allt i testmiljön skrivs över:
#  - schemat public (tabeller, funktioner, triggers, rättigheter, data) och ce_drift
#  - inloggningar (auth.users + auth.identities), så alla loggar in som vanligt
# Följer INTE med: filer i Storage, Vault-hemligheter, schemalagda jobb och
# edge function-hemligheter — testmiljön kan alltså inte skicka mejl eller nå Scrive.
# Efteråt körs migreringar som ännu inte publicerats (finns bara i testmiljön).
set -euo pipefail
export PGOPTIONS="-c client_min_messages=warning"
PROD="${1:?Ange adress till riktiga databasen}"
TEST="${2:?Ange adress till testdatabasen}"
[ "$PROD" != "$TEST" ] || { echo "Samma databas två gånger — avbryter."; exit 1; }
cd "$(dirname "$0")/.."
T=$(mktemp -d)

echo "1/5 Hämtar riktiga databasen…"
pg_dump "$PROD" --schema=public --schema=ce_drift --no-owner -Fc -f "$T/public.dump"
pg_dump "$PROD" --data-only --table=auth.users --table=auth.identities -Fc -f "$T/auth.dump"

echo "2/5 Hämtar triggers på auth-tabellerna (de pekar på public och tas bort med det)…"
psql "$PROD" -tAc "select format('drop trigger if exists %I on auth.%I; ', t.tgname, c.relname) || pg_get_triggerdef(t.oid) || ';'
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and not t.tgisinternal" > "$T/auth_triggers.sql"

# Policyer i storage som använder funktioner i public försvinner med public — spara dem.
psql "$PROD" -tAc "select format('drop policy if exists %I on %I.%I; create policy %I on %I.%I as %s for %s to %s%s%s;',
    policyname, schemaname, tablename, policyname, schemaname, tablename, permissive, cmd, array_to_string(roles, ', '),
    coalesce(' using (' || qual || ')', ''), coalesce(' with check (' || with_check || ')', ''))
  from pg_policies where schemaname = 'storage'" > "$T/storage_policyer.sql"

echo "3/5 Tömmer testmiljön…"
psql "$TEST" -v ON_ERROR_STOP=1 -q <<'SQL'
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job;
drop schema if exists ce_drift cascade;
drop schema public cascade;
create schema public;
-- Tillägg som ligger i public försvinner med schemat och följer inte med dumpen.
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
truncate auth.users cascade;
SQL

echo "4/5 Läser in inloggningar och data…"
pg_restore --no-owner --data-only -d "$TEST" "$T/auth.dump"
# Schemat public skapades ovan med Supabases standardrättigheter — hoppa över det i dumpen.
pg_restore -l "$T/public.dump" | grep -v ' SCHEMA - public ' > "$T/lista"
pg_restore --no-owner --exit-on-error -L "$T/lista" -d "$TEST" "$T/public.dump"
psql "$TEST" -v ON_ERROR_STOP=1 -q -f "$T/auth_triggers.sql"
psql "$TEST" -v ON_ERROR_STOP=1 -q -f "$T/storage_policyer.sql"

echo "5/5 Kör opublicerade migreringar i testmiljön…"
MILJO=test bash verktyg/kor_migreringar.sh "$TEST"
psql "$TEST" -qc "select cron.unschedule(jobid) from cron.job" >/dev/null || true
rm -rf "$T"
echo "Testmiljön är en kopia av riktiga CRM:et."
