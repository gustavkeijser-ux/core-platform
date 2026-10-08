-- =====================================================================
--  20261008_1130 — Egen adressimport synkar med Telias adresslista
--
--  d2d_import_addresses (manuell inmatning och Excel-import i
--  projektbyggaren) skapade alltid nya lägenheter: ingen koppling till
--  Telias adresslista och dubbletter när samma adress importerades igen
--  eller redan hämtats med "Hämta lägenheter från Telia".
--
--  Nu, per rad:
--   1. Raden matchas mot Telias lista (telia_adresser) på PunktID eller
--      gata + gatunummer + lägenhetsnummer inom fastighetsbeteckningen.
--      Träff ger Telias objektnummer, status och "Har Telia Bredband",
--      och fyller luckor (postnummer, postort, ingång, PunktID, klass, CPE).
--   2. Finns lägenheten redan på fastigheten (Telias objektnummer, PunktID
--      eller gata + nummer + lägenhetsnummer) uppdateras den med radens
--      värden i stället för att dubbleras — status och säljare rörs inte.
--   3. Annars skapas den. Importerar man fler adresser senare läggs bara
--      de nya till.
--  Svar: imported (nya), uppdaterade, telia_matchade, total.
-- =====================================================================

create or replace function public.d2d_import_addresses(p_fastighet_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_owner uuid;
  v_fast_bet text;
  v_row jsonb;
  v_data jsonb;
  v_gata text; v_nr text; v_lgh text; v_ingang text; v_punkt text; v_bet text;
  v_telia record;
  v_lag_id uuid;
  v_id uuid;
  v_nya int := 0;
  v_upp int := 0;
  v_telia_n int := 0;
  v_total int := 0;
begin
  v_tenant := my_tenant_id();

  select owner_user_id, upper(btrim(coalesce(data->>'fastighetsbeteckning', '')))
    into v_owner, v_fast_bet
    from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then
    raise exception 'Fastigheten finns inte' using errcode = 'P0002';
  end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att lägga in adresser' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_total := v_total + 1;
    v_gata   := upper(btrim(coalesce(v_row->>'gatunamn', '')));
    v_nr     := upper(btrim(coalesce(v_row->>'gatnr', '')));
    v_lgh    := btrim(coalesce(v_row->>'lagenhetsnummer', ''));
    v_ingang := upper(btrim(coalesce(v_row->>'ingang', '')));
    v_punkt  := nullif(btrim(coalesce(v_row->>'punktid', '')), '');
    v_bet    := upper(btrim(coalesce(v_row->>'fastighetsbeteckning', '')));

    -- 1. Telias rad för adressen (PunktID, annars gata + nummer + lgh inom beteckningen)
    v_telia := null;
    select t.* into v_telia
      from telia_adresser t
     where t.tenant_id = v_tenant
       and (
         (v_punkt is not null and t.punkt_id = v_punkt)
         or (
           t.fastighetsbeteckning in (nullif(v_fast_bet, ''), nullif(v_bet, ''))
           and v_gata <> ''
           and upper(coalesce(t.gata, '')) = v_gata
           and upper(coalesce(t.gatunummer, '')) = v_nr
           and coalesce(t.lagenhetsnummer, '') = v_lgh
           and (v_ingang = '' or coalesce(t.ingang, '') = '' or upper(t.ingang) = v_ingang)
         )
       )
     order by (v_punkt is not null and t.punkt_id = v_punkt) desc,
              (coalesce(t.status, '') <> 'Inactive') desc, t.senast_sedd desc
     limit 1;
    if v_telia.objektnummer is not null then v_telia_n := v_telia_n + 1; end if;
    -- Saknar raden ingång används Telias (så "1101 A" och "1101 B" inte blandas ihop)
    if v_ingang = '' then v_ingang := upper(btrim(coalesce(v_telia.ingang, ''))); end if;

    -- Radens egna värden vinner; Telia fyller luckor och ger Telia-fälten.
    v_data := jsonb_strip_nulls(jsonb_build_object(
      'name',                       coalesce(nullif(v_lgh, ''), v_telia.lagenhetsnummer),
      'kommentar',                  nullif(v_row->>'kommentar',''),
      'postort',                    coalesce(nullif(v_row->>'postort',''), initcap(v_telia.stad)),
      'postnummer',                 coalesce(nullif(v_row->>'postnummer',''), v_telia.postnummer),
      'fastighetsbeteckning',       coalesce(nullif(v_row->>'fastighetsbeteckning',''),
                                             v_telia.fastighetsbeteckning_telia, v_telia.fastighetsbeteckning),
      'portkod_adress',             nullif(v_row->>'portkod',''),
      'gatunamn',                   coalesce(nullif(v_row->>'gatunamn',''), v_telia.gata),
      'gatunummer',                 coalesce(nullif(v_row->>'gatnr',''), v_telia.gatunummer),
      'ingang',                     coalesce(nullif(v_ingang, ''), v_telia.ingang),
      'alias',                      nullif(v_row->>'alias',''),
      'punkt_id',                   coalesce(v_punkt, v_telia.punkt_id),
      'klass',                      coalesce(nullif(v_row->>'klass',''), v_telia.byggnadskategori),
      'cpe_model',                  coalesce(nullif(v_row->>'cpe_model',''), v_telia.cpe_modell),
      'installationsdatum_adress',  nullif(v_row->>'installationsdatum',''),
      'befintlig_fiber_adress',     coalesce(nullif(v_row->>'befintlig_fiber',''), v_telia.kommunikationsoperator),
      'befintlig_koax_adress',      nullif(v_row->>'befintlig_koax',''),
      'koax_avslutsdatum',          nullif(v_row->>'koax_avslutsdatum',''),
      'befintligt_kanalpaket',      nullif(v_row->>'befintligt_kanalpaket',''),
      'nytt_kanalpaket',            nullif(v_row->>'nytt_kanalpaket',''),
      'har_telia_bredband',         v_telia.har_telia_bredband,
      'telia_status',               v_telia.status,
      'telia_objektnummer',         v_telia.objektnummer
    ));

    -- 2. Finns lägenheten redan på fastigheten?
    v_lag_id := null;
    select l.id into v_lag_id
      from relationships rl
      join records l on l.id = rl.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
     where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = p_fastighet_id
       and (
         (v_telia.objektnummer is not null and l.data->>'telia_objektnummer' = v_telia.objektnummer)
         or (coalesce(v_punkt, v_telia.punkt_id) is not null and l.data->>'punkt_id' = coalesce(v_punkt, v_telia.punkt_id))
         or (
           coalesce(v_data->>'gatunamn', '') <> ''
           and upper(btrim(coalesce(l.data->>'gatunamn', ''))) = upper(coalesce(v_data->>'gatunamn', ''))
           and upper(btrim(coalesce(l.data->>'gatunummer', ''))) = upper(coalesce(v_data->>'gatunummer', ''))
           and btrim(coalesce(l.data->>'name', '')) = coalesce(v_data->>'name', '')
           and (v_ingang = '' or coalesce(l.data->>'ingang', '') = ''
                or upper(btrim(l.data->>'ingang')) = v_ingang)
         )
       )
     order by (v_telia.objektnummer is not null and l.data->>'telia_objektnummer' = v_telia.objektnummer) desc,
              (v_ingang <> '' and upper(btrim(coalesce(l.data->>'ingang', ''))) = v_ingang) desc,
              l.created_at
     limit 1;

    if v_lag_id is not null then
      -- Befintlig kommentar (ofta säljarens) skrivs inte över: ny text läggs till på egen rad.
      update records l
         set data = l.data || v_data || case
               when nullif(v_data->>'kommentar', '') is null then '{}'::jsonb
               when nullif(btrim(l.data->>'kommentar'), '') is null then '{}'::jsonb
               when position(v_data->>'kommentar' in l.data->>'kommentar') > 0
                 then jsonb_build_object('kommentar', l.data->>'kommentar')
               else jsonb_build_object('kommentar', (l.data->>'kommentar') || E'\n' || (v_data->>'kommentar'))
             end,
             updated_at = now()
       where l.id = v_lag_id;
      v_upp := v_upp + 1;
    else
      -- 3. Ny lägenhet
      v_id := gen_random_uuid();
      insert into records (id, tenant_id, object_type, status, owner_user_id, data)
      values (v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad', auth.uid(), v_data);
      insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
      values (v_tenant, v_id, p_fastighet_id, 'd2d_lag_fastighet')
      on conflict do nothing;
      v_nya := v_nya + 1;
    end if;
  end loop;

  perform emit_event('d2d.addresses_imported', p_fastighet_id,
    jsonb_build_object('count', v_nya, 'uppdaterade', v_upp, 'telia_matchade', v_telia_n));

  return jsonb_build_object('imported', v_nya, 'uppdaterade', v_upp, 'telia_matchade', v_telia_n, 'total', v_total);
end
$function$;
