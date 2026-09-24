-- =============================================================================
-- 0019 — d2d_import_addresses: kommentaren följde inte med
-- =============================================================================
-- Adressimporten (manuell inmatning i Projektbyggaren, och nu även
-- Excel-importen) skickar med en kommentar per rad, men funktionen mappade
-- aldrig in den i lägenhetsposten — kommentarer föll bort i tysthet.
-- OBS: den här migrationen är en efterhandsdokumentation av en ändring som
-- redan låg live (funktionen har tidigare skapats direkt mot databasen,
-- vilket gjort att filen och databasen kommit i otakt — se kommentaren i
-- 0018 om samma mönster). Definitionen nedan matchar nu exakt vad som körs.
-- =============================================================================

create or replace function public.d2d_import_addresses(p_fastighet_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
  v_owner uuid;
  v_row jsonb;
  v_count int := 0;
  v_id uuid;
begin
  v_tenant := my_tenant_id();

  select owner_user_id into v_owner from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then
    raise exception 'Fastigheten finns inte' using errcode = 'P0002';
  end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att lägga in adresser' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_id := gen_random_uuid();
    insert into records (id, tenant_id, object_type, status, owner_user_id, data)
    values (
      v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad', auth.uid(),
      jsonb_strip_nulls(jsonb_build_object(
        'name',                       nullif(v_row->>'lagenhetsnummer',''),
        'kommentar',                  nullif(v_row->>'kommentar',''),
        'postort',                    nullif(v_row->>'postort',''),
        'postnummer',                 nullif(v_row->>'postnummer',''),
        'fastighetsbeteckning',       nullif(v_row->>'fastighetsbeteckning',''),
        'portkod_adress',             nullif(v_row->>'portkod',''),
        'gatunamn',                   nullif(v_row->>'gatunamn',''),
        'gatunummer',                 nullif(v_row->>'gatnr',''),
        'ingang',                     nullif(v_row->>'ingang',''),
        'alias',                      nullif(v_row->>'alias',''),
        'punkt_id',                   nullif(v_row->>'punktid',''),
        'klass',                      nullif(v_row->>'klass',''),
        'cpe_model',                  nullif(v_row->>'cpe_model',''),
        'installationsdatum_adress',  nullif(v_row->>'installationsdatum',''),
        'befintlig_fiber_adress',     nullif(v_row->>'befintlig_fiber',''),
        'befintlig_koax_adress',      nullif(v_row->>'befintlig_koax',''),
        'koax_avslutsdatum',          nullif(v_row->>'koax_avslutsdatum',''),
        'befintligt_kanalpaket',      nullif(v_row->>'befintligt_kanalpaket',''),
        'nytt_kanalpaket',            nullif(v_row->>'nytt_kanalpaket','')
      ))
    );
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_tenant, v_id, p_fastighet_id, 'd2d_lag_fastighet')
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  perform emit_event('d2d.addresses_imported', p_fastighet_id, jsonb_build_object('count', v_count));

  return jsonb_build_object('imported', v_count);
end
$function$;
