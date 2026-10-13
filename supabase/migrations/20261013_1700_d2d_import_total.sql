-- =====================================================================
--  20261013_1700 — Totallistan (Total Final) in i Lägenheter, utan projekt
--
--  d2d_import_fastighet_rader(beteckning, ort, rader): en fastighetsgrupp
--  ur en adresslista utan projekt.
--   1. Fastigheten matchas mot Telias adresslista (beteckning, ort vid
--      flera kommuner) och mot befintliga d2d_fastighet (samma beteckning
--      och ort; först den som är kopplad till Telia-leveransen, sedan den
--      med flest lägenheter). Saknas den skapas den UTAN projekt, med
--      uppgifter från leveransen (ägare, kundklar, TV, geo) och kopplas
--      till leveransen och fastigheten — då återanvänds den när
--      projektbyggaren väljer leveransen, och lägenheterna följer med.
--   2. Raderna läggs in med d2d_import_addresses i "totalläge"
--      (d2d.import_total = 1): systemet vinner — en lägenhet som redan
--      har annan status än Ej knackad behåller den; nya lägenheter utan
--      säljare i filen får ingen ägare (i stället för den som importerar).
--   3. Telias lägenheter som saknas i filen läggs till som Ej knackad
--      (d2d_fyll_lagenheter_fran_telia).
-- =====================================================================

do $$
declare v_def text; v_ny text;
begin
  v_def := pg_get_functiondef('public.d2d_import_addresses(uuid,jsonb)'::regprocedure);
  if position('d2d.import_total' in v_def) > 0 then return; end if;
  v_ny := replace(v_def,
    'if v_status is not null and v_status <> ''ej_knackad'' and v_status is distinct from v_cur then',
    'if v_status is not null and v_status <> ''ej_knackad'' and v_status is distinct from v_cur'
    || E'\n         and (coalesce(current_setting(''d2d.import_total'', true), '''') <> ''1'' or coalesce(v_cur, ''ej_knackad'') = ''ej_knackad'') then');
  if v_ny = v_def then raise exception 'Statusraden hittades inte'; end if;
  v_def := v_ny;
  v_ny := replace(v_def,
    'coalesce(v_status, ''ej_knackad''), coalesce(v_sj, auth.uid()), v_data);',
    'coalesce(v_status, ''ej_knackad''),'
    || E'\n              coalesce(v_sj, case when coalesce(current_setting(''d2d.import_total'', true), '''') = ''1'' then null else auth.uid() end), v_data);');
  if v_ny = v_def then raise exception 'Insert-raden hittades inte'; end if;
  execute v_ny;
end $$;

create or replace function public.d2d_import_fastighet_rader(p_beteckning text, p_ort text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := my_tenant_id();
  v_bet text := upper(btrim(regexp_replace(coalesce(p_beteckning, ''), '\s+', ' ', 'g')));
  v_ort text := nullif(btrim(coalesce(p_ort, '')), '');
  v_t telia_adresser;
  v_ld jsonb;
  v_fid uuid;
  v_ny boolean := false;
  v_res jsonb;
  v_fyllda int := 0;
  v_prop uuid;
begin
  if v_bet = '' then raise exception 'Fastighetsbeteckning saknas' using errcode = '22023'; end if;
  if not can_row('d2d_fastighet', 'create', auth.uid()) or not can_row('d2d_lagenhet', 'create', auth.uid()) then
    raise exception 'Saknar behörighet att importera adresser' using errcode = '42501';
  end if;

  -- Telias rad för fastigheten (rätt ort om beteckningen finns i flera kommuner)
  select t.* into v_t from telia_adresser t
   where t.tenant_id = v_tenant and t.fastighetsbeteckning = v_bet
   order by (v_ort is not null and (samma_ort(t.stad, v_ort) or samma_ort(t.kommun, v_ort))) desc,
            (t.delivery_id is not null) desc, (coalesce(t.status, '') <> 'Inactive') desc, t.senast_sedd desc nulls last
   limit 1;

  -- Befintlig fastighet: kopplad till leveransen, annars samma beteckning och ort
  select f.id into v_fid
    from records f
   where f.tenant_id = v_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
     and (
       (v_t.delivery_id is not null and exists (select 1 from relationships r
          where r.rel_type = 'd2d_fast_delivery' and r.from_record_id = f.id and r.to_record_id = v_t.delivery_id))
       or (upper(btrim(regexp_replace(coalesce(f.data->>'fastighetsbeteckning', ''), '\s+', ' ', 'g'))) = v_bet
           and (coalesce(f.data->>'ort', '') = '' and coalesce(f.data->>'kommun', '') = ''
                or samma_ort(f.data->>'ort', v_ort) or samma_ort(f.data->>'kommun', v_ort)
                or samma_ort(f.data->>'ort', v_t.stad) or samma_ort(f.data->>'kommun', v_t.kommun)
                or samma_ort(f.data->>'ort', v_t.kommun) or samma_ort(f.data->>'kommun', v_t.stad)))
     )
   order by (v_t.delivery_id is not null and exists (select 1 from relationships r
              where r.rel_type = 'd2d_fast_delivery' and r.from_record_id = f.id and r.to_record_id = v_t.delivery_id)) desc,
            (select count(*) from relationships r where r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = f.id) desc,
            f.created_at
   limit 1;

  if v_t.delivery_id is not null then
    select d.data into v_ld from records d where d.id = v_t.delivery_id and d.deleted_at is null;
  end if;

  if v_fid is null then
    v_fid := gen_random_uuid();
    v_ny := true;
    insert into records (id, tenant_id, object_type, status, owner_user_id, data)
    values (v_fid, v_tenant, 'd2d_fastighet', 'ej_startad', null, jsonb_strip_nulls(jsonb_build_object(
      'name',                 coalesce(nullif(v_ld->>'adress', ''),
                                       nullif(btrim(coalesce(initcap(v_t.gata), '') || ' ' || coalesce(v_t.gatunummer, '')), ''),
                                       p_beteckning),
      'fastighetsbeteckning', coalesce(v_t.fastighetsbeteckning_telia, initcap(v_bet)),
      'fastighetsagare',      nullif(v_ld->>'fastighetsagare', ''),
      'befintligt_nat',       nullif(v_ld->>'befintlig_fiberleverantor', ''),
      'nytt_tv_installation', coalesce(nullif(v_ld->>'kanalpaket', ''), nullif(v_ld->>'kanalpaket_projektplan', '')),
      'kabel_tv',             nullif(v_ld->>'befintlig_koax', ''),
      'avtalstid_koax',       nullif(v_ld->>'avtalstid_ko', ''),
      'kundklar_datum',       nullif(v_ld->>'kundklar', ''),
      'ort',                  coalesce(nullif(v_ld->>'ort', ''), initcap(v_t.stad), initcap(v_ort)),
      'kommun',               coalesce(initcap(v_t.kommun), initcap(v_ort)),
      'adress',               nullif(v_ld->>'adress', ''),
      'postnummer',           coalesce(nullif(v_ld->>'postnummer', ''), v_t.postnummer),
      'geo_lat',              v_ld->'geo_lat',
      'geo_lon',              v_ld->'geo_lon',
      'geo_kalla',            v_ld->'geo_kalla')));
  end if;

  -- Koppla till leveransen (och dess fastighet) om ingen annan d2d-fastighet har den
  if v_t.delivery_id is not null and v_ld is not null and not exists (
       select 1 from relationships r where r.rel_type = 'd2d_fast_delivery' and r.to_record_id = v_t.delivery_id) then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_tenant, v_fid, v_t.delivery_id, 'd2d_fast_delivery') on conflict do nothing;
    select r.to_record_id into v_prop from relationships r
     where r.rel_type = 'delivery_property' and r.from_record_id = v_t.delivery_id limit 1;
    if v_prop is not null and not exists (select 1 from relationships r
         where r.rel_type = 'd2d_fast_property' and r.from_record_id = v_fid) then
      insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
      values (v_tenant, v_fid, v_prop, 'd2d_fast_property') on conflict do nothing;
    end if;
  end if;

  perform set_config('d2d.import_total', '1', true);
  v_res := d2d_import_addresses(v_fid, p_rows);
  perform set_config('d2d.import_total', '', true);
  v_fyllda := d2d_fyll_lagenheter_fran_telia(v_fid);

  return v_res || jsonb_build_object('fastighet_id', v_fid, 'ny_fastighet', v_ny,
    'telia_fastighet', v_t.objektnummer is not null, 'telia_tillagda', v_fyllda);
end
$function$;

grant execute on function public.d2d_import_fastighet_rader(text, text, jsonb) to authenticated;

-- Alla dörrsäljare ser och kan jobba på alla lägenheter (inte bara tilldelade).
update role_permissions set scope = 'tenant'
 where role_id = '8f2aee09-2359-4cf6-a6e6-137b3aacc10b'   -- Dörrsäljare
   and object_type = 'd2d_lagenhet' and action in ('read', 'update') and scope = 'own';
