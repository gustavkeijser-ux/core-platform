-- d2dSkapaFastighetFranLeverans() (src/lib/data.ts) länkar tillbaka en
-- d2d_fastighet till leveransen (objekttyp "delivery") den skapades från,
-- via addRelation(row.id, "d2d_fast_delivery", leveransId) — så att
-- leveranskartan kan visa vilka leveranser som redan är inplockade i ett
-- projekt (redan_i_projekt i get_leverans_karta_data). Relationstypen
-- saknades i relationship_definitions.
insert into public.relationship_definitions
  (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
select t.id, 'd2d_fast_delivery', 'd2d_fastighet', 'delivery', 'many_to_one', 'Leverans', 'D2D-fastighet', false
from public.tenants t
on conflict (tenant_id, rel_type) do nothing;
