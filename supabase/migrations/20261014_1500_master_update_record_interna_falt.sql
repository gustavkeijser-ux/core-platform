-- =============================================================================
-- update_record: oförändrade interna fält stoppar inte längre sparningen.
--
-- Formuläret (RecordDrawer) skickar hela postens data. D2D-fastigheter har
-- interna fält som inte finns i field_definitions (telia_adresser,
-- saljartilldelning, manuell_tilldelning, telia_adresser_hamtade), så
-- validate_record_data avvisade varje ändring: "fältet finns inte på
-- objektet" (feedback från Lukas 11 okt, Nanna 1).
-- Nu filtreras p_data först: okända fält vars värde är oförändrat hoppas
-- över. Ändrade okända fält avvisas som förut.
-- Körd 14 okt 2026 via pg_get_functiondef + replace (texten nedan).
-- =============================================================================
do $$
declare v_src text;
  v_old text := 'if p_data is not null then v_patch := validate_record_data(v_obj.id, p_data, ''update''); end if;';
  v_new text := 'if p_data is not null then
    -- Interna fält som inte finns i field_definitions (t.ex. telia_adresser,
    -- saljartilldelning på D2D-fastigheter) skickas med när hela posten sparas
    -- från formuläret. Oförändrade sådana fält hoppas över i stället för att
    -- stoppa sparningen; ändrade okända fält avvisas som förut.
    v_patch := validate_record_data(v_obj.id,
      (select coalesce(jsonb_object_agg(e.key, e.value), ''{}''::jsonb) from jsonb_each(p_data) e
        where exists (select 1 from field_definitions fd where fd.object_id = v_obj.id and fd.key = e.key)
           or (v_before.data -> e.key) is distinct from e.value),
      ''update'');
  end if;';
begin
  select pg_get_functiondef(p.oid) into v_src from pg_proc p
   where p.proname = 'update_record' and p.pronamespace = 'public'::regnamespace;
  if position('Oförändrade sådana fält' in v_src) > 0 then return; end if;
  if position(v_old in regexp_replace(v_src, '\s+', ' ', 'g')) = 0 then
    raise exception 'update_record: hittar inte texten';
  end if;
  execute replace(regexp_replace(v_src, '\s+', ' ', 'g'), v_old, v_new);
end $$;
