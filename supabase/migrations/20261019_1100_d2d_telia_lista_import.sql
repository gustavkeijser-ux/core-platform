-- =============================================================================
-- D2D: alla adresser i Telias lista in i CRM:et (Gustav 19 okt: "alla adresser
-- från telias fil ska med in, men får inte skriva över befintliga kommentarer").
--
-- Telias lista (telia_adresser) hade 18 900 rader, CRM:et 11 839 lägenheter.
-- 8 174 Telia-rader saknades (fastigheten fanns inte i D2D, lokaler FS/FTG,
-- aldrig hämtade, utan fastighetsbeteckning). Engångsimport:
--  * Bara NYA lägenheter läggs in (Ej knackad). Befintliga lägenheter rörs inte
--    alls — inga kommentarer, statusar eller fält skrivs över.
--  * Hoppar över rader som redan finns: samma Telia-objektnummer/PunktID
--    någonstans i CRM:et, eller samma gata + nummer + lgh (+ ingång) på
--    fastigheten (574 st — egna/importerade adresser utan objektnummer).
--  * Fastighet: befintlig D2D-fastighet med samma beteckning (vid flera: samma
--    ort/postnummer), annars en ny fastighet (status ej_startad, utan projekt)
--    per beteckning + kommun; saknas beteckning heter den som adressen.
--  * Lokaler (FS/FTG) utan lgh-nummer får namnet "Lokal"; klass = Telias kategori.
-- Körd 19 okt 2026 i omgångar via d2d_telia_lista_import(p_max) (security
-- definer, ingen åtkomst för inloggade): 7 581 nya lägenheter, 350 nya
-- fastigheter. CRM:et har nu 19 420 lägenheter; 18 307 av Telias 18 900 rader
-- är kopplade på objektnummer, resten finns redan som adress.
-- =============================================================================

create or replace function public.d2d_telia_lista_import(p_max int) returns int
language plpgsql security definer set search_path = public as $$
-- Engångsimport 19 okt 2026: Telias adresser som saknas i CRM:et läggs in som
-- nya lägenheter (Ej knackad). Befintliga lägenheter rörs aldrig.
declare
  t record; v_fid uuid; v_id uuid; v_nyckel text; v_bet text;
  n_lgh int := 0;
  nya jsonb := '{}'::jsonb;
  v_tenant uuid := 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1';
begin
  for t in
    select a.* from telia_adresser a
     where a.tenant_id = v_tenant
       and not exists (select 1 from records l where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
                        and (l.data->>'telia_objektnummer' = a.objektnummer
                             or (coalesce(a.punkt_id, '') <> '' and l.data->>'punkt_id' = a.punkt_id)))
     order by coalesce(a.fastighetsbeteckning, ''), a.gata,
              nullif(regexp_replace(coalesce(a.gatunummer, ''), '\D', '', 'g'), '')::int nulls last, a.gatunummer, a.ingang, a.lagenhetsnummer
     limit p_max
  loop
    v_bet := nullif(upper(btrim(coalesce(t.fastighetsbeteckning, t.fastighetsbeteckning_telia, ''))), '');
    v_fid := null;
    if v_bet is not null then
      select f.id into v_fid from records f
       where f.tenant_id = v_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
         and upper(btrim(coalesce(f.data->>'fastighetsbeteckning', ''))) = v_bet
       order by (samma_ort(t.kommun, f.data->>'kommun') or samma_ort(t.stad, f.data->>'ort')
                 or samma_ort(t.kommun, f.data->>'ort') or samma_ort(t.stad, f.data->>'kommun')
                 or (t.postnummer is not null and t.postnummer = replace(coalesce(f.data->>'postnummer', ''), ' ', ''))) desc,
                f.created_at
       limit 1;
    else
      select f.id into v_fid from records f
       where f.tenant_id = v_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
         and f.data->>'name' = initcap(concat_ws(' ', t.gata, t.gatunummer)) || coalesce(', ' || initcap(t.stad), '')
       limit 1;
    end if;
    if v_fid is null then
      v_nyckel := coalesce(v_bet || '|' || upper(coalesce(t.kommun, t.stad, '')),
                           upper(concat_ws(' ', t.gata, t.gatunummer)) || '|' || upper(coalesce(t.stad, '')));
      if nya ? v_nyckel then
        v_fid := (nya->>v_nyckel)::uuid;
      else
        v_fid := gen_random_uuid();
        nya := nya || jsonb_build_object(v_nyckel, v_fid);
        insert into records (id, tenant_id, object_type, status, owner_user_id, data)
        values (v_fid, v_tenant, 'd2d_fastighet', 'ej_startad', null, jsonb_strip_nulls(jsonb_build_object(
          'name', coalesce(v_bet, initcap(concat_ws(' ', t.gata, t.gatunummer)) || coalesce(', ' || initcap(t.stad), '')),
          'fastighetsbeteckning', coalesce(t.fastighetsbeteckning_telia, t.fastighetsbeteckning),
          'ort', initcap(t.stad), 'kommun', initcap(coalesce(t.kommun, t.stad)), 'postnummer', t.postnummer,
          'telia_adresser', true,
          'telia_adresser_hamtade', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI'))));
      end if;
    end if;
    if exists (
      select 1 from relationships rl join records l on l.id = rl.from_record_id and l.deleted_at is null
       where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = v_fid
         and upper(btrim(coalesce(l.data->>'gatunamn', ''))) = upper(btrim(coalesce(t.gata, '')))
         and upper(btrim(coalesce(l.data->>'gatunummer', ''))) = upper(btrim(coalesce(t.gatunummer, '')))
         and upper(btrim(coalesce(l.data->>'name', ''))) = upper(btrim(coalesce(t.lagenhetsnummer, '')))
         and (coalesce(l.data->>'ingang', '') = '' or coalesce(t.ingang, '') = ''
              or upper(btrim(l.data->>'ingang')) = upper(btrim(t.ingang)))) then
      continue;
    end if;
    n_lgh := n_lgh + 1;
    v_id := gen_random_uuid();
    insert into records (id, tenant_id, object_type, status, owner_user_id, data)
    values (v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad',
      (select owner_user_id from records where id = v_fid),
      jsonb_strip_nulls(jsonb_build_object(
        'name', coalesce(nullif(btrim(t.lagenhetsnummer), ''), case when t.byggnadskategori in ('FS', 'FTG') then 'Lokal' end),
        'gatunamn', t.gata, 'gatunummer', t.gatunummer, 'ingang', t.ingang,
        'postnummer', t.postnummer, 'postort', initcap(t.stad),
        'fastighetsbeteckning', coalesce(t.fastighetsbeteckning_telia, t.fastighetsbeteckning),
        'punkt_id', t.punkt_id, 'klass', t.byggnadskategori, 'cpe_model', t.cpe_modell,
        'befintlig_fiber_adress', t.kommunikationsoperator, 'har_telia_bredband', t.har_telia_bredband,
        'telia_status', t.status, 'telia_objektnummer', t.objektnummer)));
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_tenant, v_id, v_fid, 'd2d_lag_fastighet') on conflict do nothing;
  end loop;
  return n_lgh;
end $$;
revoke execute on function public.d2d_telia_lista_import(int) from public, anon, authenticated;

-- Kördes 19 okt 2026 tills den gav 0 (1 454 + 2 125 + 2 033 + 1 969 = 7 581):
--   select public.d2d_telia_lista_import(2500);
