-- Ärenden: felanmälningar från D2D-säljare (steg 1 — datamodellen).
--   * Kategorier för felanmälan (case_categories.felanmalan = true), med prioritet per underkategori.
--   * Källan "Door to door" (channel = 'd2d'), fälten Ärendenummer hos Telia, Bevakare, Anmäld av.
--   * Statusen "Väntar på Telia": SLA-klockan står still medan ärendet väntar, och deadline
--     flyttas fram med väntetiden när statusen lämnas (sla_paus_sek summerar all väntan).
--   * Koppling ärende → D2D-adress (d2d_fastighet).
--   * Inställningar: reservansvarig (när adressen saknar leveransansvarig) och standardbevakare.
--   * list_arenden: vyn "felanmalan", räknaren felanmalan, "Väntar på Telia" räknas som väntar
--     och pausade ärenden blir aldrig försenade. get_case: SLA visas inte som försenad under paus.
--   * RPC: case_set_telia, case_set_bevakare.

-- 1. Schema ---------------------------------------------------------------------------------
alter table public.case_categories add column if not exists felanmalan boolean not null default false;

create table if not exists public.case_felanmalan_installningar (
  tenant_id        uuid primary key references public.tenants(id) on delete cascade,
  reserv_ansvarig  uuid references public.users(id) on delete set null,
  bevakare         uuid[] not null default array[]::uuid[],
  updated_at       timestamptz not null default now()
);
alter table public.case_felanmalan_installningar enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'case_felanmalan_installningar' and policyname = 'tenant_read') then
    create policy tenant_read on public.case_felanmalan_installningar for select
      using (tenant_id = public.my_tenant_id());
  end if;
end $$;
grant select on public.case_felanmalan_installningar to authenticated;

-- 2. Data per tenant ------------------------------------------------------------------------
do $$
declare t record; v_obj uuid; v_lukas uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'case';
    if v_obj is null then continue; end if;

    insert into case_categories (tenant_id, key, parent_key, label, sort_order, default_priority, default_department_key, felanmalan) values
      (t.id, 'fel_fiber',               null,              'Fiber/nät',                          100, 'high',   'delivery', true),
      (t.id, 'fel_fiber_wan',           'fel_fiber',       'WAN-lampa lyser ej',                 101, 'high',   'delivery', true),
      (t.id, 'fel_fiber_signal',        'fel_fiber',       'Ingen signal',                       102, 'high',   'delivery', true),
      (t.id, 'fel_fiber_aktivering',    'fel_fiber',       'Ingen aktivering i nätet',           103, 'high',   'delivery', true),
      (t.id, 'fel_fiber_dosa_saknas',   'fel_fiber',       'Fiberdosa saknas',                   104, 'high',   'delivery', true),
      (t.id, 'fel_fiber_dosa_trasig',   'fel_fiber',       'Fiberdosa trasig eller lös',         105, 'high',   'delivery', true),
      (t.id, 'fel_fiber_strom',         'fel_fiber',       'Strömkabel till fiberdosa saknas',   106, 'high',   'delivery', true),
      (t.id, 'fel_fiber_patch',         'fel_fiber',       'Ej patchad / fel port',              107, 'high',   'delivery', true),
      (t.id, 'fel_installation',        null,              'Installationsfel',                   110, 'normal', 'delivery', true),
      (t.id, 'fel_inst_bom',            'fel_installation','Bominstallation',                    111, 'high',   'delivery', true),
      (t.id, 'fel_inst_tilltrade',      'fel_installation','Ej tillträde',                       112, 'normal', 'delivery', true),
      (t.id, 'fel_inst_ofullstandig',   'fel_installation','Ofullständig installation',          113, 'normal', 'delivery', true),
      (t.id, 'fel_inst_fel_lgh',        'fel_installation','Fel lägenhet installerad',           114, 'normal', 'delivery', true),
      (t.id, 'fel_inst_skador',         'fel_installation','Skador efter installation',          115, 'high',   'delivery', true),
      (t.id, 'fel_utrustning',          null,              'Utrustning',                         120, 'normal', 'delivery', true),
      (t.id, 'fel_utr_router_saknas',   'fel_utrustning',  'Router saknas / ej levererad',       121, 'normal', 'delivery', true),
      (t.id, 'fel_utr_router_trasig',   'fel_utrustning',  'Router trasig',                      122, 'normal', 'delivery', true),
      (t.id, 'fel_utr_tvbox',           'fel_utrustning',  'TV-box saknas eller trasig',         123, 'normal', 'delivery', true),
      (t.id, 'fel_utr_fel',             'fel_utrustning',  'Fel utrustning',                     124, 'normal', 'delivery', true),
      (t.id, 'fel_fastighet',           null,              'Fastighet',                          130, 'normal', 'delivery', true),
      (t.id, 'fel_fast_nodrum',         'fel_fastighet',   'Nodrum låst / ingen nyckel',         131, 'normal', 'delivery', true),
      (t.id, 'fel_fast_kabel',          'fel_fastighet',   'Kabeldragning saknas',               132, 'normal', 'delivery', true),
      (t.id, 'fel_fast_markning',       'fel_fastighet',   'Märkning saknas eller fel',          133, 'normal', 'delivery', true),
      (t.id, 'fel_fast_el',             'fel_fastighet',   'El i nodrum',                        134, 'high',   'delivery', true),
      (t.id, 'fel_adress',              null,              'Adress och data',                    140, 'normal', 'delivery', true),
      (t.id, 'fel_adr_telia',           'fel_adress',      'Adressen finns inte hos Telia',      141, 'normal', 'delivery', true),
      (t.id, 'fel_adr_lghnr',           'fel_adress',      'Fel lägenhetsnummer',                142, 'normal', 'delivery', true),
      (t.id, 'fel_adr_kundklar',        'fel_adress',      'Ej kundklar fast den borde vara det',143, 'normal', 'delivery', true),
      (t.id, 'fel_adr_fmo',             'fel_adress',      'FMO säger nej',                      144, 'normal', 'delivery', true),
      (t.id, 'fel_kund',                null,              'Kund/order',                         150, 'normal', 'delivery', true),
      (t.id, 'fel_kund_bekraftelse',    'fel_kund',        'Ingen orderbekräftelse',             151, 'normal', 'delivery', true),
      (t.id, 'fel_kund_tjanst',         'fel_kund',        'Fel tjänst aktiverad',               152, 'normal', 'delivery', true),
      (t.id, 'fel_kund_faktura',        'fel_kund',        'Faktura för tidigt',                 153, 'normal', 'delivery', true),
      (t.id, 'fel_ovrigt',              null,              'Annat fel',                          160, 'normal', 'delivery', true),
      (t.id, 'fel_ovr_annat',           'fel_ovrigt',      'Annat (beskriv i kommentaren)',      161, 'normal', 'delivery', true)
    on conflict (tenant_id, key) do nothing;
    perform public.sync_case_category_choices(t.id);

    -- Källan Door to door
    update field_definitions
       set options = jsonb_set(options, '{choices}', (options->'choices') || '[{"key":"d2d","label":"Door to door"}]'::jsonb)
     where object_id = v_obj and key = 'channel'
       and not (options->'choices') @> '[{"key":"d2d"}]'::jsonb;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility) values
      (v_obj, t.id, 'telia_arendenr',   'Ärendenummer hos Telia', 'text',     false, '{"section":"grunduppgifter"}', 27, 'all'),
      (v_obj, t.id, 'bevakare',         'Bevakare',               'json',     false, '{"section":"grunduppgifter","readonly":true}', 28, 'hidden'),
      (v_obj, t.id, 'anmald_av',        'Anmäld av',              'user',     false, '{"section":"grunduppgifter","readonly":true}', 29, 'all'),
      (v_obj, t.id, 'sla_pausad_sedan', 'SLA pausad sedan',       'datetime', false, '{"section":"sla","readonly":true}', 67, 'hidden'),
      (v_obj, t.id, 'sla_paus_sek',     'SLA paus (sekunder)',    'number',   false, '{"section":"sla","readonly":true}', 68, 'hidden')
    on conflict (object_id, key) do nothing;

    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
    values (v_obj, t.id, 'waiting_telia', 'Väntar på Telia', 'amber', false, false, 55)
    on conflict do nothing;

    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
    values (t.id, 'case_d2d_fastighet', 'case', 'd2d_fastighet', 'many_to_one', 'Adress (D2D)', 'Felanmälningar', false)
    on conflict (tenant_id, rel_type) do nothing;

    select id into v_lukas from users where tenant_id = t.id and full_name ilike 'lukas%' and is_active order by created_at limit 1;
    insert into case_felanmalan_installningar (tenant_id, reserv_ansvarig, bevakare)
    values (t.id, v_lukas, case when v_lukas is null then array[]::uuid[] else array[v_lukas] end)
    on conflict (tenant_id) do nothing;
  end loop;
end $$;

-- 3. Kategorivalen bär flaggan felanmalan (så formulären kan skilja dem åt) ------------------
create or replace function public.sync_case_category_choices(p_tenant uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_obj uuid;
begin
  select id into v_obj from object_definitions where tenant_id = p_tenant and key = 'case';
  if v_obj is null then return; end if;
  update field_definitions set options = (options - 'choices') || jsonb_build_object('choices', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'felanmalan', c.felanmalan) order by c.sort_order)
        from case_categories c where c.tenant_id = p_tenant and c.parent_key is null and c.is_active), '[]'::jsonb))
   where object_id = v_obj and key = 'category';
  update field_definitions set options = (options - 'choices') || jsonb_build_object('choices', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'parent', c.parent_key, 'felanmalan', c.felanmalan) order by c.sort_order)
        from case_categories c where c.tenant_id = p_tenant and c.parent_key is not null and c.is_active), '[]'::jsonb))
   where object_id = v_obj and key = 'subcategory';
end $function$;
select public.sync_case_category_choices(id) from tenants;

-- 4. Triggern: SLA-paus under "Väntar på Telia" ---------------------------------------------
create or replace function public.case_before_write()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_nr bigint; v_pol sla_policies%rowtype; v_new_ansv uuid; v_old_ansv uuid;
  v_prio text; v_old_prio text; v_start timestamptz; v_now text;
  v_paus interval; v_patch jsonb;
begin
  if new.object_type <> 'case' then return new; end if;
  v_now := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  if tg_op = 'INSERT' then
    if coalesce(new.data->>'case_number', '') = '' then
      insert into case_counters (tenant_id) values (new.tenant_id) on conflict do nothing;
      update case_counters set next_value = next_value + 1
       where tenant_id = new.tenant_id returning next_value - 1 into v_nr;
      new.data := new.data || jsonb_build_object('case_number', 'CE-' || v_nr);
    end if;
    if coalesce(new.data->>'priority', '') = '' then
      new.data := new.data || '{"priority":"normal"}';
    end if;
    if coalesce(new.data->>'ansvarig', '') = '' then
      new.owner_user_id := null;
    end if;
    if new.data->>'last_activity_at' is null then
      new.data := new.data || jsonb_build_object('last_activity_at', v_now);
    end if;
  end if;

  v_new_ansv := nullif(new.data->>'ansvarig', '')::uuid;
  v_old_ansv := case when tg_op = 'UPDATE' then nullif(old.data->>'ansvarig', '')::uuid end;
  if tg_op = 'INSERT' or v_new_ansv is distinct from v_old_ansv then
    new.owner_user_id := v_new_ansv;
  elsif tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
    new.data := new.data || jsonb_build_object('ansvarig', new.owner_user_id);
    v_new_ansv := new.owner_user_id;
  end if;

  if v_new_ansv is not null and new.status = 'new'
     and (tg_op = 'INSERT' or v_old_ansv is null) then
    new.status := 'assigned';
  elsif v_new_ansv is null and new.status = 'assigned' then
    new.status := 'new';
  end if;

  v_prio := coalesce(new.data->>'priority', 'normal');
  v_old_prio := case when tg_op = 'UPDATE' then coalesce(old.data->>'priority', 'normal') end;
  if tg_op = 'INSERT' or v_prio is distinct from v_old_prio
     or new.data->>'first_response_due_at' is null then
    select * into v_pol from sla_policies where tenant_id = new.tenant_id and priority = v_prio;
    if found then
      -- Tidigare väntan på Telia räknas inte (pågående väntan läggs på när den tar slut).
      v_start := coalesce(new.created_at, now())
               + make_interval(secs => coalesce(nullif(new.data->>'sla_paus_sek', '')::numeric, 0));
      new.data := new.data || jsonb_build_object(
        'first_response_due_at', to_char((v_start + v_pol.first_response) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'resolution_due_at',     to_char((v_start + v_pol.resolution)     at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    end if;
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'resolved' then
      new.data := new.data || jsonb_build_object('resolved_at', v_now, 'closed_at', null);
    elsif new.status = 'closed' then
      new.data := new.data || jsonb_build_object('closed_at', v_now)
               || case when new.data->>'resolved_at' is null then jsonb_build_object('resolved_at', v_now) else '{}'::jsonb end;
    elsif tg_op = 'UPDATE' and old.status in ('resolved', 'closed') then
      new.data := new.data || jsonb_build_object('resolved_at', null, 'closed_at', null);
    end if;

    -- Väntar på Telia: klockan står still. När statusen lämnas flyttas deadlines fram med väntetiden.
    if new.status = 'waiting_telia' then
      if nullif(new.data->>'sla_pausad_sedan', '') is null then
        new.data := new.data || jsonb_build_object('sla_pausad_sedan', v_now);
      end if;
    elsif tg_op = 'UPDATE' and old.status = 'waiting_telia' and nullif(new.data->>'sla_pausad_sedan', '') is not null then
      v_paus := greatest(now() - (new.data->>'sla_pausad_sedan')::timestamptz, interval '0');
      v_patch := jsonb_build_object('sla_paus_sek',
        coalesce(nullif(new.data->>'sla_paus_sek', '')::numeric, 0) + floor(extract(epoch from v_paus)));
      if nullif(new.data->>'resolution_due_at', '') is not null then
        v_patch := v_patch || jsonb_build_object('resolution_due_at', to_char(
          ((new.data->>'resolution_due_at')::timestamptz + v_paus) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
      end if;
      if nullif(new.data->>'first_response_due_at', '') is not null and nullif(new.data->>'first_response_at', '') is null then
        v_patch := v_patch || jsonb_build_object('first_response_due_at', to_char(
          ((new.data->>'first_response_due_at')::timestamptz + v_paus) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
      end if;
      new.data := (new.data - 'sla_pausad_sedan') || v_patch;
    end if;
  end if;

  return new;
end $function$;

-- 5. list_arenden och get_case (ändras på plats) ---------------------------------------------
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.list_arenden(text,text,text,text,text,text,text,integer,integer)'::regprocedure);
  if position('felanmalan' in d) = 0 then
    n := d;
    n := replace(n, $a$case when b.status in ('resolved', 'closed') then null$a$,
                    $a$case when b.status in ('resolved', 'closed', 'waiting_telia') then null$a$);
    n := replace(n, $a$when 'waiting' then s.status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')$a$,
                    $a$when 'waiting' then s.status in ('waiting_customer', 'waiting_internal', 'waiting_contractor', 'waiting_telia')
      when 'waiting_telia' then s.status = 'waiting_telia'
      when 'felanmalan' then s.data->>'channel' = 'd2d' and s.status not in ('resolved', 'closed')
      when 'felanmalan_alla' then s.data->>'channel' = 'd2d'$a$);
    n := replace(n, $a$'waiting',    count(*) filter (where status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')),$a$,
                    $a$'waiting',    count(*) filter (where status in ('waiting_customer', 'waiting_internal', 'waiting_contractor', 'waiting_telia')),
    'felanmalan', count(*) filter (where data->>'channel' = 'd2d' and status not in ('resolved', 'closed')),$a$);
    n := replace(n, $a$'overdue',    count(*) filter (where status not in ('resolved', 'closed')$a$,
                    $a$'overdue',    count(*) filter (where status not in ('resolved', 'closed', 'waiting_telia')$a$);
    if n = d or position($a$'felanmalan', count(*)$a$ in n) = 0 or position($a$'closed', 'waiting_telia') then null$a$ in n) = 0
       or position($a$not in ('resolved', 'closed', 'waiting_telia')$a$ in n) = 0 then
      raise exception 'list_arenden: texten att byta hittades inte';
    end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.get_case(uuid)'::regprocedure);
  if position('waiting_telia' in d) = 0 then
    n := replace(d, $a$'sla', jsonb_build_object($a$,
                    $a$'sla', case when c.status = 'waiting_telia' then jsonb_build_object('firstResponse', null, 'resolution', null, 'paused', true) else jsonb_build_object($a$);
    n := replace(n, $a$nullif(c.data->>'resolved_at', '')::timestamptz)),$a$,
                    $a$nullif(c.data->>'resolved_at', '')::timestamptz)) end,$a$);
    if position('paused' in n) = 0 or position($a$::timestamptz)) end,$a$ in n) = 0 then
      raise exception 'get_case: texten att byta hittades inte';
    end if;
    execute n;
  end if;
end $$;

-- 6. Ärendenummer hos Telia och bevakare -----------------------------------------------------
create or replace function public.case_set_telia(p_case uuid, p_nr text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare c records; v_nr text := nullif(trim(coalesce(p_nr, '')), '');
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null for update;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  if v_nr is not distinct from nullif(c.data->>'telia_arendenr', '') then return; end if;
  update records set data = data || jsonb_build_object('telia_arendenr', v_nr, 'last_activity_at', public.ce_iso(now()))
   where id = p_case;
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (c.tenant_id, p_case, 'field_change',
          case when v_nr is null then 'Ärendenummer hos Telia togs bort' else 'Ärendenummer hos Telia: ' || v_nr end,
          jsonb_build_object('field', 'telia_arendenr'), auth.uid(), 'user');
end $function$;
revoke all on function public.case_set_telia(uuid, text) from public, anon;
grant execute on function public.case_set_telia(uuid, text) to authenticated;

create or replace function public.case_set_bevakare(p_case uuid, p_users uuid[])
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare c records; v_ids uuid[]; v_names text;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null for update;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  select coalesce(array_agg(u.id order by u.full_name), array[]::uuid[]), string_agg(coalesce(u.full_name, u.email::text), ', ' order by u.full_name)
    into v_ids, v_names
    from users u where u.tenant_id = c.tenant_id and u.is_active and u.id = any(coalesce(p_users, array[]::uuid[]));
  if to_jsonb(v_ids) = coalesce(c.data->'bevakare', '[]'::jsonb) then return; end if;
  update records set data = data || jsonb_build_object('bevakare', to_jsonb(v_ids), 'last_activity_at', public.ce_iso(now()))
   where id = p_case;
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (c.tenant_id, p_case, 'field_change', 'Bevakare: ' || coalesce(v_names, 'inga'),
          jsonb_build_object('field', 'bevakare'), auth.uid(), 'user');
end $function$;
revoke all on function public.case_set_bevakare(uuid, uuid[]) from public, anon;
grant execute on function public.case_set_bevakare(uuid, uuid[]) to authenticated;
