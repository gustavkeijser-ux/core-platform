-- =====================================================================
--  20261013_2100 — D2D-sälj → Alla lägenheter i ett anrop
--
--  Vyn hämtade alla lägenheter, alla lägenhet→fastighet-relationer,
--  fastigheter och projekt sida för sida genom RLS (kontroll per rad) —
--  många sekunder med ~10 000 lägenheter. d2d_alla_lagenheter() ger allt
--  i ett svar: lägenheterna (bara fälten listan visar — kortet
--  hämtar hela posten när den öppnas) med
--  fastighets-id, fastigheterna (titel, ort, projekt) och projekten.
--
--  Återkopplingar som är kopplade till en säljare (ägare eller säljare)
--  syns bara för den säljaren och för administratörer.
-- =====================================================================

create or replace function public.d2d_alla_lagenheter()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with t as (
    select my_tenant_id() as tenant, my_scope('d2d_lagenhet', 'read') as scope,
           auth.uid() as me, is_admin() as admin, can_do('d2d_lagenhet', 'read') as kan
  ),
  -- data läses en gång per rad (annars packas den upp en gång per fält)
  raa as materialized (
    select l.id, l.status, l.owner_user_id, l.title, l.updated_at, l.data as d, rl.to_record_id as fid
      from t
      join records l on l.tenant_id = t.tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
      left join relationships rl on rl.from_record_id = l.id and rl.rel_type = 'd2d_lag_fastighet'
     where t.kan and (t.scope = 'tenant' or in_scope(t.scope, l.owner_user_id))
  ),
  lag as materialized (
    select r.id, r.status, r.owner_user_id, r.title, r.updated_at, r.fid,
           jsonb_strip_nulls(jsonb_build_object(
             'name', d->'name', 'alias', d->'alias', 'gatunamn', d->'gatunamn',
             'gatunummer', d->'gatunummer', 'ingang', d->'ingang', 'postort', d->'postort',
             'kund_namn', d->'kund_namn', 'kund_telefon', d->'kund_telefon',
             'kommentar', d->'kommentar', 'saljare', d->'saljare',
             'antal_knackningar', d->'antal_knackningar', 'senast_kontakt', d->'senast_kontakt',
             'aterkoppling_datum', d->'aterkoppling_datum', 'tillfallig', d->'tillfallig')) as data
      from raa r, t
     where t.admin
        or r.status is distinct from 'aterkoppling'
        or (r.owner_user_id is null and nullif(r.d->>'saljare', '') is null)
        or r.owner_user_id = t.me
        or r.d->>'saljare' = t.me::text
  ),
  fast as (
    select f.id, f.title, f.data,
           (select rp.to_record_id from relationships rp
              join records p on p.id = rp.to_record_id and p.deleted_at is null
             where rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt' limit 1) as projekt_id
      from records f
     where f.id in (select distinct fid from lag where fid is not null) and f.deleted_at is null
  )
  select jsonb_build_object(
    'lagenheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'status', status, 'owner_user_id', owner_user_id,
        'title', title, 'updated_at', updated_at, 'data', data, 'fastighet_id', fid))
        from lag), '[]'::jsonb),
    'fastigheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'object_type', 'd2d_fastighet', 'title', title,
        'data', jsonb_strip_nulls(jsonb_build_object(
           'fastighetsbeteckning', data->'fastighetsbeteckning', 'ort', data->'ort',
           'postort', data->'postort', 'kommun', data->'kommun', 'tillfallig', data->'tillfallig')),
        'projekt_id', projekt_id)) from fast), '[]'::jsonb),
    'projekt', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'object_type', 'd2d_projekt',
        'title', p.title, 'data', p.data))
        from records p where p.id in (select projekt_id from fast where projekt_id is not null)), '[]'::jsonb)
  )
$function$;

grant execute on function public.d2d_alla_lagenheter() to authenticated;
