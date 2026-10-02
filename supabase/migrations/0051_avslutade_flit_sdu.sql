-- =====================================================================
--  0051 — Bladen "Avslutade" och "FLIT-SDU" i Projektplan CE.xlsx
--
--  1. Avslutade: raderna läses in som leveranser med status
--     "99. Avslutad". Bladet har nästan samma rubriker som Projektplan,
--     de som skiljer läggs till som alias i fältkartan.
--  2. FLIT-SDU: ny objekttyp under Leveransprocess med egna fält och
--     Telias statusar. Raderna saknar ofta fastighetsbeteckning och
--     matchas därför på GA1-nr (annars TeliaNow CS, A-/KO-nr eller
--     fastighetsbeteckning + ort).
-- =====================================================================

-- ── 1. Avslutade ─────────────────────────────────────────────────────

create or replace function public.projektplan_statuskarta()
returns jsonb language sql immutable as $$
  select '{
    "1. Nyinkomna projekt":"nyinkomna",
    "2. Inväntar Uppstartsmöte":"bestallt_uppstartsmote",
    "2.5 Fått in Uppstartsmöte":"invantar_ok_ce",
    "3. Inväntar OK ConnectEstate":"invantar_ok_ce",
    "4. Beställt GA1":"bestallt_ga1",
    "5. Inväntar Fiber FBL":"prel_byggorder",
    "6. Inväntar Fiber leverans":"prel_byggorder",
    "7. Inväntar Kundklar":"prel_byggorder",
    "7.5 Bygg Extrauttag efter lev":"prel_byggorder",
    "8. Levererad":"leveransbekraftelse",
    "9. Vilande":"vilande",
    "99. Avslutade":"avslutad",
    "99. Avslutad":"avslutad"
  }'::jsonb
$$;

-- Rubriker som heter något annat i bladet Avslutade.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.projektplan_faltkarta()'::regprocedure);
  if position('Prel/Leveransdatum' in d) > 0 then return; end if;
  if position('"Kundklar":"kundklar",' in d) = 0 then
    raise exception 'projektplan_faltkarta: hittar inte insättningspunkten';
  end if;
  d := replace(d, '"Kundklar":"kundklar",',
    '"Kundklar":"kundklar",' || chr(10) ||
    '    "Prel/Leveransdatum":"kundklar",' || chr(10) ||
    '    "WBS-nummer:":"wbs_nr",' || chr(10) ||
    '    "GA1-nr :":"ga1_nr",' || chr(10) ||
    '    "KTV Avtal":"ktv_avtal",');
  execute d;
end $mig$;

-- Rader från bladet Avslutade: status sätts alltid till avslutad, oavsett
-- vad som står (eller inte står) i statuskolumnen.
create or replace function public.ingest_projektplan_avslutade(p_rows jsonb, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.ingest_projektplan(
    coalesce((select jsonb_agg(r || jsonb_build_object('Status:', '99. Avslutade'))
                from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r), '[]'::jsonb),
    p_dry_run);
end $$;
revoke all on function public.ingest_projektplan_avslutade(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.ingest_projektplan_avslutade(jsonb, boolean) to service_role;

create or replace function public.import_projektplan_avslutade(p_rows jsonb, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Åtkomst nekad — admin krävs för import.' using errcode = '42501';
  end if;
  return public.ingest_projektplan_avslutade(p_rows, p_dry_run);
end $$;
revoke all on function public.import_projektplan_avslutade(jsonb, boolean) from public, anon;
grant execute on function public.import_projektplan_avslutade(jsonb, boolean) to authenticated, service_role;

-- ── 2. FLIT-SDU ──────────────────────────────────────────────────────

do $$
declare t record; v_id uuid; v_sort int;
begin
  for t in select id from tenants loop
    if exists (select 1 from object_definitions where tenant_id = t.id and key = 'flit_sdu') then continue; end if;
    select coalesce(max(sort_order), 60) + 1 into v_sort
      from object_definitions where tenant_id = t.id and key = 'delivery';

    insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
    values (t.id, 'flit_sdu', 'FLIT-SDU', 'FLIT-SDU', 'truck', 'name', v_sort, true)
    returning id into v_id;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select v_id, t.id, f.key, f.label, f.typ, f.key = 'name', f.opt::jsonb, f.sort
      from (values
        ('name',                  'Namn',                      'text',      '{"section":"kund","_column":false}', 90),
        ('fastighetsagare',       'Fastighetsägare',           'text',      '{"section":"kund","_column":true,"_column_order":0}', 100),
        ('bolagsnamn',            'Bolagsnamn',                'text',      '{"section":"kund","_column":true,"_column_order":1}', 110),
        ('orgnr',                 'Orgnr',                     'text',      '{"section":"kund","_column":false}', 120),
        ('fastighetsbeteckning',  'Fastighetsbeteckning',      'text',      '{"section":"fastighet","_column":true,"_column_order":2}', 200),
        ('adress',                'Adress',                    'text',      '{"section":"fastighet","_column":true,"_column_order":3}', 210),
        ('ort',                   'Ort',                       'text',      '{"section":"fastighet","_column":true,"_column_order":4}', 220),
        ('portar',                'Portar',                    'number',    '{"section":"omfattning","_column":true,"_column_order":5}', 300),
        ('lagenheter',            'Lägenheter',                'number',    '{"section":"omfattning","_column":true,"_column_order":6}', 310),
        ('lokaler',               'Lokaler',                   'number',    '{"section":"omfattning","_column":false}', 320),
        ('fs_portar',             'FS-portar',                 'number',    '{"section":"omfattning","_column":false}', 330),
        ('sc_portar',             'SC-portar',                 'number',    '{"section":"omfattning","_column":false}', 340),
        ('projektplan_status',    'Status i projektplan',      'text',      '{"section":"tidplan","_column":true,"_column_order":7}', 400),
        ('due_date_byggjobb',     'Due date mot byggjobb',     'date',      '{"section":"tidplan","_column":true,"_column_order":8}', 410),
        ('klardatum_fiber',       'Klardatum fiber',           'date',      '{"section":"tidplan","_column":true,"_column_order":9}', 420),
        ('nuvarande_levdatum',    'Nuvarande leveransdatum',   'date',      '{"section":"tidplan","_column":true,"_column_order":10}', 430),
        ('ursprungligt_levdatum', 'Ursprungligt leveransdatum','date',      '{"section":"tidplan","_column":true,"_column_order":11}', 440),
        ('leveransmanad',         'Leveransmånad',             'date',      '{"section":"tidplan","_column":true,"_column_order":12}', 450),
        ('fbl',                   'FBL',                       'date',      '{"section":"tidplan","_column":false}', 460),
        ('kommentar_fiber',       'Kommentar fiber',           'long_text', '{"section":"uppfoljning","_column":true,"_column_order":13}', 500),
        ('kommentar_ga1',         'Kommentar GA1',             'long_text', '{"section":"uppfoljning","_column":true,"_column_order":14}', 510),
        ('ga1_nr',                'GA1-nr',                    'text',      '{"section":"identifierare","_column":true,"_column_order":15}', 600),
        ('telianow_cs',           'TeliaNow (CS)',             'text',      '{"section":"identifierare","_column":true,"_column_order":16}', 610),
        ('a_ko_nr',               'A-/KO-nr',                  'text',      '{"section":"identifierare","_column":true,"_column_order":17}', 620),
        ('wbs_nr',                'WBS-nr',                    'text',      '{"section":"identifierare","_column":false}', 630),
        ('byggaorder',            'Byggaorder',                'text',      '{"section":"identifierare","_column":false}', 640),
        ('fb_nr_skanova',         'FB-nr Skanova',             'text',      '{"section":"identifierare","_column":false}', 650),
        ('fb_nr_telia',           'FB-nr Telia',               'text',      '{"section":"identifierare","_column":false}', 660),
        ('fb_nr_bygga',           'FB-nr Bygga',               'text',      '{"section":"identifierare","_column":false}', 670),
        ('tof_xlan',              'TÖF/XLAN',                  'text',      '{"section":"teknik","_column":false}', 700),
        ('strom',                 'Ström',                     'text',      '{"section":"teknik","_column":false}', 710),
        ('kollektivt',            'Kollektivt',                'text',      '{"section":"teknik","_column":false}', 720),
        ('fastighetsnat',         'Fastighetsnät',             'text',      '{"section":"teknik","_column":false}', 730),
        ('bygga_f_nat',           'Bygga F-nät',               'text',      '{"section":"teknik","_column":false}', 740),
        ('bygga_extrauttag',      'Bygga extrauttag',          'text',      '{"section":"teknik","_column":false}', 750),
        ('migrering_omf',         'Migrering/omförhandling',   'text',      '{"section":"befintligt","_column":true,"_column_order":18}', 800),
        ('responsible_lpl',       'Ansvarig LPL',              'text',      '{"section":"resurser","_column":true,"_column_order":19}', 900),
        ('flit_nyckel',           'Matchningsnyckel',          'text',      '{"section":"identifierare","_column":false}', 990)
      ) as f(key, label, typ, opt, sort);

    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    select v_id, t.id, s.key, s.label, s.color, s.key = 'nyinkomna', s.term, s.sort
      from (values
        ('nyinkomna',              '1. Nyinkomna projekt',        '#6C8CFF', false, 10),
        ('invantar_uppstartsmote', '2. Inväntar uppstartsmöte',   '#E5A83E', false, 20),
        ('invantar_ok_ce',         '3. Inväntar OK ConnectEstate','#E5A83E', false, 30),
        ('bestallt_ga1',           '4. Beställt GA1',             '#E5A83E', false, 40),
        ('invantar_fbl',           '5. Inväntar fiber FBL',       '#4A9FE0', false, 50),
        ('invantar_fiber',         '6. Inväntar fiberleverans',   '#4A9FE0', false, 60),
        ('invantar_byggjobb',      '7. Inväntar byggjobb',        '#4A9FE0', false, 70),
        ('levererad',              '8. Levererad',                '#5CC98A', true,  80),
        ('vilande',                '9. Vilande',                  '#8FA1AB', false, 90),
        ('avslutad',               '99. Avslutad',                '#5CC98A', true,  99)
      ) as s(key, label, color, term, sort);

    insert into role_permissions (role_id, tenant_id, object_type, action, scope)
    select rp.role_id, rp.tenant_id, 'flit_sdu', rp.action, rp.scope
      from role_permissions rp
     where rp.tenant_id = t.id and rp.object_type = 'delivery'
    on conflict do nothing;
  end loop;
end $$;

create or replace function public.flit_sdu_faltkarta()
returns jsonb language sql immutable as $$
  select '{
    "Fastighetsägare":"fastighetsagare",
    "Bolagsnamn":"bolagsnamn",
    "Orgnr:":"orgnr",
    "Fastighetsbeteckning":"fastighetsbeteckning",
    "Ort:":"ort",
    "Adress:":"adress",
    "Status:":"projektplan_status",
    "TÖF/XLAN:":"tof_xlan",
    "Kollektivt:":"kollektivt",
    "Fastighetsnät:":"fastighetsnat",
    "Bygga F-nät:":"bygga_f_nat",
    "Bygga Extrauttag:":"bygga_extrauttag",
    "Due Date mot Byggjobb":"due_date_byggjobb",
    "Klardatum Fiber":"klardatum_fiber",
    "Nuvarande leveransdatum":"nuvarande_levdatum",
    "Ursprungligt leveransdatum":"ursprungligt_levdatum",
    "Leveransmånad":"leveransmanad",
    "Kommentar fiber":"kommentar_fiber",
    "Kommentar GA1":"kommentar_ga1",
    "Ström:":"strom",
    "WBS-nummer:":"wbs_nr",
    "WBS-nr:":"wbs_nr",
    "TeliaNow (CS):":"telianow_cs",
    "GA1-nr :":"ga1_nr",
    "GA1-nr:":"ga1_nr",
    "A-/KO-nr:":"a_ko_nr",
    "Byggaorder":"byggaorder",
    "Portar:":"portar",
    "Lägenheter:":"lagenheter",
    "Lokaler:":"lokaler",
    "FS-portar:":"fs_portar",
    "SC-portar:":"sc_portar",
    "FB-nr – Skanova:":"fb_nr_skanova",
    "FB-nr – Telia:":"fb_nr_telia",
    "FB-nr – Bygga:":"fb_nr_bygga",
    "Migrering/Omf":"migrering_omf",
    "Ansvarig LPL":"responsible_lpl",
    "FBL":"fbl"
  }'::jsonb
$$;

-- Telias statusnummer → status för FLIT-SDU.
create or replace function public.flit_sdu_status(p_text text)
returns text language sql immutable as $$
  select ('{"1":"nyinkomna","2":"invantar_uppstartsmote","2.5":"invantar_ok_ce","3":"invantar_ok_ce",
            "4":"bestallt_ga1","5":"invantar_fbl","6":"invantar_fiber","7":"invantar_byggjobb",
            "7.5":"invantar_byggjobb","8":"levererad","9":"vilande","99":"avslutad"}'::jsonb)
         ->> substring(coalesce(p_text, '') from '^\s*(\d+(?:\.\d+)?)')
$$;

create or replace function public.ingest_flit_sdu(p_rows jsonb, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_karta jsonb := flit_sdu_faltkarta(); v_typer jsonb;
  v_rad jsonb; v_data jsonb; v_par record; v_rent jsonb;
  v_nyckel text; v_id uuid; v_fore jsonb; v_forestatus text; v_status text;
  v_ny int := 0; v_upp int := 0; v_hopp int := 0; v_slangt int := 0; v_statusbyten int := 0;
begin
  select id into v_tenant from public.tenants limit 1;
  select jsonb_object_agg(fd.key, fd.field_type) into v_typer
    from field_definitions fd join object_definitions od on od.id = fd.object_id
   where od.key = 'flit_sdu' and od.tenant_id = v_tenant;

  for v_rad in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_data := '{}'::jsonb;
    for v_par in select key as rubrik, value as falt from jsonb_each_text(v_karta)
    loop
      if v_rad ? v_par.rubrik then
        v_rent := rensa_varde(v_rad->>v_par.rubrik, coalesce(v_typer->>v_par.falt, 'text'));
        if v_rent is null then
          if btrim(coalesce(v_rad->>v_par.rubrik, '')) <> '' then v_slangt := v_slangt + 1; end if;
        elsif not v_data ? v_par.falt then
          v_data := v_data || jsonb_build_object(v_par.falt, v_rent);
        end if;
      end if;
    end loop;

    v_nyckel := upper(coalesce(
      'GA1:' || nullif(btrim(v_data->>'ga1_nr'), ''),
      'CS:'  || nullif(btrim(v_data->>'telianow_cs'), ''),
      'KO:'  || nullif(btrim(v_data->>'a_ko_nr'), ''),
      'FB:'  || nullif(btrim(v_data->>'fastighetsbeteckning'), '') || '|' || coalesce(btrim(v_data->>'ort'), '')));
    if v_nyckel is null then v_hopp := v_hopp + 1; continue; end if;

    v_data := v_data || jsonb_build_object('flit_nyckel', v_nyckel, 'name',
      concat_ws(' – ',
        coalesce(nullif(v_data->>'fastighetsbeteckning', ''), nullif(v_data->>'adress', ''),
                 nullif(v_data->>'fastighetsagare', ''), v_data->>'ga1_nr'),
        nullif(v_data->>'ort', '')));
    v_status := flit_sdu_status(v_data->>'projektplan_status');

    v_id := null;
    select r.id, r.data, r.status into v_id, v_fore, v_forestatus
      from records r
     where r.tenant_id = v_tenant and r.object_type = 'flit_sdu' and r.deleted_at is null
       and r.data->>'flit_nyckel' = v_nyckel
     limit 1;

    if v_id is null then
      if not p_dry_run then
        insert into records (tenant_id, object_type, data, status)
        values (v_tenant, 'flit_sdu', v_data, coalesce(v_status, 'nyinkomna'));
      end if;
      v_ny := v_ny + 1;
    elsif v_fore || v_data is distinct from v_fore
          or (v_status is not null and v_status is distinct from v_forestatus) then
      if not p_dry_run then
        update records set data = data || v_data, status = coalesce(v_status, status), updated_at = now()
         where id = v_id;
      end if;
      v_upp := v_upp + 1;
      if v_status is not null and v_status is distinct from v_forestatus then v_statusbyten := v_statusbyten + 1; end if;
    end if;
  end loop;

  return jsonb_build_object('nya', v_ny, 'uppdaterade', v_upp, 'hoppade', v_hopp,
    'slangda_varden', v_slangt, 'statusbyten', v_statusbyten, 'kopplade_kunder', 0,
    'torrkorning', p_dry_run);
end $$;
revoke all on function public.ingest_flit_sdu(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.ingest_flit_sdu(jsonb, boolean) to service_role;

create or replace function public.import_flit_sdu(p_rows jsonb, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Åtkomst nekad — admin krävs för import.' using errcode = '42501';
  end if;
  return public.ingest_flit_sdu(p_rows, p_dry_run);
end $$;
revoke all on function public.import_flit_sdu(jsonb, boolean) from public, anon;
grant execute on function public.import_flit_sdu(jsonb, boolean) to authenticated, service_role;

-- Kända rubriker per blad (för "kolumner som inte känns igen" i Import).
create or replace function public.projektplan_kanda_rubriker()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'falt', (select jsonb_agg(k order by k) from jsonb_object_keys(projektplan_faltkarta()) k),
    'statusar', (select jsonb_agg(k order by k) from jsonb_object_keys(projektplan_statuskarta()) k),
    'flit', (select jsonb_agg(k order by k) from jsonb_object_keys(flit_sdu_faltkarta()) k)
  )
$$;
