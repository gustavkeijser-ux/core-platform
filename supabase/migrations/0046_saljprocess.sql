-- Ny säljprocess:
--  1) Ledningen delar ut koncernmödrar till säljare → en affär skapas (eller
--     får ny säljare) med alla fastigheter som tillhör koncernmodern.
--  2) FMO-check: säljaren skickar valda fastigheter; Telia (rollen "fmo")
--     svarar Godkänd/Ej godkänd per fastighet (bocka eller via fil).
--     Ej godkända tas bort ur affären (sparas i fmo_logg).
--  3) Affär → "Avtal signerat": en leverans per fastighet + uppstartsmöte.
--     Rutan Hyresförhandling på affären → koncernmodern i Hyresförhandlingar.
--  4) Projektplanen sparas rad för rad vid import och klär på leveranser som
--     skapas från affärer; efter 15 dagar utan träff varnar leveransen.

-- ── Hjälpare ────────────────────────────────────────────────────────────────
create or replace function public.norm_kommun(p text)
returns text language sql immutable as $$
  select nullif(lower(btrim(regexp_replace(coalesce(p, ''), '\s+kommun$', '', 'i'))), '')
$$;

/** Samma kommun/ort? "Stockholms kommun" = "Stockholm", "PITEÅ" = "Piteå". */
create or replace function public.samma_ort(a text, b text)
returns boolean language sql immutable as $$
  select norm_kommun(a) is not null and norm_kommun(b) is not null and (
    norm_kommun(a) = norm_kommun(b) or norm_kommun(a) = norm_kommun(b) || 's' or norm_kommun(a) || 's' = norm_kommun(b))
$$;

-- Händelse i postens tidslinje från systemet (fungerar även utan inloggning, t.ex. nattjobb).
create or replace function public.sys_logg(p_record uuid, p_text text)
returns void language sql security definer set search_path = public as $$
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  select r.tenant_id, r.id, 'note', p_text, '{"auto": true}'::jsonb, auth.uid(), 'system'
    from records r where r.id = p_record
$$;

-- ── 1. Utdelning av koncernmödrar ───────────────────────────────────────────
update field_definitions fd set options = fd.options || '{"owner_field": true}'::jsonb
  from object_definitions od
 where od.id = fd.object_id and od.key = 'koncernmoder' and fd.key = 'saljare'
   and fd.field_type = 'user';

create or replace function public.km_saljare_datum()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.data->>'saljare') is distinct from (old.data->>'saljare')
     and nullif(new.data->>'saljare', '') is not null then
    new.data := new.data || jsonb_build_object('tilldelad_saljare', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD'));
  end if;
  return new;
end $$;

create or replace trigger trg_km_saljare_datum
  before update on public.records
  for each row when (new.object_type = 'koncernmoder')
  execute function public.km_saljare_datum();

/** Koncernmodern har fått en säljare → säljarens affär med alla fastigheterna. */
create or replace function public.km_till_affar(p_km uuid, p_saljare uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_km records%rowtype; v_deal uuid;
begin
  select * into v_km from records where id = p_km and object_type = 'koncernmoder' and deleted_at is null;
  if not found then return null; end if;

  select d.id into v_deal
    from relationships r join records d on d.id = r.from_record_id
   where r.rel_type = 'deal_for' and r.to_record_id = p_km and d.deleted_at is null
     and coalesce(d.status, '') not in ('avslutad_ej_aktuell', 'avtal_signerat', 'onboarding')
   order by d.created_at desc limit 1;

  if v_deal is null then
    insert into records (tenant_id, object_type, data, status, owner_user_id)
    values (v_km.tenant_id, 'deal',
            jsonb_build_object('name', coalesce(v_km.data->>'name', 'Ny affär'), 'saljare', p_saljare),
            'ej_kontaktad', p_saljare)
    returning id into v_deal;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (v_km.tenant_id, v_deal, p_km, 'deal_for');
    perform sys_logg(v_deal, 'Affären skapades när koncernmodern delades ut');
  else
    update records set data = data || jsonb_build_object('saljare', p_saljare), owner_user_id = p_saljare
     where id = v_deal;
  end if;

  -- Alla koncernmoderns fastigheter som inte redan ligger i affären.
  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  select v_km.tenant_id, v_deal, p.from_record_id, 'deal_property'
    from relationships p
   where p.rel_type = 'property_of' and p.to_record_id = p_km
     and not exists (select 1 from relationships x where x.rel_type = 'deal_property'
                        and x.from_record_id = v_deal and x.to_record_id = p.from_record_id)
     and not exists (select 1 from fmo_logg l where l.deal_id = v_deal and l.property_id = p.from_record_id
                        and l.status = 'ej_godkand');
  return v_deal;
end $$;

-- FMO-loggen behövs av km_till_affar (borttagna fastigheter läggs inte tillbaka).
create table if not exists public.fmo_logg (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  deal_id     uuid not null references public.records(id) on delete cascade,
  property_id uuid not null references public.records(id) on delete cascade,
  status      text not null check (status in ('skickad', 'godkand', 'ej_godkand', 'angrad')),
  kommentar   text,
  av          uuid references public.users(id) on delete set null,
  tid         timestamptz not null default now()
);
create index if not exists fmo_logg_deal_idx on public.fmo_logg (deal_id, tid desc);
alter table public.fmo_logg enable row level security;

create or replace function public.km_saljare_till_affar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.data->>'saljare') is distinct from (old.data->>'saljare')
     and (new.data->>'saljare') ~* '^[0-9a-f-]{36}$' then
    perform km_till_affar(new.id, (new.data->>'saljare')::uuid);
  end if;
  return new;
end $$;

create or replace trigger trg_km_saljare_till_affar
  after update of data on public.records
  for each row when (new.object_type = 'koncernmoder')
  execute function public.km_saljare_till_affar();

-- ── 2. FMO-check ────────────────────────────────────────────────────────────
-- Rollen för Telia: ingen åtkomst till objekten, bara FMO-vyn via funktionerna.
insert into roles (tenant_id, key, name)
select t.id, 'fmo', 'FMO (Telia)' from tenants t
 where not exists (select 1 from roles r where r.tenant_id = t.id and r.key = 'fmo');

create or replace function public.is_fmo()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                  where ur.user_id = auth.uid() and r.key = 'fmo' and r.tenant_id = my_tenant_id())
$$;
grant execute on function public.is_fmo() to authenticated;

/** Säljaren skickar valda fastigheter i affären på FMO-check. */
create or replace function public.fmo_skicka(p_deal uuid, p_properties uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_deal records%rowtype; v_n integer;
begin
  select * into v_deal from records where id = p_deal and object_type = 'deal' and tenant_id = my_tenant_id() and deleted_at is null;
  if not found or not can_row('deal', 'update', v_deal.owner_user_id) then
    raise exception 'Saknar behörighet till affären' using errcode = '42501';
  end if;

  with upd as (
    update relationships r
       set data = coalesce(r.data, '{}'::jsonb) || jsonb_build_object('fmo', jsonb_build_object(
             'status', 'skickad', 'skickad', now(), 'skickad_av', auth.uid()))
     where r.rel_type = 'deal_property' and r.from_record_id = p_deal and r.to_record_id = any(p_properties)
       and coalesce(r.data->'fmo'->>'status', '') not in ('skickad', 'godkand')
    returning r.to_record_id
  ), logg as (
    insert into fmo_logg (tenant_id, deal_id, property_id, status, av)
    select v_deal.tenant_id, p_deal, to_record_id, 'skickad', auth.uid() from upd
    returning 1
  )
  select count(*) into v_n from logg;

  if v_n > 0 then
    update records
       set data = data || case when status = 'invantar_fmo' then '{}'::jsonb
                               else jsonb_build_object('fmo_forra_status', status) end,
           status = 'invantar_fmo'
     where id = p_deal;
    perform sys_logg(p_deal, v_n || ' fastighet' || case when v_n = 1 then '' else 'er' end || ' skickade på FMO-check');
  end if;
  return v_n;
end $$;
grant execute on function public.fmo_skicka(uuid, uuid[]) to authenticated;

/** Ångra en skickad fastighet (innan svar). */
create or replace function public.fmo_angra(p_deal uuid, p_properties uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_deal records%rowtype; v_n integer;
begin
  select * into v_deal from records where id = p_deal and object_type = 'deal' and tenant_id = my_tenant_id() and deleted_at is null;
  if not found or not can_row('deal', 'update', v_deal.owner_user_id) then
    raise exception 'Saknar behörighet till affären' using errcode = '42501';
  end if;
  with upd as (
    update relationships r set data = r.data - 'fmo'
     where r.rel_type = 'deal_property' and r.from_record_id = p_deal and r.to_record_id = any(p_properties)
       and r.data->'fmo'->>'status' = 'skickad'
    returning r.to_record_id
  ), logg as (
    insert into fmo_logg (tenant_id, deal_id, property_id, status, av)
    select v_deal.tenant_id, p_deal, to_record_id, 'angrad', auth.uid() from upd returning 1
  )
  select count(*) into v_n from logg;
  perform fmo_klar_om_klart(p_deal);
  return v_n;
end $$;
grant execute on function public.fmo_angra(uuid, uuid[]) to authenticated;

/** Inga fastigheter väntar på svar längre → tillbaka till förra statusen. */
create or replace function public.fmo_klar_om_klart(p_deal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_deal records%rowtype; v_godk int; v_bort int;
begin
  select * into v_deal from records where id = p_deal;
  if exists (select 1 from relationships r where r.rel_type = 'deal_property' and r.from_record_id = p_deal
                and r.data->'fmo'->>'status' = 'skickad') then
    return;
  end if;
  if v_deal.status = 'invantar_fmo' then
    select count(*) filter (where r.data->'fmo'->>'status' = 'godkand') into v_godk
      from relationships r where r.rel_type = 'deal_property' and r.from_record_id = p_deal;
    select count(*) into v_bort from fmo_logg l
     where l.deal_id = p_deal and l.status = 'ej_godkand'
       and l.tid > coalesce((select max(tid) from fmo_logg x where x.deal_id = p_deal and x.status = 'skickad') - interval '1 second', '-infinity');
    update records
       set status = coalesce(nullif(data->>'fmo_forra_status', ''), 'kontakt_hogt_intresse'),
           data = (data - 'fmo_forra_status') || jsonb_build_object('fmo_klar', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD'))
     where id = p_deal;
    perform sys_logg(p_deal, 'FMO-check klar: ' || v_godk || ' godkända, ' || v_bort || ' borttagna ur affären');
  end if;
end $$;

/** Telias lista: fastigheter på FMO-check (öppna = väntar på svar). */
create or replace function public.fmo_lista(p_filter text default 'oppna')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_admin() or is_fmo() or my_scope('deal', 'read') = 'tenant') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'skickad' desc, x->>'koncernmoder', x->>'fastighet')
      from (
        select jsonb_build_object(
          'id', r.id, 'dealId', d.id, 'affar', d.data->>'name',
          'koncernmoder', km.data->>'name', 'orgnr', km.data->>'org_number',
          'propertyId', p.id, 'fastighet', coalesce(p.data->>'name', p.data->>'fastighetsbeteckning_komplett'),
          'fastighetKomplett', p.data->>'fastighetsbeteckning_komplett',
          'adress', p.data->>'street_address', 'postnummer', p.data->>'postal_code',
          'ort', coalesce(p.data->>'city', p.data->>'municipality'), 'kommun', p.data->>'municipality',
          'hushall', coalesce(p.data->>'antal_hushall', p.data->>'unit_count'),
          'status', r.data->'fmo'->>'status', 'skickad', r.data->'fmo'->>'skickad',
          'besvarad', r.data->'fmo'->>'besvarad', 'kommentar', r.data->'fmo'->>'kommentar',
          'saljare', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = d.owner_user_id)) x
          from relationships r
          join records d on d.id = r.from_record_id and d.deleted_at is null
          join records p on p.id = r.to_record_id and p.deleted_at is null
          left join relationships kr on kr.from_record_id = d.id and kr.rel_type = 'deal_for'
          left join records km on km.id = kr.to_record_id
         where r.rel_type = 'deal_property' and r.tenant_id = my_tenant_id()
           and r.data ? 'fmo'
           and (p_filter = 'alla' or r.data->'fmo'->>'status' = 'skickad')
      ) s), '[]'::jsonb);
end $$;
grant execute on function public.fmo_lista(text) to authenticated;

/** Svar från FMO: [{id, status: godkand|ej_godkand, kommentar}] (id = rad i fmo_lista). */
create or replace function public.fmo_svara(p_svar jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_s jsonb; v_r relationships%rowtype; v_deal records%rowtype; v_status text;
        v_godk int := 0; v_bort int := 0; v_hopp int := 0; v_deals uuid[] := '{}';
begin
  for v_s in select * from jsonb_array_elements(coalesce(p_svar, '[]'::jsonb)) loop
    v_status := v_s->>'status';
    if v_status not in ('godkand', 'ej_godkand') then v_hopp := v_hopp + 1; continue; end if;
    select * into v_r from relationships where id = (v_s->>'id')::uuid and rel_type = 'deal_property' and tenant_id = my_tenant_id();
    if not found then v_hopp := v_hopp + 1; continue; end if;
    select * into v_deal from records where id = v_r.from_record_id;
    if not (is_admin() or is_fmo()) then
      raise exception 'Saknar behörighet att svara på FMO-check' using errcode = '42501';
    end if;

    insert into fmo_logg (tenant_id, deal_id, property_id, status, kommentar, av)
    values (v_r.tenant_id, v_r.from_record_id, v_r.to_record_id, v_status, nullif(v_s->>'kommentar', ''), auth.uid());

    if v_status = 'godkand' then
      update relationships
         set data = coalesce(data, '{}'::jsonb) || jsonb_build_object('fmo', coalesce(data->'fmo', '{}'::jsonb) || jsonb_build_object(
               'status', 'godkand', 'besvarad', now(), 'kommentar', nullif(v_s->>'kommentar', '')))
       where id = v_r.id;
      v_godk := v_godk + 1;
    else
      -- Inte godkänd av FMO → fastigheten ingår inte längre i affären.
      delete from relationships where id = v_r.id;
      v_bort := v_bort + 1;
    end if;
    if not v_r.from_record_id = any(v_deals) then v_deals := v_deals || v_r.from_record_id; end if;
  end loop;

  for i in 1 .. coalesce(array_length(v_deals, 1), 0) loop
    perform fmo_klar_om_klart(v_deals[i]);
  end loop;
  return jsonb_build_object('godkanda', v_godk, 'borttagna', v_bort, 'hoppade', v_hopp, 'affarer', coalesce(array_length(v_deals, 1), 0));
end $$;
grant execute on function public.fmo_svara(jsonb) to authenticated;

/** Affärens FMO-historik (inkl. borttagna fastigheter) för fliken på affären. */
create or replace function public.fmo_logg_for(p_deal uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_owner uuid;
begin
  select owner_user_id into v_owner from records where id = p_deal and tenant_id = my_tenant_id();
  if not found or not can_row('deal', 'read', v_owner) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'propertyId', l.property_id, 'fastighet', coalesce(p.data->>'name', p.data->>'fastighetsbeteckning_komplett'),
      'status', l.status, 'kommentar', l.kommentar, 'tid', l.tid,
      'av', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = l.av)) order by l.tid desc)
    from fmo_logg l join records p on p.id = l.property_id where l.deal_id = p_deal), '[]'::jsonb);
end $$;
grant execute on function public.fmo_logg_for(uuid) to authenticated;

-- ── 4a. Projektplanen rad för rad ──────────────────────────────────────────
create table if not exists public.projektplan_rader (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  beteckning  text not null,   -- upper(btrim(...))
  ort         text not null default '',
  data        jsonb not null,  -- leveransfält enligt projektplan_faltkarta
  status      text,
  senast_sedd timestamptz not null default now(),
  primary key (tenant_id, beteckning, ort)
);
alter table public.projektplan_rader enable row level security;

/** Leta upp fastigheten i projektplanen: beteckning + samma ort/kommun. */
create or replace function public.projektplan_rad_for(p_tenant uuid, p_beteckning text, p_ort text, p_kommun text)
returns projektplan_rader language sql stable security definer set search_path = public as $$
  select pr.* from projektplan_rader pr
   where pr.tenant_id = p_tenant and pr.beteckning = upper(btrim(coalesce(p_beteckning, '')))
     and (samma_ort(pr.ort, p_ort) or samma_ort(pr.ort, p_kommun)
          or samma_ort(pr.data->>'kommun', p_kommun) or samma_ort(pr.data->>'kommun', p_ort))
   order by pr.senast_sedd desc limit 1
$$;

-- ── 3. Såld affär → leveranser + uppstartsmöte ────────────────────────────
insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
select t.id, 'delivery_deal', 'delivery', 'deal', 'many_to_one', 'Affär', 'Leveranser', false
  from tenants t
 where exists (select 1 from object_definitions o where o.tenant_id = t.id and o.key = 'delivery')
   and not exists (select 1 from relationship_definitions d where d.tenant_id = t.id and d.rel_type = 'delivery_deal');

/** Klär på en leverans med projektplanens rad (om fastigheten finns där). */
create or replace function public.leverans_fran_projektplan(p_delivery uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_d records%rowtype; v_rad projektplan_rader;
begin
  select * into v_d from records where id = p_delivery;
  v_rad := projektplan_rad_for(v_d.tenant_id, v_d.data->>'fastighetsbeteckning', v_d.data->>'ort', v_d.data->>'kommun');
  if v_rad.beteckning is null then return false; end if;
  update records
     set data = data || (v_rad.data - 'name') || jsonb_build_object('projektplan_varning', false, 'projektplan_matchad', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')),
         status = coalesce(v_rad.status, status)
   where id = p_delivery;
  return true;
end $$;

create or replace function public.affar_sald(p_deal uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_deal records%rowtype; v_km records%rowtype; v_p record; v_lev uuid; v_ny int := 0; v_kopp int := 0;
        v_bet text; v_kommun text; v_ort text;
begin
  select * into v_deal from records where id = p_deal and object_type = 'deal';
  select km.* into v_km from relationships r join records km on km.id = r.to_record_id
   where r.from_record_id = p_deal and r.rel_type = 'deal_for' limit 1;

  -- Uppstartsmöte (ett per affär)
  if not exists (select 1 from relationships r join records u on u.id = r.from_record_id and u.deleted_at is null
                  where r.rel_type = 'uppstart_deal' and r.to_record_id = p_deal) then
    with u as (
      insert into records (tenant_id, object_type, data, status, owner_user_id)
      values (v_deal.tenant_id, 'uppstartsmote',
              jsonb_build_object('name', 'Uppstartsmöte – ' || coalesce(v_km.data->>'name', v_deal.data->>'name', '')),
              'planerat', v_deal.owner_user_id)
      returning id
    )
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    select v_deal.tenant_id, u.id, x.to_id, x.rel from u,
      (values (p_deal, 'uppstart_deal'), (v_km.id, 'uppstart_koncern')) as x(to_id, rel)
     where x.to_id is not null;
  end if;

  -- En leverans per fastighet i affären
  for v_p in
    select p.* from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
     where r.rel_type = 'deal_property' and r.from_record_id = p_deal
  loop
    v_bet := initcap(lower(coalesce(v_p.data->>'name', '')));
    v_kommun := v_p.data->>'municipality';
    v_ort := coalesce(nullif(v_p.data->>'city', ''), v_kommun);
    v_lev := null;

    -- Finns redan en leverans för fastigheten (kopplad, eller samma beteckning + ort)?
    select d.id into v_lev
      from records d
     where d.tenant_id = v_deal.tenant_id and d.object_type = 'delivery' and d.deleted_at is null
       and (exists (select 1 from relationships x where x.rel_type = 'delivery_property' and x.from_record_id = d.id and x.to_record_id = v_p.id)
            or (upper(btrim(coalesce(d.data->>'fastighetsbeteckning', ''))) = upper(btrim(v_bet))
                and (samma_ort(d.data->>'ort', v_ort) or samma_ort(d.data->>'kommun', v_kommun) or samma_ort(d.data->>'ort', v_kommun))))
     order by d.created_at limit 1;

    if v_lev is null then
      insert into records (tenant_id, object_type, data, status)
      values (v_deal.tenant_id, 'delivery', jsonb_strip_nulls(jsonb_build_object(
          'name', v_bet || coalesce(' – ' || v_ort, ''),
          'fastighetsbeteckning', v_bet, 'ort', v_ort, 'kommun', v_kommun,
          'adress', v_p.data->>'street_address', 'postnummer', v_p.data->>'postal_code',
          'fastighetsagare', v_km.data->>'name', 'orgnr', v_km.data->>'org_number',
          'lagenheter', case when (v_p.data->>'antal_hushall') ~ '^\d+$' then (v_p.data->>'antal_hushall')::int end,
          'saljare_ce', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = v_deal.owner_user_id),
          'fran_affar_datum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD'),
          'projektplan_varning', false)), 'signerat_avtal')
      returning id into v_lev;
      v_ny := v_ny + 1;
      perform leverans_fran_projektplan(v_lev);
    else
      v_kopp := v_kopp + 1;
    end if;

    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    select v_deal.tenant_id, v_lev, x.to_id, x.rel
      from (values (v_p.id, 'delivery_property'), (v_km.id, 'delivery_for'), (p_deal, 'delivery_deal')) as x(to_id, rel)
     where x.to_id is not null
       and not exists (select 1 from relationships y where y.from_record_id = v_lev and y.to_record_id = x.to_id and y.rel_type = x.rel)
       and not (x.rel = 'delivery_for' and exists (select 1 from relationships y where y.from_record_id = v_lev and y.rel_type = 'delivery_for'));

    update records set status = 'contracted' where id = v_p.id and coalesce(status, 'prospect') = 'prospect';
  end loop;

  if v_km.id is not null then
    update records set status = 'active' where id = v_km.id and coalesce(status, 'prospect') = 'prospect';
  end if;
  perform sys_logg(p_deal, 'Affären såld: ' || v_ny || ' nya leveranser, ' || v_kopp || ' befintliga kopplade, uppstartsmöte skapat');
  return jsonb_build_object('nya', v_ny, 'kopplade', v_kopp);
end $$;

-- Hyresförhandling: ny objekttyp + ruta på affären
do $$
declare t record; v_id uuid;
begin
  for t in select id from tenants loop
    if not exists (select 1 from object_definitions where tenant_id = t.id and key = 'deal') then continue; end if;
    if not exists (select 1 from object_definitions where tenant_id = t.id and key = 'hyresforhandling') then
      insert into object_definitions (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order, is_active)
      values (t.id, 'hyresforhandling', 'Hyresförhandling', 'Hyresförhandlingar', 'scale', 'name', 42, true)
      returning id into v_id;
      insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order) values
        (v_id, t.id, 'name',      'Namn',      'text',      true,  '{"section":"grunduppgifter","_column":false}', 10),
        (v_id, t.id, 'datum',     'Datum',     'date',      false, '{"section":"grunduppgifter","_column":true,"_column_order":0}', 20),
        (v_id, t.id, 'ansvarig',  'Ansvarig',  'user',      false, '{"section":"grunduppgifter","_column":true,"_column_order":1}', 30),
        (v_id, t.id, 'kommentar', 'Kommentar', 'long_text', false, '{"section":"ovrigt","_column":true,"_column_order":2}', 40);
      insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order) values
        (v_id, t.id, 'ej_paborjad', 'Ej påbörjad', 'slate', true,  false, 10),
        (v_id, t.id, 'pagaende',    'Pågående',    'blue',  false, false, 20),
        (v_id, t.id, 'klar',        'Klar',        'green', false, true,  30),
        (v_id, t.id, 'avbruten',    'Avbruten',    'red',   false, true,  40);
      insert into role_permissions (role_id, tenant_id, object_type, action, scope)
      select rp.role_id, rp.tenant_id, 'hyresforhandling', rp.action, rp.scope
        from role_permissions rp where rp.tenant_id = t.id and rp.object_type = 'deal'
      on conflict do nothing;
    end if;

    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
    select t.id, r.rel_type, 'hyresforhandling', r.tobj, 'many_to_one', r.lf, 'Hyresförhandlingar', false
      from (values ('hyresf_koncern', 'koncernmoder', 'Kund'), ('hyresf_deal', 'deal', 'Affär')) as r(rel_type, tobj, lf)
     where not exists (select 1 from relationship_definitions d where d.tenant_id = t.id and d.rel_type = r.rel_type);

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select od.id, t.id, 'hyresforhandling', 'Hyresförhandling', 'boolean', false,
           '{"help":"Bocka i så hamnar koncernmodern i Hyresförhandlingar"}'::jsonb, 45
      from object_definitions od
     where od.tenant_id = t.id and od.key = 'deal'
       and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'hyresforhandling');

    -- Leveranser: från affär + varning för projektplanen
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
    select od.id, t.id, v.key, v.label, v.typ, false, v.opts, v.sort
      from object_definitions od
     cross join (values
       ('fran_affar_datum', 'Skapad från affär', 'date', '{"section":"projektplan"}'::jsonb, 5),
       ('projektplan_varning', 'Saknas i projektplanen', 'boolean', '{"section":"projektplan","_column":true,"_column_order":99}'::jsonb, 6),
       ('projektplan_matchad', 'Hittad i projektplanen', 'date', '{"section":"projektplan"}'::jsonb, 7)
     ) as v(key, label, typ, opts, sort)
     where od.tenant_id = t.id and od.key = 'delivery'
       and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);
  end loop;
end $$;

create or replace function public.affar_hyresforhandling(p_deal uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_deal records%rowtype; v_km records%rowtype; v_id uuid;
begin
  select * into v_deal from records where id = p_deal;
  select r.from_record_id into v_id from relationships r join records h on h.id = r.from_record_id and h.deleted_at is null
   where r.rel_type = 'hyresf_deal' and r.to_record_id = p_deal limit 1;
  if v_id is not null then return v_id; end if;
  select km.* into v_km from relationships r join records km on km.id = r.to_record_id
   where r.from_record_id = p_deal and r.rel_type = 'deal_for' limit 1;
  insert into records (tenant_id, object_type, data, status, owner_user_id)
  values (v_deal.tenant_id, 'hyresforhandling',
          jsonb_build_object('name', 'Hyresförhandling – ' || coalesce(v_km.data->>'name', v_deal.data->>'name', '')),
          'ej_paborjad', v_deal.owner_user_id)
  returning id into v_id;
  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  select v_deal.tenant_id, v_id, x.to_id, x.rel
    from (values (p_deal, 'hyresf_deal'), (v_km.id, 'hyresf_koncern')) as x(to_id, rel) where x.to_id is not null;
  perform sys_logg(p_deal, 'Koncernmodern lagd i Hyresförhandlingar');
  return v_id;
end $$;

create or replace function public.deal_efter_andring()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'avtal_signerat' and old.status is distinct from 'avtal_signerat' then
    perform affar_sald(new.id);
  end if;
  if (new.data->>'hyresforhandling')::boolean is true
     and (old.data->>'hyresforhandling')::boolean is not true then
    perform affar_hyresforhandling(new.id);
  end if;
  return new;
end $$;

create or replace trigger trg_deal_efter_andring
  after update on public.records
  for each row when (new.object_type = 'deal')
  execute function public.deal_efter_andring();

-- ── 4b. Varning: leverans från affär som inte syns i projektplanen ──────────
create or replace function public.projektplan_varningar()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer := 0; v_d record;
begin
  for v_d in
    select d.id from records d
     where d.object_type = 'delivery' and d.deleted_at is null
       and d.data ? 'fran_affar_datum' and nullif(d.data->>'projektplan_matchad', '') is null
  loop
    if not leverans_fran_projektplan(v_d.id) then
      update records
         set data = data || jsonb_build_object('projektplan_varning',
                    (data->>'fran_affar_datum')::date < (now() at time zone 'Europe/Stockholm')::date - 15)
       where id = v_d.id
         and (data->>'projektplan_varning')::boolean is distinct from ((data->>'fran_affar_datum')::date < (now() at time zone 'Europe/Stockholm')::date - 15);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

-- Varje natt (även när ingen projektplan importeras räknas de 15 dagarna).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('projektplan-varningar', '15 3 * * *', 'select public.projektplan_varningar()');
  end if;
end $$;

-- Importen sparar varje rad och klär på leveranser från affärer
-- (även när orten i projektplanen skrivs annorlunda än i CRM:et).
do $mig$
declare d text;
  a1 text := '    v_status := v_skarta ->> coalesce(v_data->>''projektplan_status'', '''');';
  a2 text := '    if v_id is null then
      if not p_dry_run then
        insert into records (tenant_id, object_type, data, status)';
  a3 text := '    v_kopplade := _koppla_leveranser(v_tenant);';
begin
  d := pg_get_functiondef('public.ingest_projektplan'::regproc);
  if position('projektplan_rader' in d) > 0 then return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 then
    raise exception 'ingest_projektplan: hittar inte insättningspunkterna';
  end if;
  d := replace(d, a1, a1 || '
    if not p_dry_run then
      insert into projektplan_rader (tenant_id, beteckning, ort, data, status, senast_sedd)
      values (v_tenant, upper(v_bet), upper(coalesce(v_ort, '''')), v_data, v_status, now())
      on conflict (tenant_id, beteckning, ort) do update
        set data = excluded.data, status = excluded.status, senast_sedd = now();
    end if;');
  d := replace(d, a2, '    if v_id is null then
      -- Leverans skapad från en affär: samma beteckning, ort skriven annorlunda.
      select r.id, r.data, r.status into v_id, v_fore, v_forestatus
        from records r
       where r.tenant_id = v_tenant and r.object_type = ''delivery'' and r.deleted_at is null
         and r.data ? ''fran_affar_datum''
         and upper(btrim(coalesce(r.data->>''fastighetsbeteckning'',''''))) = upper(v_bet)
         and (samma_ort(r.data->>''ort'', v_ort) or samma_ort(r.data->>''kommun'', v_ort)
              or samma_ort(r.data->>''kommun'', v_data->>''kommun''))
       limit 1;
      if v_id is not null then
        v_data := v_data || jsonb_build_object(''projektplan_varning'', false,
                    ''projektplan_matchad'', to_char(now() at time zone ''Europe/Stockholm'', ''YYYY-MM-DD''));
      end if;
    end if;

' || a2);
  d := replace(d, a3, a3 || '
    perform projektplan_varningar();');
  execute d;
end $mig$;

-- FMO-svaret ligger på kopplingen affär–fastighet (data.fmo). Lyft affär-fliken
-- sparar hela kopplingens data → behåll fmo när den inte skickas med.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.set_relation_data'::regproc);
  if position('''fmo''' in d) > 0 then return; end if;
  if position('     set data = p_data' in d) = 0 then raise exception 'set_relation_data: hittar inte raden'; end if;
  d := replace(d, '     set data = p_data', '     set data = case when data ? ''fmo'' and not p_data ? ''fmo''
                     then p_data || jsonb_build_object(''fmo'', data->''fmo'') else p_data end');
  execute d;
end $mig$;
