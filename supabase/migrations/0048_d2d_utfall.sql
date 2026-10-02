-- D2D-utfall: rapportsida under Door to door + nya fält i säljarvyn.
--  * Bindningstid på alla besök: bunden_till (ÅÅÅÅ-MM), tjänst och operatör.
--  * På sålda kunder: varför de inte tog mer än bredband.
--  * d2d_utfall(): allt som sidan visar, filtrerat på projekt, säljare och period.

-- ── Fält ────────────────────────────────────────────────────────────────────
do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'd2d_lagenhet';
    if v_obj is null then continue; end if;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select v_obj, t.id, f.key, f.label, f.typ, false, f.opts, f.sort
      from (values
        ('bunden_till', 'Bunden till', 'text',
          '{"section":"knackning","d2d_eget_ui":true,"help":"Månad då kundens nuvarande bindning löper ut (ÅÅÅÅ-MM)"}'::jsonb, 57),
        ('bunden_tjanst', 'Bunden tjänst', 'multi_select',
          '{"section":"knackning","d2d_eget_ui":true,"choices":[
             {"key":"mbb","label":"Mobilt bredband"},{"key":"mobil","label":"Mobil"},
             {"key":"bredband","label":"Fast bredband"},{"key":"tv","label":"TV"}]}'::jsonb, 58),
        ('bunden_operator', 'Operatör (bunden)', 'select',
          '{"section":"knackning","d2d_eget_ui":true,"choices":[
             {"key":"telenor","label":"Telenor"},{"key":"tele2","label":"Tele2"},{"key":"tre","label":"Tre"},
             {"key":"comviq","label":"Comviq"},{"key":"telia","label":"Telia"},{"key":"bahnhof","label":"Bahnhof"},
             {"key":"bredband2","label":"Bredband2"},{"key":"allente","label":"Allente"},{"key":"hallon","label":"Hallon"},
             {"key":"annan","label":"Annan"}]}'::jsonb, 59),
        ('ej_mer_anledning', 'Varför inte mer än bredband', 'multi_select',
          '{"section":"salt","d2d_eget_ui":true,"choices":[
             {"key":"tittar_lite","label":"Tittar lite på TV/streaming"},
             {"key":"mobil_bunden","label":"Mobilen är bunden"},
             {"key":"har_telia","label":"Har redan Telia"},
             {"key":"familj_betalar","label":"Någon annan betalar"},
             {"key":"billig_mobil","label":"Billig mobil, nöjd"},
             {"key":"pris","label":"Priset"},
             {"key":"vill_fundera","label":"Vill fundera"},
             {"key":"flodet","label":"Gick inte att välja i flödet"},
             {"key":"annat","label":"Annat"}]}'::jsonb, 598)
      ) as f(key, label, typ, opts, sort)
     where not exists (select 1 from field_definitions x where x.object_id = v_obj and x.key = f.key);
  end loop;
end $$;

-- ── Bindningsmånad ur fälten (nytt fält först, annars det gamla fritextfältet) ──
create or replace function public.d2d_bunden_manad(p_data jsonb)
returns text language plpgsql immutable as $$
declare v text; m text; manader text[] := array['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
  i int;
begin
  v := lower(btrim(coalesce(nullif(p_data->>'bunden_till', ''), p_data->>'ej_intresserad_bindningstid', '')));
  if v = '' then return null; end if;
  m := substring(v from '^(\d{4}-\d{2})');
  if m is not null then return m; end if;
  -- "februari 2028", "dec 2026"
  for i in 1..12 loop
    if v ~ (manader[i] || '[a-zåäö]*\s+\d{4}') then
      return substring(v from '(\d{4})') || '-' || lpad(i::text, 2, '0');
    end if;
  end loop;
  m := substring(v from '^(\d{4})$');
  return m;  -- bara år, eller null
end $$;

-- jsonb-array eller tom array (Postgres kortsluter inte AND, så typkollen måste ske här).
create or replace function public.d2d_arr(p jsonb)
returns jsonb language sql immutable as $$
  select case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end
$$;

-- ── Rapporten ───────────────────────────────────────────────────────────────
create or replace function public.d2d_utfall(
  p_projekt uuid default null, p_saljare uuid default null, p_fran date default null, p_till date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_scope text;
begin
  if not (is_admin() or my_scope('d2d_lagenhet', 'read') = 'tenant') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v_scope := my_scope('d2d_lagenhet', 'read');

  with bas as (
    select distinct on (l.id) l.id, l.status, l.data d, l.title,
           nullif(l.data->>'saljare', '') saljare, rp.to_record_id projekt_id,
           (l.data->>'senast_kontakt')::timestamptz kontakt
      from records l
      left join relationships rf on rf.from_record_id = l.id and rf.rel_type = 'd2d_lag_fastighet'
      left join relationships rp on rp.from_record_id = rf.to_record_id and rp.rel_type = 'd2d_fast_projekt'
     where l.tenant_id = my_tenant_id() and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and coalesce(l.status, 'ej_knackad') <> 'ej_knackad'
       and in_scope(v_scope, l.owner_user_id)
  ),
  urval as (
    select b.*,
      -- Sålt något utöver bredband?
      coalesce((nullif(d->>'salt_tv', '') is not null
        or jsonb_array_length(d2d_arr(d->'salt_mobil')) > 0
        or nullif(d->>'salt_streaming_film', '') is not null
        or nullif(d->>'salt_streaming_sport', '') is not null
        or d->>'salt_tvbox' = 'true' or nullif(d->>'salt_router', '') is not null
        or d->>'salt_trygghet' = 'true'), false) mer,
      d2d_bunden_manad(d) bunden
      from bas b
     where (p_projekt is null or b.projekt_id = p_projekt)
       and (p_saljare is null or b.saljare = p_saljare::text)
       and (p_fran is null or b.kontakt >= p_fran)
       and (p_till is null or b.kontakt < p_till + 1)
  ),
  svarade as (select * from urval where status <> 'inte_hemma'),
  salda as (select * from urval where status = 'sald'),
  bundna as (select * from svarade where bunden is not null or jsonb_typeof(d->'bunden_tjanst') = 'array')
  select jsonb_build_object(
    'besok', (select count(*) from urval),
    'statusar', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from urval group by 1) x), '{}'::jsonb),
    'sald', jsonb_build_object(
      'antal', (select count(*) from salda),
      'merAnBredband', (select count(*) from salda where mer),
      'kategorier', jsonb_build_object(
        'tv', (select count(*) from salda where nullif(d->>'salt_tv', '') is not null),
        'mobil', (select count(*) from salda where jsonb_array_length(d2d_arr(d->'salt_mobil')) > 0),
        'streaming_film', (select count(*) from salda where nullif(d->>'salt_streaming_film', '') is not null),
        'streaming_sport', (select count(*) from salda where nullif(d->>'salt_streaming_sport', '') is not null),
        'tvbox', (select count(*) from salda where d->>'salt_tvbox' = 'true'),
        'router', (select count(*) from salda where nullif(d->>'salt_router', '') is not null),
        'trygghet', (select count(*) from salda where d->>'salt_trygghet' = 'true')),
      'ejMer', coalesce((select jsonb_object_agg(k, n) from (
          select k, count(*) n from salda, jsonb_array_elements_text(case when jsonb_typeof(d->'ej_mer_anledning') = 'array' then d->'ej_mer_anledning' else '[]'::jsonb end) k
           where not mer group by 1) x), '{}'::jsonb),
      'ejMerUtanSkal', (select count(*) from salda where not mer
          and coalesce(jsonb_array_length(case when jsonb_typeof(d->'ej_mer_anledning') = 'array' then d->'ej_mer_anledning' end), 0) = 0)),
    'ejIntresserad', coalesce((select jsonb_object_agg(k, n) from (
        select coalesce(nullif(d->>'ej_intresserad_anledning', ''), 'saknas') k, count(*) n
          from urval where status = 'inte_intresserad' group by 1) x), '{}'::jsonb),
    'bindningar', jsonb_build_object(
      'hushall', (select count(*) from bundna),
      'ejSalda', (select count(*) from bundna where status <> 'sald'),
      'svaradeEjSalda', (select count(*) from svarade where status <> 'sald'),
      'perManad', coalesce((select jsonb_object_agg(m, n) from (
          select coalesce(bunden, 'okand') m, count(*) n from bundna group by 1) x), '{}'::jsonb),
      'tjanst', coalesce((select jsonb_object_agg(k, n) from (
          select k, count(*) n from bundna, jsonb_array_elements_text(case when jsonb_typeof(d->'bunden_tjanst') = 'array' then d->'bunden_tjanst' else '[]'::jsonb end) k group by 1) x), '{}'::jsonb),
      'operator', coalesce((select jsonb_object_agg(k, n) from (
          select coalesce(nullif(d->>'bunden_operator', ''), 'okand') k, count(*) n from bundna group by 1) x), '{}'::jsonb)),
    'perSaljare', coalesce((select jsonb_agg(jsonb_build_object(
          'id', saljare, 'namn', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = s.saljare),
          'besok', besok, 'oppnade', oppnade, 'salda', salda, 'mer', mer) order by salda desc, besok desc)
        from (select saljare, count(*) besok, count(*) filter (where status <> 'inte_hemma') oppnade,
                     count(*) filter (where status = 'sald') salda, count(*) filter (where status = 'sald' and mer) mer
                from urval where saljare is not null group by 1) s), '[]'::jsonb),
    'aterringning', coalesce((select jsonb_agg(jsonb_build_object(
          'id', b.id, 'adress', concat_ws(' ', b.d->>'gatunamn', b.d->>'gatunummer') ||
              coalesce(', lgh ' || nullif(b.d->>'name', ''), ''),
          'ort', b.d->>'postort', 'status', b.status, 'bunden', b.bunden,
          'tjanst', case when jsonb_typeof(b.d->'bunden_tjanst') = 'array' then b.d->'bunden_tjanst' else '[]'::jsonb end,
          'operator', nullif(b.d->>'bunden_operator', ''),
          'saljare', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = b.saljare),
          'kommentar', left(b.d->>'kommentar', 160)) order by b.bunden)
        from bundna b where b.bunden ~ '^\d{4}-\d{2}$'), '[]'::jsonb),
    'projekt', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title) order by p.created_at desc)
        from records p where p.tenant_id = my_tenant_id() and p.object_type = 'd2d_projekt' and p.deleted_at is null), '[]'::jsonb),
    'saljare', coalesce((select jsonb_agg(jsonb_build_object('id', s, 'namn',
          (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = s)) order by s)
        from (select distinct saljare s from bas where saljare is not null) z), '[]'::jsonb)
  ) into v;
  return v;
end $$;
grant execute on function public.d2d_utfall(uuid, uuid, date, date) to authenticated;
