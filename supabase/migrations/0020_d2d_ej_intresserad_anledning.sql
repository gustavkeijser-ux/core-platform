-- =============================================================================
-- 0020 — D2D: anledning vid "Inte intresserad"
-- =============================================================================
-- Säljaren ska ange en anledning när en lägenhet markeras "Inte intresserad",
-- så att statistiken går att bryta ner senare (för gammal, bindningstid,
-- flyttar, saknar behov, dålig ekonomi, vill inte ha fiber). Väljer säljaren
-- "Bindningstid" kan hen även ange datumet den löper ut — fritext eftersom
-- det ofta bara är känt som år, eller år och månad (inte hela ÅÅÅÅ-MM-DD),
-- vilket ett vanligt <input type="date"> inte tillåter.
-- =============================================================================

insert into public.field_definitions
  (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, visibility, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.field_type, false, false, v.options::jsonb, v.help_text, 'all', v.sort_order
from public.object_definitions od
cross join (values
  (
    'ej_intresserad_anledning',
    'Anledning (inte intresserad)',
    'select',
    '{"section":"knackning","choices":[
        {"key":"for_gammal",          "label":"För gammal"},
        {"key":"bindningstid",        "label":"Bindningstid"},
        {"key":"flyttar",             "label":"Flyttar"},
        {"key":"saknar_behov",        "label":"Saknar behov"},
        {"key":"dalig_ekonomi",       "label":"Dålig ekonomi"},
        {"key":"vill_inte_ha_fiber",  "label":"Vill inte ha fiber"}
      ]}',
    null,
    55
  ),
  (
    'ej_intresserad_bindningstid',
    'Bindningstid löper ut',
    'text',
    '{"section":"knackning"}',
    'Fritt format — år (ÅÅÅÅ), år och månad (ÅÅÅÅ-MM) eller helt datum (ÅÅÅÅ-MM-DD).',
    56
  )
) as v(key, label, field_type, options, help_text, sort_order)
where od.key = 'd2d_lagenhet'
on conflict (object_id, key) do update set
  label      = excluded.label,
  field_type = excluded.field_type,
  options    = excluded.options,
  help_text  = excluded.help_text,
  sort_order = excluded.sort_order;
