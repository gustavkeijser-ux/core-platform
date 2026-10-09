-- D2D: en såld (Såld / Signera med Scrive) adress låses till säljaren som
-- sålde den. Säljaren ligger i data.saljare, tilldelningen (vem som ser
-- adressen i sin app) i owner_user_id. Byter man säljare på en hel fastighet
-- följer sålda adresser med till den nya säljaren (owner_user_id) men står
-- kvar som sålda/signerade av den ursprungliga säljaren (data.saljare).

-- 1. Lås + "den som klickar Såld blir säljare".
create or replace function public.d2d_lag_las_saljare()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_old_s text := nullif(btrim(coalesce(old.data->>'saljare', '')), '');
  v_new_s text := nullif(btrim(coalesce(new.data->>'saljare', '')), '');
  v_sald_forr boolean := old.status in ('sald', 'scrive');
  v_sald_ny boolean := new.status in ('sald', 'scrive');
  v_admin boolean := v_uid is not null and public.is_admin();
begin
  -- Importen (adresslista ur fil) sätter status och säljare själv.
  if current_setting('d2d.import', true) = '1' then return new; end if;

  -- Låset: en såld/signerad adress behåller sin säljare. Bara admin får byta.
  if v_sald_forr and v_sald_ny and v_old_s is not null and v_new_s is distinct from v_old_s and not v_admin then
    raise exception 'Adressen är såld och låst till säljaren som sålde den. Kontakta admin.'
      using errcode = '42501';
  end if;

  -- Vid Såld / Signera med Scrive: den som klickar blir säljare (om inte
  -- anropet redan sätter säljaren uttryckligen). En admin som sätter
  -- statusen på en adress som redan har en säljare tar inte över affären.
  if v_sald_ny and not v_sald_forr and v_uid is not null
     and v_new_s is not distinct from v_old_s
     and (v_old_s is null or not v_admin)
     and exists (select 1 from users u where u.id = v_uid and u.tenant_id = new.tenant_id) then
    new.data := new.data || jsonb_build_object('saljare', v_uid::text);
  end if;
  return new;
end $function$;

-- Namnet ligger före trg_d2d_lag_saljare_till_agare i bokstavsordning, så
-- ägaren synkas från säljaren efter att låset körts.
create or replace trigger trg_d2d_lag_las_saljare
  before update on public.records
  for each row when (new.object_type = 'd2d_lagenhet')
  execute function public.d2d_lag_las_saljare();

-- 2. Omfördelning: sålda adresser byter bara ägare, inte säljare.
do $$
declare v_def text; v_gammal text; v_ny text;
begin
  v_gammal := 'set owner_user_id = t.value::uuid, data = l.data || jsonb_build_object(''saljare'', t.value)';
  v_ny := 'set owner_user_id = t.value::uuid, data = case when l.status in (''sald'', ''scrive'') and nullif(l.data->>''saljare'', '''') is not null then l.data else l.data || jsonb_build_object(''saljare'', t.value) end';
  for v_def in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname in ('d2d_approve_project', 'd2d_set_fastighet_manuell_tilldelning')
  loop
    if position(v_ny in v_def) > 0 then continue; end if;
    if position(v_gammal in v_def) = 0 then raise exception 'Hittade inte texten att byta i %', left(v_def, 80); end if;
    execute replace(v_def, v_gammal, v_ny);
  end loop;

  select pg_get_functiondef('public.d2d_approve_project'::regproc) into v_def;
  v_gammal := 'data = data || jsonb_build_object(''saljare'', v_seller::text)';
  v_ny := 'data = case when records.status in (''sald'', ''scrive'') and nullif(records.data->>''saljare'', '''') is not null then records.data else records.data || jsonb_build_object(''saljare'', v_seller::text) end';
  if position(v_ny in v_def) = 0 then
    if position(v_gammal in v_def) = 0 then raise exception 'Hittade inte procentgrenen i d2d_approve_project'; end if;
    execute replace(v_def, v_gammal, v_ny);
  end if;
end $$;

-- 3. Fastighetens tilldelning räknas på ägaren (tilldelad säljare), inte på
--    vem som sålde, så sålda adresser inte dras tillbaka till den gamla
--    säljaren vid nästa godkännande.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.d2d_lag_saljare_till_fastighet'::regproc) into v_def;
  if position('coalesce(l.owner_user_id::text, l.data->>''saljare'')' in v_def) > 0 then return; end if;
  if position('jsonb_object_agg(l.id::text, l.data->>''saljare'')' in v_def) = 0
     or position('select l.data->>''saljare'' s, count(*) n' in v_def) = 0 then
    raise exception 'Hittade inte texten att byta i d2d_lag_saljare_till_fastighet';
  end if;
  v_def := replace(v_def, 'jsonb_object_agg(l.id::text, l.data->>''saljare'')', 'jsonb_object_agg(l.id::text, coalesce(l.owner_user_id::text, l.data->>''saljare''))');
  v_def := replace(v_def, 'select l.data->>''saljare'' s, count(*) n', 'select coalesce(l.owner_user_id::text, l.data->>''saljare'') s, count(*) n');
  v_def := replace(v_def, 'and l.deleted_at is null and nullif(l.data->>''saljare'', '''') is not null', 'and l.deleted_at is null and coalesce(l.owner_user_id::text, nullif(l.data->>''saljare'', '''')) is not null');
  execute v_def;
end $$;

-- 4. Importen hoppar över låset (sätter status och säljare själv).
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.d2d_import_addresses'::regproc) into v_def;
  if position('set_config(''d2d.import''' in v_def) > 0 then return; end if;
  if position(E'begin\n  v_tenant := my_tenant_id();\n' in v_def) = 0 then raise exception 'Hittade inte början av d2d_import_addresses'; end if;
  execute replace(v_def, E'begin\n  v_tenant := my_tenant_id();\n', E'begin\n  v_tenant := my_tenant_id();\n  perform set_config(''d2d.import'', ''1'', true);\n');
end $$;

-- 5. Säljstatistiken räknar säljaren som sålde (data.saljare), inte ägaren.
create or replace function public.d2d_saljare_uuid(p_data jsonb)
returns uuid
language sql
immutable
as $function$
  select case when p_data->>'saljare' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (p_data->>'saljare')::uuid end
$function$;

do $$
declare v_def text;
begin
  select pg_get_functiondef('public.d2d_saljstatistik'::regproc) into v_def;
  if position('coalesce(d2d_saljare_uuid(l.data), l.owner_user_id, a.actor)' in v_def) > 0 then return; end if;
  if position('coalesce(l.owner_user_id, a.actor) as u' in v_def) = 0 or position('coalesce(l.owner_user_id, av.skapad_av) as u' in v_def) = 0 then
    raise exception 'Hittade inte texten att byta i d2d_saljstatistik';
  end if;
  v_def := replace(v_def, 'coalesce(l.owner_user_id, a.actor) as u', 'coalesce(d2d_saljare_uuid(l.data), l.owner_user_id, a.actor) as u');
  v_def := replace(v_def, 'coalesce(l.owner_user_id, av.skapad_av) as u', 'coalesce(d2d_saljare_uuid(l.data), l.owner_user_id, av.skapad_av) as u');
  execute v_def;
end $$;
