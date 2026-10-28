-- D2D: fyll fastighetsinfon (Info-panelen i projektbyggaren) för fastigheter i projekt
-- från befintligt underlag. Bara tomma fält fylls; manuellt ifyllt rörs inte.
--   befintlig_fiber ← leveransens "befintlig fiberleverantör" (projektplanen),
--                     annars fastighetens befintligt_nat, annars lägenheternas
--                     befintlig_fiber_adress (Telias adresslista) utom Zitius/Saknas/datum.
--   befintlig_koax  ← lägenheternas befintlig_koax_adress (Telias adresslista);
--                     "Saknas" skrivs in när listan säger så.
--   kundklar_datum  ← leveransens kundklar.
-- Körd 2026-10-27 mot riktiga databasen. Kan köras om (idempotent).
with f as (
  select distinct f.id, f.data,
    (select d.data from relationships r join records d on d.id = r.to_record_id
      where r.rel_type = 'd2d_fast_delivery' and r.from_record_id = f.id and d.deleted_at is null limit 1) as ld
  from records f join relationships p on p.rel_type = 'd2d_fast_projekt' and p.from_record_id = f.id
  where f.object_type = 'd2d_fastighet' and f.deleted_at is null),
lag as (
  select r.to_record_id as fid,
    (select string_agg(distinct x, ', ') from unnest(array_agg(nullif(l.data->>'befintlig_fiber_adress', ''))) x
      where x is not null and x !~* '^(zitius|saknas\??|oklart|-|\d+|\d{4}-\d\d-\d\d)$') as fiber,
    (select string_agg(distinct x, ', ') from unnest(array_agg(nullif(l.data->>'befintlig_koax_adress', ''))) x
      where x is not null and x !~* '^(saknas\??|oklart|-|\d+)$') as koax,
    bool_or(l.data->>'befintlig_koax_adress' ~* '^saknas$') as koax_saknas
  from relationships r join records l on l.id = r.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
  where r.rel_type = 'd2d_lag_fastighet' group by 1),
ny as (
  select f.id,
    case when f.data->>'befintlig_fiber' is null then
      (select v from (select coalesce(nullif(f.ld->>'befintlig_fiberleverantor', ''), nullif(f.data->>'befintligt_nat', ''), lag.fiber) v) s
        where v !~* '^(oklart|-|\d+)$') end as fiber,
    case when f.data->>'befintlig_koax' is null then
      coalesce(lag.koax, case when lag.koax_saknas then 'Saknas' end) end as koax,
    case when f.data->>'kundklar_datum' is null then nullif(substr(f.ld->>'kundklar', 1, 10), '') end as kundklar
  from f left join lag on lag.fid = f.id)
update records r set data = r.data || jsonb_strip_nulls(jsonb_build_object(
    'befintlig_fiber', ny.fiber, 'befintlig_koax', ny.koax, 'kundklar_datum', ny.kundklar)),
  updated_at = now()
from ny where r.id = ny.id and (ny.fiber is not null or ny.koax is not null or ny.kundklar is not null);
