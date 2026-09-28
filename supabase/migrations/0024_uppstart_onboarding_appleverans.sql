-- Tre nya objekttyper för menyerna Säljprocess / Leveransprocess:
--   uppstartsmote  (Uppstartsmöten)  — kopplas till affär/leverans/kund
--   onboarding     (Onboarding)      — kopplas till affär/leverans/kund
--   appleverans    (Appleverans)     — leverans av boendeappen
-- Grundfält (namn, datum, ansvarig, kommentar) + statusar. Fler fält
-- läggs till av admin via "Anpassa fält". Behörigheter kopieras per roll
-- från affärer (uppstartsmöten) resp. leveranser (onboarding, appleverans).

do $$
declare
  t record;
  o record;
  v_id uuid;
begin
  for t in select id from tenants loop
    for o in
      select * from (values
        ('uppstartsmote', 'Uppstartsmöte', 'Uppstartsmöten', 'calendar', 41, 'deal',
           'Mötesdatum', '[["planerat","Planerat","blue",true,false,10],["genomfort","Genomfört","green",false,true,20],["installt","Inställt","slate",false,true,30]]'),
        ('onboarding', 'Onboarding', 'Onboarding', 'rocket', 58, 'delivery',
           'Startdatum', '[["ej_startad","Ej startad","slate",true,false,10],["pagaende","Pågående","blue",false,false,20],["klar","Klar","green",false,true,30]]'),
        ('appleverans', 'Appleverans', 'Appleverans', 'smartphone', 61, 'delivery',
           'Leveransdatum', '[["ej_startad","Ej startad","slate",true,false,10],["pagaende","Pågående","blue",false,false,20],["levererad","Levererad","green",false,true,30]]')
      ) as x(key, sing, plur, icon, sort, perm_from, datum_label, statuses)
    loop
      if exists (select 1 from object_definitions where tenant_id = t.id and key = o.key) then
        continue;
      end if;

      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, o.key, o.sing, o.plur, o.icon, 'name', o.sort, true)
      returning id into v_id;

      insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order) values
        (v_id, t.id, 'name',      'Namn',       'text',      true,  '{"section":"grunduppgifter","_column":false}', 10),
        (v_id, t.id, 'datum',     o.datum_label,'date',      false, '{"section":"grunduppgifter","_column":true,"_column_order":0}', 20),
        (v_id, t.id, 'ansvarig',  'Ansvarig',   'user',      false, '{"section":"grunduppgifter","_column":true,"_column_order":1}', 30),
        (v_id, t.id, 'kommentar', 'Kommentar',  'long_text', false, '{"section":"ovrigt","_column":true,"_column_order":2}', 40);

      insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
      select v_id, t.id, s->>0, s->>1, s->>2, (s->>3)::boolean, (s->>4)::boolean, (s->>5)::int
        from jsonb_array_elements(o.statuses::jsonb) s;

      insert into role_permissions (role_id, tenant_id, object_type, action, scope)
      select rp.role_id, rp.tenant_id, o.key, rp.action, rp.scope
        from role_permissions rp
       where rp.tenant_id = t.id and rp.object_type = o.perm_from
      on conflict do nothing;
    end loop;

    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
    select t.id, r.rel_type, r.f, r.tobj, 'many_to_one', r.lf, r.lr, false
      from (values
        ('uppstart_deal',        'uppstartsmote', 'deal',         'Affär',       'Uppstartsmöten'),
        ('uppstart_delivery',    'uppstartsmote', 'delivery',     'Leverans',    'Uppstartsmöten'),
        ('uppstart_koncern',     'uppstartsmote', 'koncernmoder', 'Kund',        'Uppstartsmöten'),
        ('onboarding_deal',      'onboarding',    'deal',         'Affär',       'Onboarding'),
        ('onboarding_delivery',  'onboarding',    'delivery',     'Leverans',    'Onboarding'),
        ('onboarding_koncern',   'onboarding',    'koncernmoder', 'Kund',        'Onboarding'),
        ('appleverans_delivery', 'appleverans',   'delivery',     'Leverans',    'Appleverans'),
        ('appleverans_property', 'appleverans',   'property',     'Fastighet',   'Appleverans'),
        ('appleverans_koncern',  'appleverans',   'koncernmoder', 'Kund',        'Appleverans')
      ) as r(rel_type, f, tobj, lf, lr)
     where not exists (select 1 from relationship_definitions d where d.tenant_id = t.id and d.rel_type = r.rel_type);
  end loop;
end $$;
