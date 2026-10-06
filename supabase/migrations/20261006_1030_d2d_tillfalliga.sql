-- =====================================================================
--  D2D — Tillfälliga fastigheter och lägenheter
--
--  En dörrsäljare kan i specialsituationer själv lägga upp en fastighet
--  (gatuadress, ort, ev. fastighetsbeteckning) i det projekt hen står i,
--  och lägenheter (lägenhetsnummer enligt Skatteverket, ev. alias) i
--  vilken fastighet som helst. Allt säljaren skapar är *tillfälligt*
--  (data.tillfallig = true) tills en administratör godkänner det.
--  Godkänns en fastighet godkänns alla dess tillfälliga lägenheter.
--
--  Tillfälliga lägenheter räknas inte i Utfall, topplistan, Sålda eller
--  Avtal förrän de godkänts (Gustav 2026-10-06).
--
--  Fält:        tillfallig, tillfallig_skapad_av, tillfallig_godkand_av,
--               tillfallig_godkand_datum (båda objekttyperna)
--  Funktioner:  d2d_skapa_tillfallig_fastighet, d2d_skapa_tillfallig_lagenhet,
--               d2d_godkann_tillfallig, d2d_tillfalliga_lista
--  Ändrade:     d2d_utfall_kalla, d2d_utfall, d2d_saljstatistik,
--               d2d_salda_lista, d2d_avtal_lista (hoppar över tillfälliga)
-- =====================================================================

-- Fält (måste finnas, annars stoppar validate_record_data sparningen).
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, visibility, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.typ, false,
       v.opts || case when od.key = 'd2d_lagenhet' then '{"section":"adress","seller_hidden":true,"d2d_eget_ui":true}'::jsonb
                      else '{"section":"grundinfo"}'::jsonb end,
       'all', v.so
  from object_definitions od,
       (values
         ('tillfallig',               'Tillfällig (väntar på godkännande)', 'boolean',  '{"_column":true,"_column_order":11,"help":"Skapad av en säljare i D2D-vyn. Räknas inte i statistiken förrän en administratör godkänt den."}'::jsonb, 2),
         ('tillfallig_skapad_av',     'Tillfällig – skapad av',             'user',     '{}'::jsonb, 3),
         ('tillfallig_godkand_av',    'Tillfällig – godkänd av',            'user',     '{}'::jsonb, 4),
         ('tillfallig_godkand_datum', 'Tillfällig – godkänd',               'datetime', '{}'::jsonb, 4)
       ) v(key, label, typ, opts, so)
 where od.key in ('d2d_fastighet', 'd2d_lagenhet')
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- ---------------------------------------------------------------------
-- Säljaren skapar en tillfällig fastighet i ett projekt.
-- Kräver bara att man får läsa fastigheter och uppdatera (egna) lägenheter
-- — dvs. dörrsäljare. Fastigheten ägs av säljaren.
-- ---------------------------------------------------------------------
create or replace function public.d2d_skapa_tillfallig_fastighet(
  p_projekt_id uuid, p_gatuadress text, p_ort text, p_fastighetsbeteckning text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := my_tenant_id();
  v_id uuid := gen_random_uuid();
  v_adress text := nullif(btrim(coalesce(p_gatuadress, '')), '');
  v_ort text := nullif(btrim(coalesce(p_ort, '')), '');
  v_bet text := nullif(btrim(coalesce(p_fastighetsbeteckning, '')), '');
begin
  if v_tenant is null then raise exception 'Ingen tenant i token' using errcode = '42501'; end if;
  if not (can_do('d2d_fastighet', 'read') and can_do('d2d_lagenhet', 'update')) then
    raise exception 'Saknar behörighet att skapa tillfälliga fastigheter' using errcode = '42501';
  end if;
  if v_adress is null then raise exception 'Gatuadress saknas' using errcode = '22023'; end if;
  if v_ort is null then raise exception 'Ort saknas' using errcode = '22023'; end if;

  if p_projekt_id is not null and not exists (
    select 1 from records where id = p_projekt_id and tenant_id = v_tenant
       and object_type = 'd2d_projekt' and deleted_at is null) then
    raise exception 'Projektet finns inte' using errcode = 'P0002';
  end if;

  insert into records (id, tenant_id, object_type, status, owner_user_id, created_by, data)
  values (v_id, v_tenant, 'd2d_fastighet', 'ej_startad', auth.uid(), auth.uid(),
          jsonb_strip_nulls(jsonb_build_object(
            'name', v_adress, 'adress', v_adress, 'ort', v_ort,
            'fastighetsbeteckning', v_bet,
            'tillfallig', true, 'tillfallig_skapad_av', auth.uid()::text)));

  if p_projekt_id is not null then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_tenant, v_id, p_projekt_id, 'd2d_fast_projekt')
    on conflict do nothing;
  end if;

  perform log_activity(v_id, 'record_created', 'Tillfällig fastighet skapad av säljare', '{}'::jsonb);
  perform emit_event('d2d.tillfallig_skapad', v_id, jsonb_build_object('objectType', 'd2d_fastighet'));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Säljaren skapar en tillfällig lägenhet i en fastighet (tillfällig eller
-- inte). Adress, ort, postnummer, fastighetsbeteckning och portkod hämtas
-- från fastigheten; säljaren anger lägenhetsnummer (Skatteverket) och
-- ev. alias. Lägenheten tilldelas säljaren (saljare + owner).
-- ---------------------------------------------------------------------
create or replace function public.d2d_skapa_tillfallig_lagenhet(
  p_fastighet_id uuid, p_lgh_nummer text, p_alias text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := my_tenant_id();
  v_id uuid := gen_random_uuid();
  v_f records%rowtype;
  v_nr text := nullif(btrim(coalesce(p_lgh_nummer, '')), '');
  v_alias text := nullif(btrim(coalesce(p_alias, '')), '');
  v_adress text;
  v_gatunamn text;
  v_gatunr text;
  v_m text[];
begin
  if v_tenant is null then raise exception 'Ingen tenant i token' using errcode = '42501'; end if;
  if not (can_do('d2d_fastighet', 'read') and can_do('d2d_lagenhet', 'update')) then
    raise exception 'Saknar behörighet att skapa tillfälliga lägenheter' using errcode = '42501';
  end if;
  if v_nr is null then raise exception 'Lägenhetsnummer saknas' using errcode = '22023'; end if;

  select * into v_f from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then raise exception 'Fastigheten finns inte' using errcode = 'P0002'; end if;

  if exists (
    select 1 from records l
    join relationships r on r.from_record_id = l.id and r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = p_fastighet_id
    where l.object_type = 'd2d_lagenhet' and l.deleted_at is null and lower(l.title) = lower(v_nr)) then
    raise exception 'Lägenhet % finns redan i fastigheten', v_nr using errcode = '23505';
  end if;

  -- "Storgatan 12B" → gatunamn "Storgatan", gatunummer "12B".
  v_adress := nullif(btrim(coalesce(v_f.data->>'adress', v_f.title, '')), '');
  v_m := regexp_match(coalesce(v_adress, ''), '^(.*\S)\s+(\d+\s?[A-Za-z]?)$');
  if v_m is not null then v_gatunamn := v_m[1]; v_gatunr := v_m[2]; else v_gatunamn := v_adress; end if;

  insert into records (id, tenant_id, object_type, status, owner_user_id, created_by, data)
  values (v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad', auth.uid(), auth.uid(),
          jsonb_strip_nulls(jsonb_build_object(
            'name', v_nr, 'alias', v_alias,
            'gatunamn', v_gatunamn, 'gatunummer', v_gatunr,
            'postort', nullif(v_f.data->>'ort', ''),
            'postnummer', nullif(v_f.data->>'postnummer', ''),
            'fastighetsbeteckning', nullif(v_f.data->>'fastighetsbeteckning', ''),
            'portkod_adress', nullif(v_f.data->>'portkod', ''),
            'saljare', auth.uid()::text,
            'tillfallig', true, 'tillfallig_skapad_av', auth.uid()::text)));

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  values (v_tenant, v_id, p_fastighet_id, 'd2d_lag_fastighet')
  on conflict do nothing;

  perform log_activity(v_id, 'record_created', 'Tillfällig lägenhet skapad av säljare', '{}'::jsonb);
  perform emit_event('d2d.tillfallig_skapad', v_id, jsonb_build_object('objectType', 'd2d_lagenhet', 'fastighetId', p_fastighet_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Admin godkänner en tillfällig fastighet (och alla dess tillfälliga
-- lägenheter) eller en enskild tillfällig lägenhet.
-- ---------------------------------------------------------------------
create or replace function public.d2d_godkann_tillfallig(p_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := my_tenant_id();
  v_r records%rowtype;
  v_patch jsonb := jsonb_build_object('tillfallig', false,
                     'tillfallig_godkand_av', auth.uid()::text,
                     'tillfallig_godkand_datum', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  v_lag int := 0;
begin
  if not (is_admin() or my_scope('d2d_fastighet', 'update') = 'tenant') then
    raise exception 'Bara administratörer kan godkänna tillfälliga poster' using errcode = '42501';
  end if;

  select * into v_r from records
   where id = p_id and tenant_id = v_tenant and object_type in ('d2d_fastighet', 'd2d_lagenhet') and deleted_at is null;
  if not found then raise exception 'Posten finns inte' using errcode = 'P0002'; end if;

  if v_r.object_type = 'd2d_fastighet' then
    update records l set data = l.data || v_patch
      from relationships r
     where r.from_record_id = l.id and r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = p_id
       and l.object_type = 'd2d_lagenhet' and l.deleted_at is null and l.data->>'tillfallig' = 'true';
    get diagnostics v_lag = row_count;
  end if;

  update records set data = data || v_patch where id = p_id;
  perform log_activity(p_id, 'field_change', 'Tillfällig post godkänd', jsonb_build_object('lagenheter', v_lag));
  perform emit_event('d2d.tillfallig_godkand', p_id, jsonb_build_object('objectType', v_r.object_type, 'lagenheter', v_lag));
  return jsonb_build_object('ok', true, 'objectType', v_r.object_type, 'lagenheter', v_lag);
end $$;

-- ---------------------------------------------------------------------
-- Lista för admin: tillfälliga fastigheter (med antal lägenheter) och
-- tillfälliga lägenheter i fastigheter som inte själva är tillfälliga.
-- ---------------------------------------------------------------------
create or replace function public.d2d_tillfalliga_lista()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with namn as (
    select u.id, coalesce(nullif(u.full_name, ''), u.email::text) namn from users u
  ),
  fast as (
    select f.*, p.title projekt, p.id projekt_id,
           (select count(*) from records l join relationships r on r.from_record_id = l.id and r.rel_type = 'd2d_lag_fastighet'
             where r.to_record_id = f.id and l.deleted_at is null) antal_lag
      from records f
      left join relationships rp on rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt'
      left join records p on p.id = rp.to_record_id and p.deleted_at is null
     where f.tenant_id = my_tenant_id() and f.object_type = 'd2d_fastighet' and f.deleted_at is null
       and f.data->>'tillfallig' = 'true'
  ),
  lag as (
    select l.*, f.id fastighet_id, coalesce(f.data->>'fastighetsbeteckning', f.title) fastighet, p.title projekt, p.id projekt_id
      from records l
      join relationships rf on rf.from_record_id = l.id and rf.rel_type = 'd2d_lag_fastighet'
      join records f on f.id = rf.to_record_id and f.deleted_at is null
      left join relationships rp on rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt'
      left join records p on p.id = rp.to_record_id and p.deleted_at is null
     where l.tenant_id = my_tenant_id() and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and l.data->>'tillfallig' = 'true'
       and coalesce(f.data->>'tillfallig', '') <> 'true'
  )
  select case when not (is_admin() or my_scope('d2d_fastighet', 'update') = 'tenant')
              then jsonb_build_object('fastigheter', '[]'::jsonb, 'lagenheter', '[]'::jsonb)
         else jsonb_build_object(
    'fastigheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', f.id, 'adress', f.title, 'ort', f.data->>'ort',
        'fastighetsbeteckning', f.data->>'fastighetsbeteckning',
        'projekt', f.projekt, 'projektId', f.projekt_id, 'antalLagenheter', f.antal_lag,
        'skapad', f.created_at,
        'skapadAv', (select namn from namn where id::text = f.data->>'tillfallig_skapad_av'))
      order by f.created_at desc) from fast f), '[]'::jsonb),
    'lagenheter', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.id, 'lgh', l.title, 'alias', l.data->>'alias',
        'adress', nullif(concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer'), ''),
        'ort', l.data->>'postort', 'status', l.status,
        'fastighet', l.fastighet, 'fastighetId', l.fastighet_id,
        'projekt', l.projekt, 'projektId', l.projekt_id,
        'skapad', l.created_at,
        'skapadAv', (select namn from namn where id::text = l.data->>'tillfallig_skapad_av'))
      order by l.created_at desc) from lag l), '[]'::jsonb))
  end
$$;

grant execute on function public.d2d_skapa_tillfallig_fastighet(uuid, text, text, text) to authenticated;
grant execute on function public.d2d_skapa_tillfallig_lagenhet(uuid, text, text) to authenticated;
grant execute on function public.d2d_godkann_tillfallig(uuid) to authenticated;
grant execute on function public.d2d_tillfalliga_lista() to authenticated;

-- ---------------------------------------------------------------------
-- Statistiken hoppar över tillfälliga lägenheter tills de godkänts.
-- Befintliga funktioner ändras på plats (pg_get_functiondef + replace).
-- ---------------------------------------------------------------------
do $$
declare
  v text; f text; a text; b text;
  fn text[] := array[
    'public.d2d_utfall_kalla(text, uuid, uuid, date, date)',
    'public.d2d_utfall(uuid, uuid, date, date)'];
begin
  foreach f in array fn loop
    v := pg_get_functiondef(f::regprocedure);
    if position('tillfallig' in v) > 0 then continue; end if;
    a := 'l.object_type = ''d2d_lagenhet'' and l.deleted_at is null';
    if position(a in v) = 0 then raise exception '% : hittar inte filtret', f; end if;
    execute replace(v, a, a || ' and coalesce(l.data->>''tillfallig'', '''') <> ''true''');
  end loop;

  -- d2d_saljstatistik: två ställen (sälj-listan och utanTid), olika radbrytning.
  v := pg_get_functiondef('public.d2d_saljstatistik()'::regprocedure);
  if position('tillfallig' in v) = 0 then
    b := regexp_replace(v, '(l\.deleted_at is null\s+and l\.status = ''sald'')',
                        '\1 and coalesce(l.data->>''tillfallig'', '''') <> ''true''', 'g');
    if b = v then raise exception 'd2d_saljstatistik: hittar inte filtret'; end if;
    execute b;
  end if;

  -- d2d_salda_lista
  v := pg_get_functiondef('public.d2d_salda_lista(date, date)'::regprocedure);
  if position('tillfallig' in v) = 0 then
    a := 'and l.deleted_at is null and l.status = ''sald''';
    if position(a in v) = 0 then raise exception 'd2d_salda_lista: hittar inte filtret'; end if;
    execute replace(v, a, a || ' and coalesce(l.data->>''tillfallig'', '''') <> ''true''');
  end if;

  -- d2d_avtal_lista
  v := pg_get_functiondef('public.d2d_avtal_lista(date, date)'::regprocedure);
  if position('tillfallig' in v) = 0 then
    a := 'join records l on l.id = a.lagenhet_id and l.deleted_at is null';
    if position(a in v) = 0 then raise exception 'd2d_avtal_lista: hittar inte filtret'; end if;
    execute replace(v, a, a || ' and coalesce(l.data->>''tillfallig'', '''') <> ''true''');
  end if;
end $$;
