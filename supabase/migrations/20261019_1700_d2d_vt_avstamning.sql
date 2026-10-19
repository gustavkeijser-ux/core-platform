-- Avstämning mot Telias VT-lista (ordrar med försäljningsdatum 26–30 sep 2026), enligt Gustav 19 okt.
-- CRM rättas efter VT: tjänster, hastigheter, TV Bas, router och försäljningsdatum.
--  * Bondegatan 3 A 1102, Mjölby: återställs till registreringen före 19 okt (kundtjänstens
--    försäljning 28/9 gällde 1202, inte 1102 — se VT-ordrarna 59468632/59468771).
--  * Bondegatan 3 A 1202, Mjölby: såld 28/9, Jacob, delad med kundtjänst. TV Premium Film finns
--    inte som tjänst i CRM och skrivs i kommentaren.
--  * Sveaborgsgatan 34 B 1003, Borlänge: såld 29/9, Jacob (var Återkoppling).
--  * Övriga: tjänster/datum enligt VT. Befintliga kommentarer ändras aldrig (bara tillägg).
-- Varje ändring loggas som aktivitet med värdena före ändringen. Status sätts före
-- kundtjanst-fältet (inga bekräftelsemejl). Ingebjörnsgatan 5 "2-1-24" ingår inte (okänd lägenhet).
do $$
declare
  v_tenant constant uuid := 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1';
  v_kt constant text := '5556a666-18c4-40be-9da2-0eeda80a8be9';
  v_jacob constant text := '393256b0-a7dc-4640-8233-696b07079321';
  v_p jsonb; v_r records%rowtype; v_patch jsonb; v_svar jsonb; v_fore jsonb;
begin
  perform set_config('d2d.import', '1', true);

  ---------------------------------------------------------------- 1. Bondegatan 3 A 1102: återställ
  select * into v_r from records where id = '2c7f176d-27c3-428d-8571-1e4a9aaaee99' for update;
  if v_r.data->>'sald_datum' = '2026-09-28' then
    select a.metadata->'fore' into v_fore from activities a
     where a.record_id = v_r.id and a.metadata->>'kalla' = 'kundtjanst_lista_2026-10-19' and a.metadata ? 'fore'
     order by a.occurred_at limit 1;
    if v_fore is null then raise exception 'Hittar inte tidigare värden för Bondegatan 3 A 1102'; end if;
    update records set data = (data - 'mobil_extra_antal') || v_fore || jsonb_build_object('kommentar',
             concat_ws(E'\n', nullif(btrim(coalesce(data->>'kommentar', '')), ''),
               'Rättelse (VT-avstämning, 2026-10-19): kundtjänstens försäljning 28/9 gällde Bondegatan 3 A 1202, inte denna lägenhet. Tjänster och såld-datum återställda.'))
     where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_r.id, 'field_change', 'Tjänster och såld-datum återställda (försäljningen 28/9 hörde till lgh 1202)',
            jsonb_build_object('kalla', 'vt_lista_2026-10-19', 'atergestallt', v_fore), null, 'system', now());
  end if;

  ---------------------------------------------------------------- 2. Bondegatan 3 A 1202: ny försäljning
  select * into v_r from records where id = 'cccf5e7c-6a3d-498b-ba3f-8c7112cd6225' for update;
  if v_r.status is distinct from 'sald' then
    update records set data = data || jsonb_build_object(
        'saljare', v_jacob, 'sald_datum', '2026-09-28',
        'salt_bredband', 'bb150', 'salt_tv', 'tv_basic', 'salt_streaming_film', 'streaming_mer',
        'salt_mobil', jsonb_build_array('obegransad_plus', 'extra_anvandare'), 'mobil_extra_antal', 1,
        'salt_router', '1_router',
        'salt_svar', jsonb_build_object('salt_bredband', true, 'salt_tv', true, 'salt_streaming_film', true, 'salt_mobil', true, 'salt_router', true),
        'kommentar', concat_ws(E'\n', nullif(btrim(coalesce(data->>'kommentar', '')), ''),
          'Kundtjänst (VT-avstämning, 2026-10-19): såld av kundtjänst 2026-09-28, delad med Jacob – Bredband 150/150, TV Bas, Streaming Mer, TV Premium Film, Asus-router, Mobil Obegränsad Plus + 1 extra användare (VT-order 59468632, 59468771)'))
       || case when nullif(btrim(coalesce(data->>'kund_telefon', '')), '') is null
               then jsonb_build_object('kund_telefon', '0739521880') else '{}'::jsonb end
     where id = v_r.id;
    update records set status = 'sald' where id = v_r.id;
    update records set data = data || jsonb_build_object('kundtjanst', v_kt, 'kundtjanst_lamnad', '2026-09-28T10:00:00Z')
     where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_r.id, 'status_change', 'Såld av kundtjänst, delad med Jacob (VT-avstämning)',
            jsonb_build_object('from', v_r.status, 'to', 'sald', 'kalla', 'vt_lista_2026-10-19', 'kundtjanst', v_kt, 'saljare', v_jacob),
            null, 'system', '2026-09-28 12:00 Europe/Stockholm'::timestamptz);
  end if;

  ---------------------------------------------------------------- 3. Sveaborgsgatan 34 B 1003: såld
  select * into v_r from records where id = '574e5905-2fe5-4b3a-af14-78233208dc78' for update;
  if v_r.status is distinct from 'sald' then
    update records set data = data || jsonb_build_object(
        'saljare', v_jacob, 'sald_datum', '2026-09-29', 'salt_bredband', 'bb300', 'salt_tv', 'tv_basic',
        'salt_svar', coalesce(data->'salt_svar', '{}'::jsonb) || jsonb_build_object('salt_bredband', true, 'salt_tv', true),
        'kommentar', concat_ws(E'\n', nullif(btrim(coalesce(data->>'kommentar', '')), ''),
          'VT-avstämning 2026-10-19: såld 2026-09-29 av Jacob enligt VT (order 59488111) – Bredband 300/300, TV Bas'))
     where id = v_r.id;
    update records set status = 'sald' where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_r.id, 'status_change', 'Såld enligt VT (order 59488111)',
            jsonb_build_object('from', v_r.status, 'to', 'sald', 'kalla', 'vt_lista_2026-10-19', 'saljare', v_jacob),
            null, 'system', '2026-09-29 12:00 Europe/Stockholm'::timestamptz);
  end if;

  ---------------------------------------------------------------- 4. Tjänster/datum enligt VT
  for v_p in select * from jsonb_array_elements('[
    {"id":"e6e4ded8-4d24-4d6e-a874-129f1da34567","adr":"Skyttegatan 15 C 1001","set":{"salt_bredband":"bb300","salt_tv":"tv_basic"}},
    {"id":"df53de27-3d5c-4c06-a978-1b2d52ac70ac","adr":"Skyttegatan 5 B 1001","set":{"salt_bredband":"bb300","salt_tv":"tv_basic","salt_streaming_film":"streaming_mest"}},
    {"id":"84fa26a9-5870-4098-a94e-9c3c59d3869a","adr":"Skyttegatan 7 A 1101","set":{"salt_bredband":"bb150","salt_tv":"tv_mycket"}},
    {"id":"6d90c265-c03a-4241-94de-0e7b50ca9dd0","adr":"Skyttegatan 19 B 1002","set":{"salt_bredband":"bb150","salt_tv":"tv_mellan","sald_datum":"2026-09-29"}},
    {"id":"e2624429-900e-40e7-89e1-019dcb7b570b","adr":"Dammvägen 9 B 1007","set":{"salt_bredband":"bb150","salt_tv":"tv_basic","sald_datum":"2026-09-30"}},
    {"id":"f788a8cc-587a-4f65-9ef6-d7aa9e72e431","adr":"Eriksdalsgatan 2 B 1002","set":{"salt_bredband":"bb150","sald_datum":"2026-09-29"}},
    {"id":"b10fcc5d-8043-44ea-9aff-8b605300a0aa","adr":"Skyttegatan 41 A 1002","set":{"salt_tv":null},"svar":{"salt_tv":false}},
    {"id":"3e072a9a-ad69-44c9-84c7-072d498083d9","adr":"Skyttegatan 39 C 1002","set":{"salt_router":"1_router"}},
    {"id":"fa6facb3-46f4-4d21-a784-d356178e2ab4","adr":"Skyttegatan 35 A 1101","set":{"salt_router":"1_router"}},
    {"id":"16427f99-2982-4d39-a363-a637fd3fe894","adr":"Skyttegatan 25 B 1101","set":{"salt_router":"1_router","salt_tv":"tv_basic"}},
    {"id":"18ff6d9b-f469-4a75-aa76-bbd67f159aba","adr":"Skyttegatan 21 C 1001","set":{"salt_router":"1_router","salt_tv":"tv_basic","sald_datum":"2026-09-28"}},
    {"id":"c57cb875-8818-4215-9557-9e5db4669b37","adr":"Skyttegatan 3 A 1001","set":{"salt_router":"1_router","salt_tv":"tv_basic"}},
    {"id":"d0ae60fa-1110-4db6-a588-332fa50c186c","adr":"Skyttegatan 5 A 1001","set":{"salt_tv":"tv_basic"}},
    {"id":"f855db74-8bbb-427f-b107-85054d6308ad","adr":"Skyttegatan 33 A 1002","set":{"salt_tv":"tv_basic"}},
    {"id":"83cd949a-ae11-4233-944d-6409a19a8511","adr":"Skyttegatan 17 C 1102","set":{"salt_tv":"tv_basic"}},
    {"id":"a17e0c2b-e023-4b82-b2cc-98e499b934bc","adr":"Skyttegatan 15 B 1002","set":{"salt_tv":"tv_basic"}},
    {"id":"32d30b4b-6959-473d-818b-1c4ec8d282e8","adr":"Skyttegatan 19 B 1001","set":{"salt_tv":"tv_basic"}},
    {"id":"47169c4c-4d50-40f7-a56a-75ff5eef14ae","adr":"Skomakargatan 15 A 1101, Gävle","set":{"salt_tv":"tv_basic"}},
    {"id":"227c4893-8770-4856-b261-a8f594b2eae3","adr":"Skomakargatan 15 A 1102, Gävle","set":{"salt_tv":"tv_basic"}},
    {"id":"3a114023-5661-440e-9e26-b702d4b785ca","adr":"Skomakargatan 15 B 1002, Gävle","set":{"salt_tv":"tv_basic"}},
    {"id":"fe3edb6e-bfd2-400a-993b-b97312218b3b","adr":"Bellmansgatan 24 1501","set":{"salt_tv":"tv_basic"}},
    {"id":"d6b2b221-e1ce-4e2d-bc17-6795c3db9f4f","adr":"Svartlösavägen 220 1001","set":{"salt_tv":"tv_basic"}}
  ]'::jsonb) loop
    select * into v_r from records where id = (v_p->>'id')::uuid and deleted_at is null for update;
    if not found then raise exception 'Saknas: %', v_p->>'adr'; end if;
    -- redan gjort?
    if (v_r.data || (v_p->'set')) = v_r.data then continue; end if;

    select coalesce(jsonb_object_agg(k, v_r.data->k), '{}'::jsonb) into v_fore
      from jsonb_object_keys(v_p->'set') k;
    v_svar := coalesce(v_r.data->'salt_svar', '{}'::jsonb)
      || coalesce((select jsonb_object_agg(k, true) from jsonb_each(v_p->'set') e(k, v)
                    where k like 'salt_%' and v <> 'null'::jsonb), '{}'::jsonb)
      || coalesce(v_p->'svar', '{}'::jsonb);
    v_patch := (v_p->'set') || jsonb_build_object('salt_svar', v_svar);
    update records set data = data || v_patch where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_r.id, 'field_change', 'Tjänster/datum rättade enligt VT-listan',
            jsonb_build_object('kalla', 'vt_lista_2026-10-19', 'fore', v_fore, 'efter', v_p->'set'), null, 'system', now());
  end loop;
end $$;
