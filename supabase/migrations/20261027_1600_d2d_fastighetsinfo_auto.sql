-- D2D: fastighetsinfon (Info-panelen) fylls automatiskt från befintligt underlag
-- när en fastighet läggs i ett projekt, och när lägenheter kopplas till en
-- fastighet som redan ligger i ett projekt (adresslistan importeras ofta efter
-- att projektet byggts). Samma regler som 20261027_1500_d2d_fastighetsinfo_fyll:
-- bara tomma fält fylls, manuellt ifyllt rörs aldrig.

create or replace function public.d2d_fyll_fastighetsinfo(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  with f as (
    select f.id, f.data,
      (select d.data from relationships r join records d on d.id = r.to_record_id
        where r.rel_type = 'd2d_fast_delivery' and r.from_record_id = f.id and d.deleted_at is null limit 1) as ld
    from records f
    where f.id = any(p_ids) and f.object_type = 'd2d_fastighet' and f.deleted_at is null
      and (f.data->>'befintlig_fiber' is null or f.data->>'befintlig_koax' is null or f.data->>'kundklar_datum' is null)),
  lag as (
    select r.to_record_id as fid,
      (select string_agg(distinct x, ', ') from unnest(array_agg(nullif(l.data->>'befintlig_fiber_adress', ''))) x
        where x is not null and x !~* '^(zitius|saknas\??|oklart|-|\d+|\d{4}-\d\d-\d\d)$') as fiber,
      (select string_agg(distinct x, ', ') from unnest(array_agg(nullif(l.data->>'befintlig_koax_adress', ''))) x
        where x is not null and x !~* '^(saknas\??|oklart|-|\d+)$') as koax,
      bool_or(l.data->>'befintlig_koax_adress' ~* '^saknas$') as koax_saknas
    from relationships r join records l on l.id = r.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
    where r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = any(p_ids) group by 1),
  ny as (
    select f.id,
      case when f.data->>'befintlig_fiber' is null then
        (select v from (select coalesce(nullif(f.ld->>'befintlig_fiberleverantor', ''), nullif(f.data->>'befintligt_nat', ''), lag.fiber) v) s
          where v !~* '^(oklart|-|\d+)$') end as fiber,
      case when f.data->>'befintlig_koax' is null then
        coalesce(lag.koax, case when lag.koax_saknas then 'Saknas' end) end as koax,
      case when f.data->>'kundklar_datum' is null then nullif(substr(f.ld->>'kundklar', 1, 10), '') end as kundklar
    from f left join lag on lag.fid = f.id),
  u as (
    update records r set data = r.data || jsonb_strip_nulls(jsonb_build_object(
        'befintlig_fiber', ny.fiber, 'befintlig_koax', ny.koax, 'kundklar_datum', ny.kundklar)),
      updated_at = now()
    from ny where r.id = ny.id and (ny.fiber is not null or ny.koax is not null or ny.kundklar is not null)
    returning 1)
  select count(*) into v_n from u;
  return v_n;
end $$;

revoke all on function public.d2d_fyll_fastighetsinfo(uuid[]) from public, anon, authenticated;

-- Fastighet läggs i projekt → fyll den.
create or replace function public.d2d_fastighetsinfo_vid_projekt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform d2d_fyll_fastighetsinfo((select array_agg(distinct n.from_record_id) from nya n where n.rel_type = 'd2d_fast_projekt'));
  return null;
end $$;

create or replace trigger trg_d2d_fastighetsinfo_vid_projekt
after insert on public.relationships
referencing new table as nya
for each statement execute function public.d2d_fastighetsinfo_vid_projekt();

-- Lägenheter kopplas till en fastighet som ligger i ett projekt → fyll den.
create or replace function public.d2d_fastighetsinfo_vid_lagenhet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform d2d_fyll_fastighetsinfo((
    select array_agg(distinct n.to_record_id) from nya n
    where n.rel_type = 'd2d_lag_fastighet'
      and exists (select 1 from relationships p where p.rel_type = 'd2d_fast_projekt' and p.from_record_id = n.to_record_id)));
  return null;
end $$;

create or replace trigger trg_d2d_fastighetsinfo_vid_lagenhet
after insert on public.relationships
referencing new table as nya
for each statement execute function public.d2d_fastighetsinfo_vid_lagenhet();
