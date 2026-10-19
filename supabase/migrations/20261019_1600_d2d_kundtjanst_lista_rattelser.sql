-- Rättelser efter kundtjänstens sälj-lista (20261019_1500), enligt Gustav 19 okt:
--  * Bondegatan 3 A 1102, Mjölby: tjänsterna skrivs över med listans (BB 150, mobil + 1 extra
--    användare, Streaming Mer = 2,8 pinnar) och såld-datum blir listans 2026-09-28.
--  * Nya adresser som saknades i CRM läggs upp och säljs: Byggmästargatan 19 B 1601 Malmö,
--    Kyrkogatan 24 B 1002 Gävle, Vallonvägen 6 A 1002 Åkers Styckebruk (befintlig fastighet
--    De Geer 1) och Brännkyrkagatan 84 1401 Stockholm (listans andra Brännkyrkagatan-rad).
--  * Brännkyrkagatan 86 1401: importradens tillägg om två kontakter tas bort (det andra
--    numret hör till 84 1401). Inga andra kommentarer ändras.
-- Allt delas med kundtjänst enligt samma regel som importen (80/20). Status sätts före
-- kundtjanst-fältet så att inga bekräftelsemejl skickas. Idempotent.
do $$
declare
  v_tenant constant uuid := 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1';
  v_kt constant text := '5556a666-18c4-40be-9da2-0eeda80a8be9';
  v_rad jsonb; v_fid uuid; v_id uuid; v_ts timestamptz; v_r records%rowtype;
begin
  perform set_config('d2d.import', '1', true);

  -- 1. Bondegatan 3 A 1102, Mjölby
  select * into v_r from records where id = '2c7f176d-27c3-428d-8571-1e4a9aaaee99' for update;
  if v_r.data->>'sald_datum' is distinct from '2026-09-28' then
    update records set data = (data - 'mobil_antal') || jsonb_build_object(
        'salt_bredband', 'bb150',
        'salt_mobil', jsonb_build_array('obegransad_plus', 'extra_anvandare'),
        'mobil_extra_antal', 1,
        'salt_streaming_film', 'streaming_mer',
        'salt_tv', null, 'salt_router', null,
        'salt_svar', jsonb_build_object('salt_bredband', true, 'salt_mobil', true, 'salt_streaming_film', true),
        'sald_datum', '2026-09-28',
        'kommentar', concat_ws(E'\n', nullif(btrim(coalesce(data->>'kommentar', '')), ''),
          'Kundtjänst (import, 2026-10-19): såld av kundtjänst 2026-09-28, delad med Jacob – Bredband 150/150, mobilabonnemang + en extra användare, streaming mer (tjänsterna ersatte tidigare registrering)'))
     where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_r.id, 'field_change',
            'Tjänster och såld-datum ersatta enligt kundtjänstens lista (tidigare: ' ||
              concat_ws(', ', v_r.data->>'salt_bredband', v_r.data->>'salt_mobil', v_r.data->>'salt_streaming_film',
                        v_r.data->>'salt_router', 'såld ' || (v_r.data->>'sald_datum')) || ')',
            jsonb_build_object('kalla', 'kundtjanst_lista_2026-10-19',
                               'fore', jsonb_build_object('salt_bredband', v_r.data->'salt_bredband', 'salt_mobil', v_r.data->'salt_mobil',
                                 'salt_tv', v_r.data->'salt_tv', 'salt_router', v_r.data->'salt_router',
                                 'salt_streaming_film', v_r.data->'salt_streaming_film', 'salt_svar', v_r.data->'salt_svar',
                                 'sald_datum', v_r.data->'sald_datum')),
            null, 'system', now());
  end if;

  -- 2. Brännkyrkagatan 86 1401: ta bort importradens tillägg (bara vår egen text).
  update records set data = data || jsonb_build_object('kommentar',
           replace(data->>'kommentar', ' – två kontakter i listan samma dag: 070-889 09 77 och 079-075 08 77', ''))
   where id = '958d34e6-52c3-4c6d-b071-dd36deec0d13'
     and data->>'kommentar' like '%två kontakter i listan samma dag%';

  -- 3. Nya adresser
  for v_rad in select * from jsonb_array_elements('[
    {"gata":"Byggmästargatan","nr":"19","ing":"B","lgh":"1601","ort":"Malmö","pnr":null,"fast":null,"fastnamn":"Byggmästargatan 19, Malmö",
     "saljare":"0663ce9d-5f35-4410-ac32-a2f3bf176b77","namn":"Olle","datum":"2026-10-02","tel":"0738215554",
     "svc":{"salt_bredband":"bb300","salt_svar":{"salt_bredband":true}},"tj":"Bredband 300/300"},
    {"gata":"Kyrkogatan","nr":"24","ing":"B","lgh":"1002","ort":"Gävle","pnr":null,"fast":null,"fastnamn":"Kyrkogatan 24, Gävle",
     "saljare":"393256b0-a7dc-4640-8233-696b07079321","namn":"Jacob","datum":"2026-10-08","tel":"0734304080",
     "svc":{"salt_bredband":"bb300","salt_svar":{"salt_bredband":true}},"tj":"Bredband 300/300"},
    {"gata":"Vallonvägen","nr":"6","ing":"A","lgh":"1002","ort":"Åkers Styckebruk","pnr":"64751","fast":"bfc998ae-736d-4526-828c-fcd1d40df5af","fastnamn":null,
     "saljare":"0663ce9d-5f35-4410-ac32-a2f3bf176b77","namn":"Olle","datum":"2026-10-14","tel":"0706751712",
     "svc":{"salt_bredband":"bb150","salt_svar":{"salt_bredband":true}},"tj":"Bredband 150/150"},
    {"gata":"Brännkyrkagatan","nr":"84","ing":null,"lgh":"1401","ort":"Stockholm","pnr":null,"fast":null,"fastnamn":"Brännkyrkagatan 84, Stockholm",
     "saljare":"0663ce9d-5f35-4410-ac32-a2f3bf176b77","namn":"Olle","datum":"2026-10-14","tel":"0790750877",
     "svc":{"salt_bredband":"bb150","salt_svar":{"salt_bredband":true}},"tj":"Bredband 150/150"}
  ]'::jsonb) loop
    -- redan upplagd?
    if exists (select 1 from records l where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
                 and upper(l.data->>'gatunamn') = upper(v_rad->>'gata') and l.data->>'gatunummer' = v_rad->>'nr'
                 and coalesce(upper(l.data->>'ingang'), '') = coalesce(v_rad->>'ing', '') and l.data->>'name' = v_rad->>'lgh'
                 and samma_ort(l.data->>'postort', v_rad->>'ort')) then
      continue;
    end if;
    v_ts := ((v_rad->>'datum') || ' 12:00')::timestamp at time zone 'Europe/Stockholm';

    v_fid := nullif(v_rad->>'fast', '')::uuid;
    if v_fid is null then
      select f.id into v_fid from records f
       where f.tenant_id = v_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
         and f.data->>'name' = v_rad->>'fastnamn' limit 1;
      if v_fid is null then
        v_fid := gen_random_uuid();
        insert into records (id, tenant_id, object_type, status, owner_user_id, data)
        values (v_fid, v_tenant, 'd2d_fastighet', 'ej_startad', null, jsonb_build_object(
          'name', v_rad->>'fastnamn', 'ort', v_rad->>'ort', 'kommun', v_rad->>'ort'));
      end if;
    end if;

    v_id := gen_random_uuid();
    insert into records (id, tenant_id, object_type, status, owner_user_id, data)
    values (v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad', null, jsonb_strip_nulls(jsonb_build_object(
      'name', v_rad->>'lgh', 'gatunamn', v_rad->>'gata', 'gatunummer', v_rad->>'nr', 'ingang', v_rad->>'ing',
      'postort', v_rad->>'ort', 'postnummer', v_rad->>'pnr',
      'fastighetsbeteckning', case when v_rad->>'fast' is not null then 'De Geer 1' end)));
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_tenant, v_id, v_fid, 'd2d_lag_fastighet') on conflict do nothing;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_id, 'record_created', 'Adressen lades upp från kundtjänstens sälj-lista',
            jsonb_build_object('kalla', 'kundtjanst_lista_2026-10-19'), null, 'system', now());

    update records set data = data || (v_rad->'svc') || jsonb_build_object(
        'saljare', v_rad->>'saljare', 'sald_datum', v_rad->>'datum', 'kund_telefon', v_rad->>'tel',
        'kommentar', 'Kundtjänst (import, 2026-10-19): såld av kundtjänst ' || (v_rad->>'datum') || ', delad med '
                     || (v_rad->>'namn') || ' – ' || (v_rad->>'tj') || ' (ny adress, fanns inte i CRM)')
     where id = v_id;
    update records set status = 'sald' where id = v_id;
    update records set data = data || jsonb_build_object('kundtjanst', v_kt,
             'kundtjanst_lamnad', to_char(v_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     where id = v_id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_id, 'status_change',
            'Såld av kundtjänst, delad med ' || (v_rad->>'namn') || ' (kundtjänstens lista)',
            jsonb_build_object('from', 'ej_knackad', 'to', 'sald', 'kalla', 'kundtjanst_lista_2026-10-19',
                               'kundtjanst', v_kt, 'saljare', v_rad->>'saljare'),
            null, 'system', v_ts);
  end loop;
end $$;
