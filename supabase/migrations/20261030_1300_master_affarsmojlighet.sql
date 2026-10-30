-- Master: Affär och affärsmöjlighet enligt mockupen "koncernmoder, affär och leverans" (Gustav 30 okt 2026).
--
-- Modell:
--   * Koncernmoder = registret (läses in, kompletteras, delas ut till säljare).
--   * Affär (deal) = kundens plats i säljprocessen, en per koncernmoder. Skapas vid utdelning.
--   * Affärsmöjlighet (ny objekttyp affarsmojlighet) = en produkt i affären (Fiber, Boendeapp och lås,
--     Hyresförhandling, TV …) med eget steg, fastigheter som ingår, omfattning, checklista, roller
--     och dokument. Vid signering av fiber skapas leveranser som förut (affar_sald).
--
-- Den här filen: objekttypen med fält, statusar, relationer och behörigheter; kundtyper enligt
-- mockupen på koncernmoder och affär; mötesbokare som användarfält; utdelning (km_dela_ut) som
-- skapar affären med mötesbokare och affärsdelning; registervyn (km_register) och registerkortet
-- (km_kort); skapa möjlighet (skapa_mojlighet); och en fiber-möjlighet för befintliga affärer som
-- redan kommit längre än "kontakt etablerad" (Gustavs val 30 okt).
-- Idempotent: kan köras på en databas där delar redan finns.

-- ── 1. Objekttypen affarsmojlighet ─────────────────────────────────────────
do $$
declare t record; v_id uuid; v_deal uuid; v_km uuid;
begin
  for t in select id from tenants loop
    select id into v_id from object_definitions where tenant_id = t.id and key = 'affarsmojlighet';
    if v_id is null then
      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, 'affarsmojlighet', 'Affärsmöjlighet', 'Affärsmöjligheter', 'target', 'name', 36, true)
      returning id into v_id;
    end if;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select v_id, t.id, f.key, f.label, f.typ, f.req, f.opt::jsonb, f.sort, f.vis
      from (values
        ('name',             'Namn',                      'text',      true,  '{"section":"grunduppgifter"}', 10, 'all'),
        ('produkt',          'Produkt',                   'select',    true,  '{"section":"grunduppgifter","_column":true,"_column_order":0,"choices":[{"key":"fiber","label":"Fiber"},{"key":"boendeapp_las","label":"Boendeapp och lås"},{"key":"hyresforhandling","label":"Hyresförhandling"},{"key":"tv","label":"TV-paket"},{"key":"annat","label":"Annat"}]}', 20, 'all'),
        ('saljare',          'Säljare',                   'user',      false, '{"section":"grunduppgifter","owner_field":true,"_column":true,"_column_order":1}', 30, 'all'),
        ('vantar_pa',        'Väntar på kunden',          'text',      false, '{"section":"grunduppgifter"}', 40, 'all'),
        ('forvantat_avslut', 'Förväntat avslut',          'date',      false, '{"section":"grunduppgifter"}', 50, 'all'),
        ('affarsvarde',      'Affärsvärde',               'currency',  false, '{"section":"grunduppgifter","code":"SEK"}', 60, 'all'),
        ('nasta_steg',       'Nästa steg',                'text',      false, '{"section":"uppfoljning"}', 70, 'all'),
        ('nasta_steg_datum', 'Nästa steg datum',          'date',      false, '{"section":"uppfoljning","_overdue":true,"_column":true,"_column_order":2}', 80, 'all'),
        ('senaste_kontakt',  'Senaste kontakt',           'datetime',  false, '{"section":"uppfoljning"}', 85, 'all'),
        ('signerad_datum',   'Signerad',                  'date',      false, '{"section":"avslut"}', 90, 'all'),
        ('projektledare',    'Projektledare',             'user',      false, '{"section":"avslut"}', 95, 'all'),
        ('forlorad_orsak',   'Orsak (förlorad)',          'text',      false, '{"section":"avslut"}', 100, 'all'),
        ('aterkom_datum',    'Återkom',                   'date',      false, '{"section":"avslut"}', 110, 'all'),
        ('anteckning',       'Säljarens anteckning',      'long_text', false, '{"section":"avslut"}', 120, 'all'),
        ('omfattning',       'Omfattning (summering)',    'json',      false, '{"section":"omfattning"}', 130, 'hidden'),
        ('fiber_fs_port_cat6','Byggnation CAT6 FS-port (totalt antal)', 'number', false, '{"section":"omfattning","min":0,"decimals":0}', 140, 'all'),
        ('telia_forfallodatum','Förfallodatum (Telias avtal)', 'date',  false, '{"section":"omfattning"}', 150, 'all'),
        ('telia_skickad',    'Skickat till Telia',        'datetime',  false, '{"section":"omfattning"}', 160, 'all'),
        ('telia_version',    'Version till Telia',        'number',    false, '{"section":"omfattning","min":0,"decimals":0}', 170, 'all'),
        ('telia_andrad',     'Ändrad efter utskick',      'boolean',   false, '{"section":"omfattning"}', 180, 'all')
      ) as f(key, label, typ, req, opt, sort, vis)
     where not exists (select 1 from field_definitions x where x.object_id = v_id and x.key = f.key);

    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    select v_id, t.id, s.key, s.label, s.color, s.ini, s.term, s.sort
      from (values ('kontakt',       'Kontakt etablerad', 'blue',  true,  false, 10),
                   ('mote',          'Möte genomfört',    'blue',  false, false, 20),
                   ('underlag',      'Underlag skickat',  'amber', false, false, 30),
                   ('avtal_skickat', 'Avtal skickat',     'amber', false, false, 40),
                   ('signerad',      'Avtal signerat',    'green', false, true,  50),
                   ('forlorad',      'Förlorad',          'slate', false, true,  60)) as s(key, label, color, ini, term, sort)
     where not exists (select 1 from status_definitions x where x.object_id = v_id and x.key = s.key);

    -- Samma behörigheter som på affären.
    insert into role_permissions (role_id, tenant_id, object_type, action, scope)
    select rp.role_id, rp.tenant_id, 'affarsmojlighet', rp.action, rp.scope
      from role_permissions rp
     where rp.tenant_id = t.id and rp.object_type = 'deal'
    on conflict do nothing;

    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
    select t.id, r.rel, r.fr, r.t, r.card, r.lf, r.lr, false
      from (values ('mojlighet_deal',     'affarsmojlighet', 'deal',         'many_to_one',  'Affär',        'Affärsmöjligheter'),
                   ('mojlighet_koncern',  'affarsmojlighet', 'koncernmoder', 'many_to_one',  'Kund',         'Affärsmöjligheter'),
                   ('mojlighet_property', 'affarsmojlighet', 'property',     'many_to_many', 'Fastigheter',  'Affärsmöjligheter'),
                   ('mojlighet_contact',  'affarsmojlighet', 'contact',      'many_to_many', 'Kontakter',    'Affärsmöjligheter')
           ) as r(rel, fr, t, card, lf, lr)
     where not exists (select 1 from relationship_definitions d where d.tenant_id = t.id and d.rel_type = r.rel);

    -- ── Koncernmoder och affär: kundtyper enligt mockupen, mötesbokare som användare, källa ──
    select id into v_km from object_definitions where tenant_id = t.id and key = 'koncernmoder';
    select id into v_deal from object_definitions where tenant_id = t.id and key = 'deal';

    update field_definitions set options = options || '{"choices":[
        {"key":"privat_fastighetsbolag","label":"Privat fastighetsbolag"},
        {"key":"kommunalt_fastighetsbolag","label":"Kommunalt fastighetsbolag"},
        {"key":"brf","label":"Bostadsrättsförening"},
        {"key":"bef_telia_oppen","label":"Befintlig Telia Öppen"},
        {"key":"bef_telia_stangt","label":"Befintlig Telia stängt"},
        {"key":"bef_telia_kollektiv","label":"Befintlig Telia Kollektiv"},
        {"key":"omsorgsbostader","label":"Omsorgsbostäder"},
        {"key":"studentbostader","label":"Studentbostäder"}]}'::jsonb,
        help_text = 'Befintlig Telia Öppen, Omsorgsbostäder och Studentbostäder har kontaktbegränsning och kan inte delas ut.'
     where object_id in (v_km, v_deal) and key = 'kundtyp';

    update field_definitions set field_type = 'user', help_text = null
     where object_id in (v_km, v_deal) and key = 'motesbokare' and field_type = 'text';

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select v_km, t.id, 'kalla', 'Källa', 'text', false, '{"section":"kontaktinfo"}'::jsonb, 95, 'all'
     where v_km is not null and not exists (select 1 from field_definitions x where x.object_id = v_km and x.key = 'kalla');

    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    select v_deal, t.id, 'kund', 'Kund', 'green', false, false, 95
     where v_deal is not null and not exists (select 1 from status_definitions x where x.object_id = v_deal and x.key = 'kund');
  end loop;
end $$;

-- ── 2. Kontaktbegränsning ─────────────────────────────────────────────────
create or replace function public.km_kontaktbegransning(p_kundtyp text) returns text
language sql immutable as $$
  select case p_kundtyp
    when 'bef_telia_oppen' then 'Befintlig Telia Öppen – kunden har redan Telia, kontaktas inte för fiber'
    when 'omsorgsbostader' then 'Omsorgsbostäder – kontaktas inte'
    when 'studentbostader' then 'Studentbostäder – kontaktas inte'
  end
$$;

-- ── 3. Utdelning: koncernmoder → affär (utökar km_till_affar med mötesbokare och delning) ──
create or replace function public.km_till_affar(p_km uuid, p_saljare uuid) returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare v_km records%rowtype; v_deal uuid; v_mb uuid; v_proc numeric;
begin
  select * into v_km from records where id = p_km and object_type = 'koncernmoder' and deleted_at is null;
  if not found then return null; end if;
  v_mb := nullif(v_km.data->>'motesbokare', '')::uuid;
  v_proc := nullif(v_km.data->>'procentsats_saljare', '')::numeric;

  select d.id into v_deal
    from relationships r join records d on d.id = r.from_record_id
   where r.rel_type = 'deal_for' and r.to_record_id = p_km and d.deleted_at is null
     and coalesce(d.status, '') not in ('avslutad_ej_aktuell')
   order by d.created_at desc limit 1;

  if v_deal is null then
    insert into records (tenant_id, object_type, data, status, owner_user_id)
    values (v_km.tenant_id, 'deal',
            jsonb_strip_nulls(jsonb_build_object('name', coalesce(v_km.data->>'name', 'Ny affär'), 'saljare', p_saljare,
              'motesbokare', v_mb, 'fordelning_saljare', v_proc, 'kundtyp', v_km.data->>'kundtyp')),
            'ej_kontaktad', p_saljare)
    returning id into v_deal;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_km.tenant_id, v_deal, p_km, 'deal_for');
    perform sys_logg(v_deal, 'Affären skapades när koncernmodern delades ut');
  else
    update records set data = data || jsonb_strip_nulls(jsonb_build_object('saljare', p_saljare, 'motesbokare', v_mb,
              'fordelning_saljare', v_proc, 'kundtyp', v_km.data->>'kundtyp')), owner_user_id = p_saljare
     where id = v_deal;
    perform sys_logg(v_deal, 'Affären flyttad till ny säljare vid utdelning');
  end if;

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  select v_km.tenant_id, v_deal, p.from_record_id, 'deal_property'
    from relationships p
   where p.rel_type = 'property_of' and p.to_record_id = p_km
     and not exists (select 1 from relationships x where x.rel_type = 'deal_property'
                        and x.from_record_id = v_deal and x.to_record_id = p.from_record_id)
     and not exists (select 1 from fmo_logg l where l.deal_id = v_deal and l.property_id = p.from_record_id
                        and l.status = 'ej_godkand');
  -- Möjligheterna i affären följer med till den nya säljaren.
  update records m set data = m.data || jsonb_build_object('saljare', p_saljare), owner_user_id = p_saljare
    from relationships r
   where r.rel_type = 'mojlighet_deal' and r.to_record_id = v_deal and m.id = r.from_record_id and m.deleted_at is null
     and coalesce(m.status, '') not in ('signerad', 'forlorad');
  return v_deal;
end $$;

/** Dela ut markerade koncernmödrar: säljare, mötesbokare (valfri) och affärsdelning (andel till
 *  säljaren i procent). Affären skapas av triggern km_saljare_till_affar. Kunder med
 *  kontaktbegränsning eller icke säljbara hoppas över och returneras i "hoppade". */
create or replace function public.km_dela_ut(p_ids uuid[], p_saljare uuid, p_motesbokare uuid default null, p_fordelning numeric default 100)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_km records%rowtype; v_n int := 0; v_hopp jsonb := '[]'::jsonb; v_deal uuid; v_affarer jsonb := '[]'::jsonb;
begin
  if p_saljare is null then raise exception 'Välj en säljare' using errcode = '22023'; end if;
  if public.my_scope('koncernmoder', 'update') is distinct from 'tenant' then
    raise exception 'Saknar behörighet att dela ut koncernmödrar' using errcode = '42501';
  end if;
  foreach v_id in array p_ids loop
    select * into v_km from records where id = v_id and object_type = 'koncernmoder' and tenant_id = my_tenant_id() and deleted_at is null;
    if not found then continue; end if;
    if (v_km.data->>'icke_saljbar')::boolean is true then
      v_hopp := v_hopp || jsonb_build_object('id', v_id, 'namn', v_km.data->>'name', 'orsak', 'Icke säljbar'); continue;
    end if;
    if km_kontaktbegransning(v_km.data->>'kundtyp') is not null then
      v_hopp := v_hopp || jsonb_build_object('id', v_id, 'namn', v_km.data->>'name', 'orsak', km_kontaktbegransning(v_km.data->>'kundtyp')); continue;
    end if;
    perform public.update_record(v_id, jsonb_strip_nulls(jsonb_build_object(
      'saljare', p_saljare, 'motesbokare', p_motesbokare,
      'procentsats_saljare', coalesce(p_fordelning, 100), 'procentsats_motesbokare', 100 - coalesce(p_fordelning, 100),
      'tilldelad_motesbokare', case when p_motesbokare is not null then to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD') end)));
    -- Triggern km_saljare_till_affar skapar affären när säljaren byts; vid samma säljare med ny
    -- mötesbokare/delning gör anropet här samma sak (idempotent).
    v_deal := km_till_affar(v_id, p_saljare);
    v_affarer := v_affarer || jsonb_build_object('km', v_id, 'deal', v_deal);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('utdelade', v_n, 'hoppade', v_hopp, 'affarer', v_affarer);
end $$;

-- ── 4. Registervyn: koncernmödrar med antal, datakvalitet, utdelning och affär ──
/** Filter: alla | ej_utdelade | utdelade | saknar_fastigheter | saknar_orgnr | icke_saljbara. */
create or replace function public.km_register(p_filter text default 'alla', p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_res jsonb;
begin
  if public.my_scope('koncernmoder', 'read') is null then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  with km as (
    select r.id, r.data->>'name' as namn, nullif(r.data->>'org_number','') as orgnr, r.data->>'kundtyp' as kundtyp,
           (r.data->>'icke_saljbar')::boolean is true as icke_saljbar,
           nullif(r.data->>'saljare','')::uuid as saljare, nullif(r.data->>'motesbokare','')::uuid as motesbokare,
           r.data->>'kalla' as kalla, r.data->>'tilldelad_saljare' as tilldelad, r.created_at, r.updated_at
      from records r
     where r.tenant_id = my_tenant_id() and r.object_type = 'koncernmoder' and r.deleted_at is null
       and (p_search is null or p_search = '' or r.title ilike '%' || p_search || '%' or r.data->>'org_number' ilike '%' || p_search || '%')
  ), fast as (
    select rel.to_record_id as km, count(*) as antal,
           sum(case when (p.data->>'antal_hushall') ~ '^\d+$' then (p.data->>'antal_hushall')::int else 0 end) as lgh
      from relationships rel join records p on p.id = rel.from_record_id and p.deleted_at is null and p.object_type = 'property'
     where rel.rel_type = 'property_of' group by 1
  ), aff as (
    select distinct on (rel.to_record_id) rel.to_record_id as km, d.id as deal, d.status, nullif(d.data->>'saljare','')::uuid as saljare
      from relationships rel join records d on d.id = rel.from_record_id and d.deleted_at is null and d.object_type = 'deal'
     where rel.rel_type = 'deal_for' order by rel.to_record_id, d.created_at desc
  ), reg as (
    -- Utdelad = säljare på koncernmodern, annars affärens säljare (äldre utdelningar sattes bara på affären).
    select km.id, km.namn, km.orgnr, km.kundtyp, km.icke_saljbar, coalesce(km.saljare, aff.saljare) as saljare, km.motesbokare,
           km.kalla, km.tilldelad, km.created_at, km.updated_at,
           coalesce(fast.antal, 0) as fastigheter, coalesce(fast.lgh, 0) as lgh, aff.deal, aff.status as deal_status,
           case when coalesce(fast.antal, 0) = 0 then 'saknar_fastigheter' when km.orgnr is null then 'saknar_orgnr' else 'komplett' end as kvalitet
      from km left join fast on fast.km = km.id left join aff on aff.km = km.id
  ), urval as (
    select x.* from reg x
     where case p_filter when 'ej_utdelade' then x.saljare is null and not x.icke_saljbar when 'utdelade' then x.saljare is not null
           when 'saknar_fastigheter' then x.fastigheter = 0 when 'saknar_orgnr' then x.orgnr is null
           when 'icke_saljbara' then x.icke_saljbar else true end
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(y) order by y.namn) from (
        select x.id, x.namn, x.orgnr, x.kundtyp, x.icke_saljbar, x.saljare, x.motesbokare, x.kalla, x.tilldelad,
               x.fastigheter, x.lgh, x.deal, x.deal_status, x.kvalitet, km_kontaktbegransning(x.kundtyp) as begransning
          from urval x order by x.namn limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset)) y), '[]'::jsonb),
    'total', (select count(*) from urval),
    'counts', (select jsonb_build_object(
        'alla', count(*), 'ej_utdelade', count(*) filter (where saljare is null and not icke_saljbar),
        'utdelade', count(*) filter (where saljare is not null), 'saknar_fastigheter', count(*) filter (where fastigheter = 0),
        'saknar_orgnr', count(*) filter (where orgnr is null), 'icke_saljbara', count(*) filter (where icke_saljbar)) from reg))
    into v_res;
  return v_res;
end $$;

-- ── 5. Registerkortet ──────────────────────────────────────────────────────
-- documents: kategori och version (fasta platser på möjligheten: offert, avtal, signerat_avtal, fullmakt; annars underlag/bolag …)
alter table public.documents add column if not exists kategori text;
alter table public.documents add column if not exists version int;

create or replace function public.km_kort(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_km records%rowtype; v_res jsonb;
begin
  select * into v_km from records where id = p_id and object_type = 'koncernmoder' and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then raise exception 'Koncernmodern finns inte' using errcode = 'P0002'; end if;
  select jsonb_build_object(
    'id', v_km.id, 'data', v_km.data, 'status', v_km.status, 'created_at', v_km.created_at, 'created_by', v_km.created_by,
    -- Bolagsstruktur: bolag kopplade direkt (direktagt_av/forvaltning_av) och bolag som äger/förvaltar koncernmoderns fastigheter.
    'bolag', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'namn', b.data->>'name', 'orgnr', b.data->>'org_number', 'typ', b.object_type,
                'fastigheter', (select count(*) from relationships pr join records p on p.id = pr.from_record_id and p.deleted_at is null
                                 where pr.rel_type in ('property_of_db','property_of_fb') and pr.to_record_id = b.id)) order by b.object_type, b.data->>'name')
              from records b
             where b.deleted_at is null and b.object_type in ('direktagt_bolag', 'forvaltningsbolag') and b.id in (
                select r.from_record_id from relationships r where r.rel_type in ('direktagt_av','forvaltning_av') and r.to_record_id = v_km.id
                union
                select pb.to_record_id from relationships pk join relationships pb on pb.from_record_id = pk.from_record_id and pb.rel_type in ('property_of_db','property_of_fb')
                 where pk.rel_type = 'property_of' and pk.to_record_id = v_km.id)), '[]'::jsonb),
    'fastigheter', (select jsonb_build_object('antal', count(*),
                'lgh', sum(case when (p.data->>'antal_hushall') ~ '^\d+$' then (p.data->>'antal_hushall')::int else 0 end),
                'lokaler', sum(case when (p.data->>'unit_count') ~ '^\d+$' and (p.data->>'antal_hushall') ~ '^\d+$'
                                     then greatest((p.data->>'unit_count')::int - (p.data->>'antal_hushall')::int, 0) else 0 end),
                'koax', count(*) filter (where coalesce(p.data->>'befintlig_koax','') not in ('', 'Saknas', '-', '–')),
                'fiber', count(*) filter (where coalesce(p.data->>'befintlig_fiber','') not in ('', 'Saknas', '-', '–')),
                'okand', count(*) filter (where coalesce(p.data->>'befintlig_koax','') in ('', '-', '–') and coalesce(p.data->>'befintlig_fiber','') in ('', '-', '–')))
              from relationships r join records p on p.id = r.from_record_id and p.deleted_at is null and p.object_type = 'property'
             where r.rel_type = 'property_of' and r.to_record_id = v_km.id),
    'dokument', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'namn', d.name, 'url', d.web_url, 'typ', d.kategori, 'datum', d.created_at) order by d.created_at desc)
              from document_links l join documents d on d.id = l.document_id where l.record_id = v_km.id), '[]'::jsonb),
    'affar', (select jsonb_build_object('id', d.id, 'status', d.status, 'saljare', d.data->>'saljare')
              from relationships r join records d on d.id = r.from_record_id and d.deleted_at is null and d.object_type = 'deal'
             where r.rel_type = 'deal_for' and r.to_record_id = v_km.id order by d.created_at desc limit 1),
    'kontakter', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'namn', c.data->>'name', 'titel', c.data->>'role_title', 'telefon', c.data->>'phone', 'epost', c.data->>'email') order by c.data->>'name')
              from relationships r join records c on c.id = r.from_record_id and c.deleted_at is null and c.object_type = 'contact'
             where r.rel_type = 'contact_of' and r.to_record_id = v_km.id), '[]'::jsonb),
    'begransning', km_kontaktbegransning(v_km.data->>'kundtyp')
  ) into v_res;
  return v_res;
end $$;

-- ── 6. Skapa affärsmöjlighet i en affär ──────────────────────────────────
create or replace function public.skapa_mojlighet(p_deal uuid, p_produkt text, p_namn text default null, p_status text default 'kontakt')
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_deal records%rowtype; v_km uuid; v_id uuid; v_namn text; v_antal int;
  v_label text := case p_produkt when 'fiber' then 'Fiber' when 'boendeapp_las' then 'Boendeapp och lås'
                      when 'hyresforhandling' then 'Hyresförhandling' when 'tv' then 'TV-paket' else 'Affärsmöjlighet' end;
begin
  select * into v_deal from records where id = p_deal and object_type = 'deal' and deleted_at is null and tenant_id = my_tenant_id();
  if not found then raise exception 'Affären finns inte' using errcode = 'P0002'; end if;
  if public.my_scope('affarsmojlighet', 'create') is null then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  select r.to_record_id into v_km from relationships r where r.rel_type = 'deal_for' and r.from_record_id = p_deal limit 1;
  select count(*) into v_antal from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
   where r.rel_type = 'deal_property' and r.from_record_id = p_deal;
  v_namn := coalesce(nullif(p_namn, ''), v_label || ' – ' || v_antal || ' fastigheter');

  insert into records (tenant_id, object_type, data, status, owner_user_id, created_by)
  values (v_deal.tenant_id, 'affarsmojlighet',
          jsonb_strip_nulls(jsonb_build_object('name', v_namn, 'produkt', p_produkt, 'saljare', nullif(v_deal.data->>'saljare','')::uuid)),
          p_status, v_deal.owner_user_id, auth.uid())
  returning id into v_id;
  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  select v_deal.tenant_id, v_id, x.to_id, x.rel from (values (p_deal, 'mojlighet_deal'), (v_km, 'mojlighet_koncern')) as x(to_id, rel) where x.to_id is not null;
  -- Alla affärens fastigheter följer med som bas (steg 1: välj bort dem som inte ska ingå).
  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type, data)
  select v_deal.tenant_id, v_id, r.to_record_id, 'mojlighet_property', '{"ingar": true}'::jsonb
    from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
   where r.rel_type = 'deal_property' and r.from_record_id = p_deal;
  perform sys_logg(v_id, 'Affärsmöjligheten skapades i affären');
  perform sys_logg(p_deal, 'Ny affärsmöjlighet: ' || v_namn);
  return v_id;
end $$;

-- ── 7. Signering av möjlighet: fiber → leveranser (affar_sald), affären blir Kund ──
create or replace function public.mojlighet_efter_andring() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_deal uuid;
begin
  if new.object_type <> 'affarsmojlighet' then return new; end if;
  if new.status = 'signerad' and old.status is distinct from 'signerad' then
    select r.to_record_id into v_deal from relationships r where r.rel_type = 'mojlighet_deal' and r.from_record_id = new.id limit 1;
    if new.data->>'signerad_datum' is null then
      update records set data = data || jsonb_build_object('signerad_datum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')) where id = new.id;
    end if;
    if v_deal is not null then
      if new.data->>'produkt' = 'fiber' then
        -- Bara fastigheter som ingår i möjligheten ska bli leveranser: synka affärens fastigheter först.
        perform affar_sald(v_deal);
      end if;
      update records set status = 'kund' where id = v_deal and coalesce(status, '') not in ('kund', 'avtal_signerat', 'onboarding');
      perform sys_logg(v_deal, 'Affärsmöjlighet signerad: ' || coalesce(new.data->>'name', ''));
    end if;
  end if;
  if new.status = 'forlorad' and old.status is distinct from 'forlorad' and nullif(new.data->>'aterkom_datum','') is not null then
    insert into tasks (tenant_id, record_id, title, description, assignee_user_id, due_at, created_by, created_source)
    values (new.tenant_id, new.id, 'Återkom: ' || coalesce(new.data->>'name', 'förlorad affär'),
            coalesce(new.data->>'forlorad_orsak', ''), new.owner_user_id, (new.data->>'aterkom_datum')::date, auth.uid(), 'workflow');
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_mojlighet_efter_andring') then
    create trigger trg_mojlighet_efter_andring after update of status on public.records
      for each row when (new.object_type = 'affarsmojlighet') execute function public.mojlighet_efter_andring();
  end if;
end $$;

-- ── 8. Befintliga affärer som kommit förbi "kontakt etablerad" får en fiber-möjlighet ──
do $$
declare d record; v_id uuid; v_status text; v_vantar text; v_antal int;
begin
  for d in
    select r.* from records r
     where r.object_type = 'deal' and r.deleted_at is null
       and r.status in ('kontakt_pdf_utskickad', 'kontakt_avtal_utskickat', 'invantar_fmo', 'invantar_hera', 'avtal_signerat', 'onboarding')
       and not exists (select 1 from relationships x join records m on m.id = x.from_record_id and m.deleted_at is null
                        where x.rel_type = 'mojlighet_deal' and x.to_record_id = r.id and m.data->>'produkt' = 'fiber')
  loop
    v_status := case d.status when 'kontakt_pdf_utskickad' then 'underlag' when 'kontakt_avtal_utskickat' then 'avtal_skickat'
                  when 'invantar_fmo' then 'underlag' when 'invantar_hera' then 'underlag' else 'signerad' end;
    v_vantar := case d.status when 'invantar_fmo' then 'FMO-svar från Telia' when 'invantar_hera' then 'HERA-svar från Telia' end;
    select count(*) into v_antal from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
     where r.rel_type = 'deal_property' and r.from_record_id = d.id;
    insert into records (tenant_id, object_type, data, status, owner_user_id, created_at)
    values (d.tenant_id, 'affarsmojlighet', jsonb_strip_nulls(jsonb_build_object(
              'name', 'Fiber – ' || v_antal || ' fastigheter', 'produkt', 'fiber', 'saljare', nullif(d.data->>'saljare','')::uuid,
              'vantar_pa', v_vantar, 'nasta_steg', d.data->>'nasta_steg', 'nasta_steg_datum', d.data->>'nasta_steg_datum',
              'signerad_datum', case when v_status = 'signerad' then to_char(d.updated_at at time zone 'Europe/Stockholm', 'YYYY-MM-DD') end)),
            v_status, d.owner_user_id, d.created_at)
    returning id into v_id;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    select d.tenant_id, v_id, x.to_id, x.rel from (
      select d.id as to_id, 'mojlighet_deal' as rel
      union all select r.to_record_id, 'mojlighet_koncern' from relationships r where r.rel_type = 'deal_for' and r.from_record_id = d.id limit 1) x;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type, data)
    select d.tenant_id, v_id, r.to_record_id, 'mojlighet_property', '{"ingar": true}'::jsonb
      from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
     where r.rel_type = 'deal_property' and r.from_record_id = d.id;
    perform sys_logg(v_id, 'Fiber-möjligheten skapades från affärens status (' || d.status || ') vid införandet av affärsmöjligheter');
  end loop;
end $$;
