-- Ja/Nej per kategori i "Vad såldes?" (D2D). Sparas som
-- { "salt_bredband": true, "salt_wifi": false, ... } — dolt fält, D2D-vyn
-- ritar sin egen Ja/Nej-växel. Nej rensar kategorins val.

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
select od.id, od.tenant_id, 'salt_svar', 'Sålda kategorier (ja/nej)', 'json', false, '{"section":"salt"}'::jsonb, 499, 'hidden'
  from object_definitions od
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'salt_svar');
