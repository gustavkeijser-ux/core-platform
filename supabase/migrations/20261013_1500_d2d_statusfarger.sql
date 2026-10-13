-- D2D: nya statusfärger för lägenheter (Gustavs val 13 okt 2026).
-- Samma hexkoder som --d2d-st-* i src/styles/d2d.css, så CRM:ets statuspiller
-- (StatusPill/ObjectListPage läser hex direkt) och säljarvyn visar samma färg.
-- Inte säljbar, Intresserad och Ånger behåller sina färgtoner.
update public.status_definitions sd
   set color = v.farg
  from (values
    ('sald',             '#6EC475'),
    ('scrive',           '#B2BEB5'),
    ('aterkoppling',     '#F39A3D'),
    ('befintlig_telia',  '#714693'),
    ('inte_hemma',       '#C4756E'),
    ('kall_kund',        '#756EC4'),
    ('inte_intresserad', '#FF0800'),
    ('ej_knackad',       '#414A4C')
  ) as v(key, farg),
  public.object_definitions od
 where od.id = sd.object_id
   and od.key = 'd2d_lagenhet'
   and sd.key = v.key;
