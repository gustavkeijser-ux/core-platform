-- D2D säljarvyn: "Vad är bundet" per tjänst, statusen Inte säljbar och
-- fält som inte längre visas för säljarna.
--  * bunden_per_tjanst (json): { "mobil": {"till":"2027-03","operator":"telia"}, ... }
--    Bindningsmånad och operatör anges per tjänst. De gamla fälten
--    bunden_till (tidigaste månaden), bunden_tjanst (valda tjänster) och
--    bunden_operator (operatören på den tjänst som löper ut först) härleds
--    i säljarvyn så Utfall fungerar som förut.
--  * bunden_operator får operatörerna Fello, Vimla, Halebop, Ownit och Sappa.
--  * Ny status inte_saljbar (räknas som Inte intresserad i Utfall:
--    svarade = alla statusar utom Inte hemma).
--  * "Bindningstid" visas inte längre som anledning till Inte intresserad
--    (valet ligger kvar i fältdefinitionen så äldre poster fortsatt validerar).
--  * personnummer, har_telia_bredband, telia_status, telia_objektnummer och
--    aterkoppling_datum döljs i säljarvyns formulär (seller_hidden);
--    personnummer visas bara under Kunduppgifter vid Signera med Scrive och
--    återkopplingsdatum bara vid status Återkoppling (eget UI).

do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'd2d_lagenhet';
    if v_obj is null then continue; end if;

    -- Nytt fält
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
    select v_obj, t.id, 'bunden_per_tjanst', 'Bindning per tjänst', 'json', false,
           '{"section":"knackning","d2d_eget_ui":true,"help":"Per tjänst: månad då bindningen löper ut och operatör"}'::jsonb,
           'hidden', 60
     where not exists (select 1 from field_definitions x where x.object_id = v_obj and x.key = 'bunden_per_tjanst');

    -- Fler operatörer
    update field_definitions
       set options = jsonb_set(options, '{choices}', (
             select jsonb_agg(c) from (
               select c from jsonb_array_elements(options->'choices') c
               where c->>'key' <> 'annan'
               union all
               select * from jsonb_array_elements('[
                 {"key":"fello","label":"Fello"},{"key":"vimla","label":"Vimla"},{"key":"halebop","label":"Halebop"},
                 {"key":"ownit","label":"Ownit"},{"key":"sappa","label":"Sappa"},{"key":"annan","label":"Annan"}]'::jsonb) n
               where not exists (select 1 from jsonb_array_elements(options->'choices') c2 where c2->>'key' = n->>'key' and n->>'key' <> 'annan')
             ) x))
     where object_id = v_obj and key = 'bunden_operator'
       and not (options->'choices' @> '[{"key":"fello"}]'::jsonb);

    -- Dolda i säljarvyn
    update field_definitions
       set options = options || '{"seller_hidden":true}'::jsonb
     where object_id = v_obj
       and key in ('personnummer', 'har_telia_bredband', 'telia_status', 'telia_objektnummer', 'aterkoppling_datum', 'ej_intresserad_bindningstid')
       and coalesce((options->>'seller_hidden')::boolean, false) = false;

    -- Ny status
    insert into status_definitions (object_id, tenant_id, key, label, color, sort_order)
    select v_obj, t.id, 'inte_saljbar', 'Inte säljbar', 'zinc', 42
     where not exists (select 1 from status_definitions x where x.object_id = v_obj and x.key = 'inte_saljbar');
  end loop;
end $$;

-- Excel-importen i projektbyggaren känner igen statusen "Inte säljbar".
do $$
declare src text;
begin
  src := pg_get_functiondef('public.d2d_import_addresses'::regproc);
  if src like '%''inte säljbar'' then ''inte_saljbar''%' then return; end if;
  if src not like '%when ''inte intresserad'' then ''inte_intresserad''%' then raise exception 'd2d_import_addresses: hittar inte statusmappningen'; end if;
  execute replace(src, 'when ''inte intresserad'' then ''inte_intresserad''',
                       'when ''inte intresserad'' then ''inte_intresserad'' when ''inte säljbar'' then ''inte_saljbar''');
end $$;
