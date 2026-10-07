-- =====================================================================
--  D2D/Scrive: fältet "Övrigt (står i avtalet)" som säljaren fyller i
--  under Kunduppgifter vid "Signera med Scrive". Texten skrivs i mallens
--  textfält "Övrigt". Dolt för säljaren i övriga formulär (seller_hidden).
--  Ny Scrive-mall (7 okt 2026) med klartextnamn på fälten.
--  OBS: körs som do-block — en ensam UPDATE via MCP-verktyget kan hänga.
-- =====================================================================
do $$ begin
  update scrive_installningar set mall_id = '9222115557591481195';
  insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
  select od.id, od.tenant_id, 'scrive_ovrigt', 'Övrigt (står i avtalet)', 'long_text', false,
         '{"section":"forsaljning","seller_hidden":true,"help":"Skrivs i fältet Övrigt i Scrive-avtalet"}'::jsonb, 'all', 315
    from object_definitions od
   where od.key = 'd2d_lagenhet'
     and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'scrive_ovrigt');
end $$;
