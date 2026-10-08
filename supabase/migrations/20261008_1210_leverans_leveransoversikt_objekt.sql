-- [Leverans] Objektet "Leveransöversikt": en post per Kund (koncernmoder) med
-- säljuppgifter, kontakter och leveranschecklistan (från arket "Lista signering").
-- Kopplas till Kund via relationen levov_kund. Behörigheter kopieras från delivery.
-- Visas inte som egen lista i menyn (Sidebar OWN_VIEW) — korten i Leveransöversikten
-- läser posten och "Redigera" öppnar den i postvyn. Idempotent.
do $$
declare
  t record; v_id uuid;
begin
  for t in select id from tenants loop
    select id into v_id from object_definitions where tenant_id = t.id and key = 'leveransoversikt';
    if v_id is null then
      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, 'leveransoversikt', 'Leveransöversikt', 'Leveransöversikter', 'truck', 'name', 61, true)
      returning id into v_id;
    end if;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select v_id, t.id, f.key, f.label, f.typ, f.key = 'name', f.opt::jsonb, f.sort
      from (values
        ('name',              'Kund / avtalspart',                 'text',      '{"section":"grunduppgifter"}', 10),
        ('avtalsparter',      'Bolagsnamn (avtalsparter)',         'long_text', '{"section":"grunduppgifter"}', 20),
        ('saljare',           'Säljare',                           'text',      '{"section":"grunduppgifter"}', 30),
        ('ce_ansvarig',       'CE-ansvarig',                       'text',      '{"section":"grunduppgifter"}', 40),
        ('produkt',           'Produkt',                           'text',      '{"section":"grunduppgifter"}', 50),
        ('sald',              'Såld',                              'date',      '{"section":"grunduppgifter"}', 60),
        ('nya_portar',        'Nya portar',                        'number',    '{"section":"grunduppgifter"}', 70),
        ('bef_telia',         'Bef Telia',                         'number',    '{"section":"grunduppgifter"}', 80),
        ('driftsatt',         'Driftsatt',                         'text',      '{"section":"grunduppgifter"}', 90),
        ('kommentar',         'Kommentar',                         'long_text', '{"section":"grunduppgifter"}', 100),
        ('agare_namn',        'Ägare/primär kontakt – namn',       'text',      '{"section":"kontaktinfo"}', 200),
        ('agare_epost',       'Ägare/primär kontakt – e-post',     'email',     '{"section":"kontaktinfo"}', 210),
        ('agare_telefon',     'Ägare/primär kontakt – telefon',    'phone',     '{"section":"kontaktinfo"}', 220),
        ('forvaltare_namn',   'Förvaltare – namn',                 'text',      '{"section":"kontaktinfo"}', 230),
        ('forvaltare_epost',  'Förvaltare – e-post',               'email',     '{"section":"kontaktinfo"}', 240),
        ('forvaltare_telefon','Förvaltare – telefon',              'phone',     '{"section":"kontaktinfo"}', 250),
        ('fler_kontakter',    'Fler kontaktuppgifter att lägga till','boolean', '{"section":"kontaktinfo"}', 260),
        ('uppsagning_bef',    'Uppsägning befintlig leverantör',   'boolean',   '{"section":"Checklista"}', 300),
        ('kontaktade',        'Kontaktade',                        'boolean',   '{"section":"Checklista"}', 310),
        ('projektfil',        'Projektfil',                        'boolean',   '{"section":"Checklista"}', 320),
        ('avi_1',             'Avi 1',                             'boolean',   '{"section":"Checklista"}', 330),
        ('avi_2',             'Avi 2',                             'boolean',   '{"section":"Checklista"}', 340),
        ('avi_3',             'Avi 3',                             'boolean',   '{"section":"Checklista"}', 350),
        ('projekthemsida',    'Projekthemsida',                    'boolean',   '{"section":"Checklista"}', 360),
        ('adresslista',       'Adresslista',                       'boolean',   '{"section":"Checklista"}', 370),
        ('leveransdatum',     'Leveransdatum',                     'boolean',   '{"section":"Checklista"}', 380),
        ('torrinstallation',  'Torrinstallation',                  'boolean',   '{"section":"Checklista"}', 390),
        ('uppsagningar',      'Uppsägningar',                      'boolean',   '{"section":"Checklista"}', 400),
        ('bekraftad_projektplan','Bekräftad projektplan',          'boolean',   '{"section":"Checklista"}', 410),
        ('forvaltningsdokument','Förvaltningsdokument',            'boolean',   '{"section":"Checklista"}', 420),
        ('bommar',            'Bommar',                            'boolean',   '{"section":"Checklista"}', 430),
        ('avlamnad_leverans', 'Avlämnad leverans',                 'boolean',   '{"section":"Checklista"}', 440),
        ('levererad',         'Levererad',                         'boolean',   '{"section":"Checklista"}', 450)
      ) as f(key, label, typ, opt, sort)
     where not exists (select 1 from field_definitions x where x.object_id = v_id and x.key = f.key);

    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    select v_id, t.id, s.key, s.label, s.color, s.ini, s.term, s.sort
      from (values ('pagaende', 'Pågående', '#4A9FE0', true, false, 10),
                   ('avslutad', 'Avslutad', '#5CC98A', false, true, 20)) as s(key, label, color, ini, term, sort)
     where not exists (select 1 from status_definitions x where x.object_id = v_id and x.key = s.key);

    insert into role_permissions (role_id, tenant_id, object_type, action, scope)
    select rp.role_id, rp.tenant_id, 'leveransoversikt', rp.action, rp.scope
      from role_permissions rp
     where rp.tenant_id = t.id and rp.object_type = 'delivery'
    on conflict do nothing;

    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
    select t.id, 'levov_kund', 'leveransoversikt', 'koncernmoder', 'many_to_one', 'Kund', 'Leveransöversikt', false
     where not exists (select 1 from relationship_definitions d where d.tenant_id = t.id and d.rel_type = 'levov_kund');
  end loop;
end $$;
