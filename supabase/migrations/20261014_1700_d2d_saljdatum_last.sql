-- =============================================================================
-- D2D: säljdatumet låses (feedback från Lukas, godkänt av Gustav 14 okt).
--
-- Förut räknades ett sälj till den SENASTE gången någon satte Såld. När admin
-- rättade en adress (bytte status fram och tillbaka) flyttades säljet till
-- rättelsedagen — i topplistan, Utfall och lönen. Nummerbyten fick dessutom
-- dagens datum som signeringsdatum när numret lades in i efterhand.
--
-- Nu:
--  * Fältet "Såld datum" (sald_datum, finns sedan 0007) sätts automatiskt
--    första gången adressen blir Såld och ändras inte när statusen byts
--    fram och tillbaka. Admin kan ändra det för hand (sälj som registreras i
--    efterhand). Nummerbyten använder redan sald_datum som signeringsdatum.
--  * d2d_sald_tidpunkt(id, data) = säljtidpunkten: första Såld-aktiviteten;
--    har admin satt ett annat datum gäller det (kl 12 svensk tid).
--  * Topplistan (d2d_saljstatistik), lönen (d2d_lon_affarer) och Utfall
--    (d2d_sald_tid) använder den. Säljaren var redan data.saljare.
--  * Befintliga sålda adresser får sald_datum från första Såld-aktiviteten.
-- =============================================================================

create or replace function public.d2d_sald_tidpunkt(p_id uuid, p_data jsonb)
returns timestamptz language sql stable set search_path = public as $$
  with a as (
    select min(a.occurred_at) as t from activities a
     where a.record_id = p_id and a.activity_type = 'status_change' and a.metadata->>'to' = 'sald')
  select case
           when nullif(p_data->>'sald_datum', '') is not null
            and (a.t is null or (a.t at time zone 'Europe/Stockholm')::date <> (p_data->>'sald_datum')::date)
             then ((p_data->>'sald_datum')::date + time '12:00') at time zone 'Europe/Stockholm'
           else coalesce(a.t, nullif(p_data->>'senast_kontakt', '')::timestamptz)
         end
    from a
$$;
revoke execute on function public.d2d_sald_tidpunkt(uuid, jsonb) from public, anon;
grant execute on function public.d2d_sald_tidpunkt(uuid, jsonb) to authenticated, service_role;

-- Sätt sald_datum första gången adressen blir Såld.
create or replace function public.d2d_sald_datum_satt() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.object_type = 'd2d_lagenhet' and new.status = 'sald'
     and (tg_op = 'INSERT' or old.status is distinct from 'sald')
     and coalesce(new.data->>'sald_datum', '') = ''
     and coalesce(current_setting('d2d.import', true), '') <> '1' then
    new.data := new.data || jsonb_build_object('sald_datum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD'));
  end if;
  return new;
end $$;
revoke execute on function public.d2d_sald_datum_satt() from public, anon;

create or replace trigger trg_d2d_sald_datum
  before insert or update of status on public.records
  for each row when (new.status = 'sald')
  execute function public.d2d_sald_datum_satt();

-- Funktionerna.
create or replace function public.d2d_sald_tid(p_id uuid, p_data jsonb)
returns timestamptz language sql stable as $$
  select public.d2d_sald_tidpunkt(p_id, p_data)
$$;

do $$
declare v_src text; v_ny text;
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p
   where p.proname = 'd2d_lon_affarer' and p.pronamespace = 'public'::regnamespace;
  if position('d2d_sald_tidpunkt' in v_src) = 0 then
    v_ny := regexp_replace(v_src,
      'coalesce\(\s*\(select a\.occurred_at from activities a where a\.record_id = l\.id and a\.activity_type = ''status_change''\s+and a\.metadata->>''to'' = ''sald'' order by a\.occurred_at desc limit 1\),\s*\(l\.data->>''senast_kontakt''\)::timestamptz\)',
      'd2d_sald_tidpunkt(l.id, l.data)');
    if v_ny = v_src then raise exception 'd2d_lon_affarer: hittar inte texten'; end if;
    execute v_ny;
  end if;

  select pg_get_functiondef(p.oid) into v_src from pg_proc p
   where p.proname = 'd2d_saljstatistik' and p.pronamespace = 'public'::regnamespace;
  if position('d2d_sald_tidpunkt' in v_src) = 0 then
    v_ny := regexp_replace(v_src, 'select a\.t,(\s+)coalesce\(d2d_saljare_uuid',
                                  'select d2d_sald_tidpunkt(l.id, l.data) as t,\1coalesce(d2d_saljare_uuid');
    if v_ny = v_src then raise exception 'd2d_saljstatistik: hittar inte texten'; end if;
    execute v_ny;
  end if;
end $$;

-- Befintliga sålda adresser: sald_datum = dagen för första Såld.
update records l
   set data = l.data || jsonb_build_object('sald_datum',
         to_char(public.d2d_sald_tidpunkt(l.id, l.data) at time zone 'Europe/Stockholm', 'YYYY-MM-DD'))
 where l.object_type = 'd2d_lagenhet' and l.status = 'sald' and l.deleted_at is null
   and coalesce(l.data->>'sald_datum', '') = ''
   and public.d2d_sald_tidpunkt(l.id, l.data) is not null;
