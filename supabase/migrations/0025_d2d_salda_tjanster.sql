-- Sålda tjänster i D2D: när säljaren sätter en lägenhet till "Såld" väljer
-- hen vad som sålts, kategori för kategori. Varje kategori är ett eget fält
-- (select = ett val, multi_select = flera) med options.sold_panel = true —
-- D2D-vyn ritar panelen utifrån dessa fält, så kategorier och alternativ
-- kan ändras under "Anpassa fält" i CRM:et utan kodändring.

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.typ, false, v.opts, v.sort
  from object_definitions od
 cross join (values
  ('salt_bredband', 'Bredband', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "bb150", "label": "BB150"}, {"key": "bb300", "label": "BB300"}, {"key": "bb600", "label": "BB600"}, {"key": "bb1000", "label": "BB1000"}]}'::jsonb, 500),
  ('salt_wifi', 'WiFi / Hårdvara', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "asus_zenwifi_bd4", "label": "ASUS ZenWiFi BD4"}, {"key": "asus_zenwifi_bt8", "label": "ASUS ZenWiFi BT8"}]}'::jsonb, 510),
  ('salt_tv', 'TV', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "tv_mini", "label": "TV Mini"}, {"key": "tv_mellan", "label": "TV Mellan"}, {"key": "tv_mycket", "label": "TV Mycket"}]}'::jsonb, 520),
  ('salt_streaming_film', 'Premium Streaming – Film & Serie', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "streaming_mer", "label": "Streaming Mer"}, {"key": "streaming_maxad", "label": "Streaming Maxad"}, {"key": "streaming_mest", "label": "Streaming Mest"}]}'::jsonb, 530),
  ('salt_streaming_sport', 'Premium Streaming – Sport', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "lilla_sportpaketet", "label": "Lilla sportpaketet"}, {"key": "stora_sportpaketet", "label": "Stora sportpaketet"}, {"key": "storsta_sportpaketet", "label": "Största sportpaketet"}]}'::jsonb, 540),
  ('salt_fristaende_sport', 'Fristående sport', 'multi_select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "tv4_play_sport_hockey", "label": "TV4 Play Sport Hockey"}, {"key": "tv4_play_sport_total", "label": "TV4 Play Sport Total"}, {"key": "all_sport_fran_viaplay", "label": "All Sport från Viaplay"}]}'::jsonb, 550),
  ('salt_tv_hardvara', 'TV / Streaminghårdvara', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "sdmc_dv8919x_tv_streamingbox", "label": "SDMC DV8919X TV- & Streamingbox"}]}'::jsonb, 560),
  ('salt_mobil', 'Mobil', 'multi_select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "10_gb", "label": "10 GB"}, {"key": "20_gb", "label": "20 GB"}, {"key": "obegransad", "label": "Obegränsad"}, {"key": "obegransad_plus", "label": "Obegränsad Plus"}, {"key": "obegransad_plus_1_streaming", "label": "Obegränsad Plus + 1 streaming"}, {"key": "obegransad_plus_3_streaming", "label": "Obegränsad Plus + 3 streaming"}, {"key": "extra_anvandare", "label": "Extra användare"}]}'::jsonb, 570),
  ('salt_trygghet', 'Trygghet', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "trygghetspaketet", "label": "Trygghetspaketet"}]}'::jsonb, 580)
 ) as v(key, label, typ, opts, sort)
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);
