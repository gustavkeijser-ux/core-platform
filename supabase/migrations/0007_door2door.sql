-- =============================================================================
-- 0007 — Door 2 Door: datamodell
-- =============================================================================
--
-- Tre nya objekttyper:
--   d2d_projekt    — Övergripande projekt (t.ex. "Telia Västerås")
--   d2d_fastighet  — Fastighet med all info säljaren behöver innan knackning
--   d2d_lagenhet   — Lägenhet med knackstatus, kommentar, AI-parsad kunddata
--
-- Hierarki: Projekt → Fastighet → Lägenhet
-- Kunddata lever på lägenheten (AI parsar från säljarens fritext-kommentar).
-- "Signerade kunder" är en filtrerad vy av lägenheter med status = sald.
-- =============================================================================

begin;

do $$
declare
  v_tenant  uuid;
  v_proj_id uuid;
  v_fast_id uuid;
  v_lag_id  uuid;
begin
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception 'Ingen tenant hittades.';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Objekttyper
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.object_definitions
    (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order)
  values
    (v_tenant, 'd2d_projekt',    'D2D-projekt',    'D2D-projekt',     'folder',   'name', 50),
    (v_tenant, 'd2d_fastighet',  'D2D-fastighet',  'D2D-fastigheter', 'building', 'name', 51),
    (v_tenant, 'd2d_lagenhet',   'Lägenhet',       'Lägenheter',      'door',     'name', 52)
  on conflict (tenant_id, key) do update set
    label_singular = excluded.label_singular,
    label_plural   = excluded.label_plural,
    icon           = excluded.icon,
    sort_order     = excluded.sort_order;

  select id into v_proj_id from public.object_definitions
   where tenant_id = v_tenant and key = 'd2d_projekt';
  select id into v_fast_id from public.object_definitions
   where tenant_id = v_tenant and key = 'd2d_fastighet';
  select id into v_lag_id  from public.object_definitions
   where tenant_id = v_tenant and key = 'd2d_lagenhet';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. Fältdefinitioner — D2D Projekt
  -- ═══════════════════════════════════════════════════════════════════════════

  delete from public.field_definitions where object_id = v_proj_id and tenant_id = v_tenant;

  insert into public.field_definitions
    (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, sort_order)
  values
    (v_proj_id, v_tenant, 'name',        'Projektnamn',   'text',      true,  false, '{}', null, 10),
    (v_proj_id, v_tenant, 'description', 'Beskrivning',   'long_text', false, false, '{}', null, 20),
    (v_proj_id, v_tenant, 'start_date',  'Startdatum',    'date',      false, false, '{}', null, 30),
    (v_proj_id, v_tenant, 'end_date',    'Slutdatum',     'date',      false, false, '{}', null, 40),
    (v_proj_id, v_tenant, 'ansvarig',    'Projektansvarig', 'user',    false, false, '{}', null, 50);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. Fältdefinitioner — D2D Fastighet
  -- ═══════════════════════════════════════════════════════════════════════════

  delete from public.field_definitions where object_id = v_fast_id and tenant_id = v_tenant;

  insert into public.field_definitions
    (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, sort_order)
  values
    -- Grundinfo
    (v_fast_id, v_tenant, 'name',                   'Gatuadress',              'text',    true,  false,
     '{"section":"grundinfo"}', null, 10),
    (v_fast_id, v_tenant, 'fastighetsbeteckning',   'Fastighetsbeteckning',    'text',    false, false,
     '{"section":"grundinfo"}', 'T.ex. Västerås X:123', 20),
    (v_fast_id, v_tenant, 'fastighetsagare',        'Fastighetsägare',         'text',    false, false,
     '{"section":"grundinfo"}', null, 30),
    (v_fast_id, v_tenant, 'forvaltare',             'Förvaltare',              'text',    false, false,
     '{"section":"grundinfo"}', null, 40),

    -- Nät & TV
    (v_fast_id, v_tenant, 'befintligt_nat',         'Befintligt nät',          'text',    false, false,
     '{"section":"nat_tv"}', 'T.ex. Tele2 Koax', 100),
    (v_fast_id, v_tenant, 'nuvarande_tv',           'Nuvarande TV-paket',      'text',    false, false,
     '{"section":"nat_tv"}', null, 110),
    (v_fast_id, v_tenant, 'nytt_tv_installation',   'Nytt TV vid installation', 'text',   false, false,
     '{"section":"nat_tv"}', null, 120),
    (v_fast_id, v_tenant, 'nytt_tv_efter_avslut',   'Nytt TV efter avslut',    'text',    false, false,
     '{"section":"nat_tv"}', null, 130),

    -- Installation & tillträde
    (v_fast_id, v_tenant, 'installationsdatum',     'Installationsdatum',      'date',    false, false,
     '{"section":"installation"}', null, 200),
    (v_fast_id, v_tenant, 'portkod',                'Portkod',                 'text',    false, false,
     '{"section":"installation"}', null, 210),
    (v_fast_id, v_tenant, 'tilltradesinstruktion',  'Tillträdesinstruktion',   'long_text', false, false,
     '{"section":"installation"}', 'Övrig info om tillträde', 220),
    (v_fast_id, v_tenant, 'gamla_nat_avslutsdatum', 'Gamla nätets avslutsdatum', 'date', false, false,
     '{"section":"installation"}', null, 230),

    -- Övrigt
    (v_fast_id, v_tenant, 'viktigt_info',           'Viktigt inför knackning', 'long_text', false, false,
     '{"section":"ovrigt"}', 'Visas som varningsruta för säljaren', 300),
    (v_fast_id, v_tenant, 'antal_lagenheter',       'Antal lägenheter',        'number',  false, false,
     '{"section":"ovrigt"}', null, 310);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4. Fältdefinitioner — Lägenhet
  -- ═══════════════════════════════════════════════════════════════════════════

  delete from public.field_definitions where object_id = v_lag_id and tenant_id = v_tenant;

  insert into public.field_definitions
    (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, sort_order)
  values
    -- Knackning
    (v_lag_id, v_tenant, 'name',         'Lägenhetsnummer',   'text',      true,  false,
     '{"section":"knackning"}', 'T.ex. 14A', 10),
    (v_lag_id, v_tenant, 'kommentar',    'Kommentar',         'long_text', false, false,
     '{"section":"knackning"}', 'Säljarens fritext — AI parsar till strukturerade fält.', 20),
    (v_lag_id, v_tenant, 'saljare',      'Säljare',           'user',      false, false,
     '{"section":"knackning"}', null, 30),
    (v_lag_id, v_tenant, 'senast_kontakt', 'Senast kontakt',  'datetime',  false, false,
     '{"section":"knackning"}', null, 40),
    (v_lag_id, v_tenant, 'aterkoppling_datum', 'Återkopplingsdatum', 'date', false, false,
     '{"section":"knackning"}', 'AI-parsas från kommentar vid behov.', 50),

    -- Kunddata (AI-parsad)
    (v_lag_id, v_tenant, 'kund_namn',              'Namn',                  'text',    false, false,
     '{"section":"kunddata"}', null, 100),
    (v_lag_id, v_tenant, 'kund_telefon',           'Telefon',               'phone',   false, false,
     '{"section":"kunddata"}', null, 110),
    (v_lag_id, v_tenant, 'kund_epost',             'E-post',                'email',   false, false,
     '{"section":"kunddata"}', null, 120),
    (v_lag_id, v_tenant, 'bredbandsleverantor',    'Bredbandsleverantör',   'text',    false, false,
     '{"section":"kunddata"}', null, 130),
    (v_lag_id, v_tenant, 'tv_leverantor',          'TV-leverantör',         'text',    false, false,
     '{"section":"kunddata"}', null, 140),
    (v_lag_id, v_tenant, 'bindningstid',           'Bindningstid',          'date',    false, false,
     '{"section":"kunddata"}', null, 150),
    (v_lag_id, v_tenant, 'bredbandsintresse',      'Bredbandsintresse',     'boolean', false, false,
     '{"section":"kunddata"}', null, 160),
    (v_lag_id, v_tenant, 'tv_intresse',            'TV-intresse',           'boolean', false, false,
     '{"section":"kunddata"}', null, 170),

    -- Försäljning
    (v_lag_id, v_tenant, 'sald_datum',     'Såld datum',      'date',      false, false,
     '{"section":"forsaljning"}', null, 200),
    (v_lag_id, v_tenant, 'produkt',        'Produkt',         'text',      false, false,
     '{"section":"forsaljning"}', null, 210),
    (v_lag_id, v_tenant, 'avtalsnummer',   'Avtalsnummer',    'text',      false, false,
     '{"section":"forsaljning"}', null, 220),

    -- AI-originaldata (dold i mobil, synlig i admin)
    (v_lag_id, v_tenant, 'ai_parsed_data', 'AI-parsad data',  'json',     false, false,
     '{"section":"ai"}', 'Strukturerad data extraherad av AI från kommentaren.', 900);

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 5. Statusar
  -- ═══════════════════════════════════════════════════════════════════════════

  -- D2D Projekt
  insert into public.status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
  values
    (v_proj_id, v_tenant, 'planering',  'Planering',  'slate',  true,  false, 10),
    (v_proj_id, v_tenant, 'pagaende',   'Pågående',   'green',  false, false, 20),
    (v_proj_id, v_tenant, 'avslutat',   'Avslutat',   'blue',   false, true,  30)
  on conflict (object_id, key) do update set
    label = excluded.label, color = excluded.color,
    is_initial = excluded.is_initial, is_terminal = excluded.is_terminal,
    sort_order = excluded.sort_order;

  -- D2D Fastighet
  insert into public.status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
  values
    (v_fast_id, v_tenant, 'ej_startad',  'Ej startad',   'slate',  true,  false, 10),
    (v_fast_id, v_tenant, 'pagaende',    'Pågående',     'green',  false, false, 20),
    (v_fast_id, v_tenant, 'klar',        'Klar',         'blue',   false, true,  30)
  on conflict (object_id, key) do update set
    label = excluded.label, color = excluded.color,
    is_initial = excluded.is_initial, is_terminal = excluded.is_terminal,
    sort_order = excluded.sort_order;

  -- Lägenhet (knackstatus)
  insert into public.status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
  values
    (v_lag_id, v_tenant, 'ej_knackad',       'Ej knackad',       'slate',  true,  false, 10),
    (v_lag_id, v_tenant, 'inte_hemma',       'Inte hemma',       'blue',   false, false, 20),
    (v_lag_id, v_tenant, 'aterkoppling',     'Återkoppling',     'amber',  false, false, 30),
    (v_lag_id, v_tenant, 'inte_intresserad', 'Inte intresserad', 'red',    false, false, 40),
    (v_lag_id, v_tenant, 'intresserad',      'Intresserad',      'green',  false, false, 50),
    (v_lag_id, v_tenant, 'sald',             'Såld',             'green',  false, true,  60),
    (v_lag_id, v_tenant, 'ovrigt',           'Övrigt',           'slate',  false, false, 70)
  on conflict (object_id, key) do update set
    label = excluded.label, color = excluded.color,
    is_initial = excluded.is_initial, is_terminal = excluded.is_terminal,
    sort_order = excluded.sort_order;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6. Relationer
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Fastighet → Projekt
  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_fast_projekt', 'd2d_fastighet', 'd2d_projekt',
     'many_to_one', 'Tillhör projekt', 'Fastigheter', true)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

  -- Lägenhet → Fastighet
  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_lag_fastighet', 'd2d_lagenhet', 'd2d_fastighet',
     'many_to_one', 'Tillhör fastighet', 'Lägenheter', true)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

  -- Fastighet → Koncernmoder (valfri koppling till CRM)
  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_fast_koncern', 'd2d_fastighet', 'koncernmoder',
     'many_to_one', 'Koncernmoder', 'D2D-fastigheter', false)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 7. Behörigheter
  -- ═══════════════════════════════════════════════════════════════════════════

  -- Kopiera befintliga roller → D2D-typer
  insert into public.role_permissions (role_id, tenant_id, object_type, action, scope)
  select rp.role_id, rp.tenant_id, new_type.key, rp.action, rp.scope
    from public.role_permissions rp
    cross join (values ('d2d_projekt'), ('d2d_fastighet'), ('d2d_lagenhet')) as new_type(key)
   where rp.tenant_id = v_tenant
     and rp.object_type = 'koncernmoder'
  on conflict (role_id, object_type, action) do update set scope = excluded.scope;

end
$$;

commit;
