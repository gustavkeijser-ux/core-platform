-- Lägger till de fält som d2dSkapaFastighetFranLeverans() (src/lib/data.ts)
-- skickar med vid skapande av d2d_fastighet från en leverans (ärvda
-- adress-/geo-fält), så att create_record()/validate_record_data() accepterar
-- dem. Fälten fanns redan i praktiken på "delivery" (skrivs dit direkt av
-- geokodningsfunktionen, utanför create_record-valideringen), men behövde
-- registreras explicit på d2d_fastighet eftersom create_record validerar
-- varje nyckel i p_data mot field_definitions.
insert into public.field_definitions
  (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, visibility, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.field_type, false, false, '{}'::jsonb, null, 'all', v.sort_order
from public.object_definitions od
cross join (values
  ('ort', 'Ort', 'text', 41),
  ('adress', 'Adress', 'text', 42),
  ('kommun', 'Kommun', 'text', 43),
  ('postnummer', 'Postnummer', 'text', 44),
  ('geo_lat', 'Latitud', 'number', 45),
  ('geo_lon', 'Longitud', 'number', 46),
  ('geo_kalla', 'Geokodningskälla', 'text', 47)
) as v(key, label, field_type, sort_order)
where od.key = 'd2d_fastighet'
on conflict (object_id, key) do nothing;
