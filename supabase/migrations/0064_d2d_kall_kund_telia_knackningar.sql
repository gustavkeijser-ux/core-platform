-- =====================================================================
--  0064 — D2D-statusar och fält:
--   • "Övrigt" tas bort och ersätts av "Kall kund". Lägenheter som låg
--     på Övrigt flyttas till Kall kund.
--   • Ny status "Befintlig Telia-kund".
--   • antal_knackningar: hur många gånger dörren knackats (fylls i när
--     statusen är Inte hemma).
--   • tid_pa_adress: hur länge säljaren var inne på adressen i D2D-vyn
--     innan statusen ändrades (minuter). Syns bara för administratörer
--     (visibility 'restricted' — get_metadata skickar inte fältet till
--     andra), och visas som kolumn under Door to door → Lägenheter.
-- =====================================================================

-- Övrigt → Kall kund (samma rad i status_definitions, ny nyckel).
update status_definitions sd
   set key = 'kall_kund', label = 'Kall kund', color = 'zinc'
  from object_definitions od
 where od.id = sd.object_id and od.key = 'd2d_lagenhet' and sd.key = 'ovrigt'
   and not exists (select 1 from status_definitions x where x.object_id = sd.object_id and x.key = 'kall_kund');

update records set status = 'kall_kund'
 where object_type = 'd2d_lagenhet' and status = 'ovrigt';

-- Befintlig Telia-kund
insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
select od.id, od.tenant_id, 'befintlig_telia', 'Befintlig Telia-kund', 'sky', false, false, 45
  from object_definitions od
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from status_definitions x where x.object_id = od.id and x.key = 'befintlig_telia');

-- Fält
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
select od.id, od.tenant_id, v.key, v.label, 'number', false, v.opts, v.vis, v.so
  from object_definitions od,
       (values
         ('antal_knackningar', 'Antal knackningar',
          '{"section":"knackning","d2d_eget_ui":true,"help":"Hur många gånger dörren har knackats utan att någon öppnat"}'::jsonb, 'all', 56),
         ('tid_pa_adress', 'Tid på adressen (min)',
          '{"section":"knackning","d2d_eget_ui":true,"_column":true,"_column_order":10,"help":"Tid från att säljaren öppnade adressen i D2D-vyn tills statusen ändrades"}'::jsonb, 'restricted', 98)
       ) v(key, label, opts, vis, so)
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- Fält med visibility 'restricted' skickas bara till administratörer.
do $$
declare v text := pg_get_functiondef('public.get_metadata()'::regprocedure);
begin
  if position('fd.visibility <> ''restricted''' in v) > 0 then return; end if;
  if position('from field_definitions fd where fd.object_id = od.id' in v) = 0 then
    raise exception 'get_metadata: hittar inte fältfrågan';
  end if;
  execute replace(v, 'from field_definitions fd where fd.object_id = od.id',
    'from field_definitions fd where fd.object_id = od.id and (fd.visibility <> ''restricted'' or public.is_admin())');
end $$;
