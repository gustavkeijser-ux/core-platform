-- Justering av "Vad såldes?" (D2D):
--  * Bort: WiFi / Hårdvara, Fristående sport, TV / Streaminghårdvara
--  * Trygghet: bara Ja/Nej (boolean-fält, inga alternativ)
--  * TV: TV Bas, TV Mellan, TV Mycket (TV Mini → TV Bas)

-- 1. Ta bort de tre kategorierna, både definition och sparade värden.
update records r
   set data = (r.data - 'salt_wifi' - 'salt_fristaende_sport' - 'salt_tv_hardvara')
            || case when r.data ? 'salt_svar' and jsonb_typeof(r.data->'salt_svar') = 'object'
                    then jsonb_build_object('salt_svar',
                           (r.data->'salt_svar') - 'salt_wifi' - 'salt_fristaende_sport' - 'salt_tv_hardvara')
                    else '{}'::jsonb end
 where r.object_type = 'd2d_lagenhet'
   and (r.data ?| array['salt_wifi','salt_fristaende_sport','salt_tv_hardvara','salt_svar']);

delete from field_definitions fd
 using object_definitions od
 where od.id = fd.object_id and od.key = 'd2d_lagenhet'
   and fd.key in ('salt_wifi', 'salt_fristaende_sport', 'salt_tv_hardvara');

-- 2. TV-alternativ.
update field_definitions fd
   set options = fd.options || '{"choices":[{"key":"tv_bas","label":"TV Bas"},{"key":"tv_mellan","label":"TV Mellan"},{"key":"tv_mycket","label":"TV Mycket"}]}'::jsonb
  from object_definitions od
 where od.id = fd.object_id and od.key = 'd2d_lagenhet' and fd.key = 'salt_tv';

update records
   set data = data || '{"salt_tv":"tv_bas"}'::jsonb
 where object_type = 'd2d_lagenhet' and data->>'salt_tv' = 'tv_mini';

-- 3. Trygghet → Ja/Nej. Värdet blir true/false; Ja-svar sedan tidigare följer med.
update field_definitions fd
   set field_type = 'boolean',
       label = 'Trygghetspaket',
       options = fd.options - 'choices'
  from object_definitions od
 where od.id = fd.object_id and od.key = 'd2d_lagenhet' and fd.key = 'salt_trygghet';

update records
   set data = data || jsonb_build_object('salt_trygghet',
         case when data->>'salt_trygghet' = 'trygghetspaketet' then true
              when (data->'salt_svar'->>'salt_trygghet')::boolean is true then true
              when (data->'salt_svar'->>'salt_trygghet')::boolean is false then false
              else null end)
 where object_type = 'd2d_lagenhet'
   and (data ? 'salt_trygghet' or data->'salt_svar' ? 'salt_trygghet');
