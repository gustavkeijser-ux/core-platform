-- =============================================================================
-- Stäng databasen för den anonyma rollen (anon).
--
-- Bakgrund (14 okt 2026): appen kräver inloggning överallt — inloggningssidan
-- läser ingenting ur databasen och edge functions använder service-nyckeln
-- eller användarens egen token. Ändå kunde anon (= vem som helst med den
-- publika nyckeln, som ligger i webbappens JavaScript) köra 103 SECURITY
-- DEFINER-funktioner och läsa/skriva tabellen geokod_cache (saknar RLS).
-- Några funktioner saknar egen behörighetskontroll, t.ex.
-- projektplan_rad_for(p_tenant, …) och d2d_lonemodell_for(p_tenant).
--
-- Efter detta: anon kan inte köra några egna funktioner och har inga
-- rättigheter på tabeller, vyer eller sekvenser i public. Inloggade
-- (authenticated) och service_role påverkas inte.
-- Tilläggsfunktioner (citext, pg_trgm) ägs av Supabase och lämnas orörda.
-- =============================================================================

-- 1. Funktioner: ge authenticated/service_role uttryckligen, ta bort från
--    PUBLIC (som anon ärver från) och från anon.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;

-- Nya funktioner ska inte heller bli körbara för anon.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

-- 2. Tabeller, vyer och sekvenser: anon behöver ingen åtkomst alls.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
