-- =====================================================================
--  D2D: nya sportpaket under "Sportpaket" i "Vad såldes?" / "Vad ska
--  kunden signera?": TV4 Play Sport Hockey, TV4 Play Sport Total och
--  All Sport från Viaplay. Priser och pinnar sätts under Inställningar →
--  Priser. Valet "utan Netflix" gäller bara Telias egna sportpaket.
-- =====================================================================
update field_definitions f
   set options = jsonb_set(f.options, '{choices}', (f.options->'choices') || (
     select coalesce(jsonb_agg(c), '[]'::jsonb)
       from jsonb_array_elements('[{"key":"tv4_sport_hockey","label":"TV4 Play Sport Hockey"},{"key":"tv4_sport_total","label":"TV4 Play Sport Total"},{"key":"viaplay_all_sport","label":"All Sport från Viaplay"}]'::jsonb) c
      where not exists (select 1 from jsonb_array_elements(f.options->'choices') x where x->>'key' = c->>'key')))
  from object_definitions od
 where od.id = f.object_id and od.key = 'd2d_lagenhet' and f.key = 'salt_streaming_sport';
