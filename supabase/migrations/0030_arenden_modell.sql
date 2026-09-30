-- Ärendehantering v1 – datamodell.
--
-- Bygger vidare på det befintliga objektet "case" (records + field/status-
-- definitioner) i stället för ett separat ticketsystem. Allt är additivt;
-- de enda borttagningarna är konfiguration som ingen post använder
-- (status "waiting", prioritet "low").
--
--   * Statusar:   new, assigned, in_progress, waiting_customer,
--                 waiting_internal, waiting_contractor, resolved, closed
--   * Prioritet:  normal (default), high, critical, urgent
--   * Källa:      befintligt fält "channel" (email, phone, app, web, sms, internal, api)
--   * Kategorier: tabellen case_categories (kategori → underkategori) är
--                 källan; valen i fälten category/subcategory genereras därifrån.
--   * SLA:        tabellen sla_policies (per prioritet) → first_response_due_at,
--                 resolution_due_at sätts av triggern case_before_write.
--   * Ärendenr:   CE-10001, CE-10002 … via case_counters (atomiskt per tenant).
--   * Ansvarig:   fältet "ansvarig" (user, owner_field) speglas till owner_user_id.
--   * Audit:      trigger skriver status/ansvarig/prioritet/kategori till audit_log;
--                 audit_log blir append-only.
--   * Hyresgästens namn lagras inte — bara e-postadressen (kund_epost).

-- ---------------------------------------------------------------------------
-- 1. Konfigurationstabeller
-- ---------------------------------------------------------------------------
create table if not exists public.case_categories (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  key                    text not null,
  parent_key             text,
  label                  text not null,
  sort_order             int  not null default 0,
  default_priority       text,
  default_department_key text,          -- förberett: Kategori → Team
  default_assignee_id    uuid references public.users(id) on delete set null, -- förberett: Team → Användare
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  unique (tenant_id, key),
  constraint case_categories_key_format check (key ~ '^[a-z][a-z0-9_]*$')
);

create table if not exists public.sla_policies (
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  priority           text not null,
  first_response     interval not null,
  resolution         interval not null,
  warn_ratio         numeric(3,2) not null default 0.25,  -- 🟡 när < 25 % av tiden återstår
  primary key (tenant_id, priority)
);

create table if not exists public.case_counters (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  next_value bigint not null default 10001
);

alter table public.case_categories enable row level security;
alter table public.sla_policies    enable row level security;
alter table public.case_counters   enable row level security;

drop policy if exists tenant_read on public.case_categories;
create policy tenant_read on public.case_categories for select
  using (tenant_id = my_tenant_id());
drop policy if exists tenant_read on public.sla_policies;
create policy tenant_read on public.sla_policies for select
  using (tenant_id = my_tenant_id());
-- case_counters: ingen policy = ingen direktåtkomst.

grant select on public.case_categories, public.sla_policies to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Seed per tenant: kategorier, SLA, statusar, fält, relationer, roll
-- ---------------------------------------------------------------------------
do $$
declare t record; v_obj uuid; v_role uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'case';
    if v_obj is null then continue; end if;

    -- Kategorier
    insert into case_categories (tenant_id, key, parent_key, label, sort_order, default_department_key) values
      (t.id, 'internet',                  null,           'Internet',               10, 'support'),
      (t.id, 'internet_fungerar_inte',    'internet',     'Internet fungerar inte', 11, null),
      (t.id, 'internet_langsamt',         'internet',     'Långsamt internet',      12, null),
      (t.id, 'internet_wifi',             'internet',     'WiFi',                   13, null),
      (t.id, 'internet_router',           'internet',     'Router',                 14, null),
      (t.id, 'internet_anslutning',       'internet',     'Anslutning',             15, null),
      (t.id, 'installation',              null,           'Installation',           20, 'delivery'),
      (t.id, 'installation_installation', 'installation', 'Installation',           21, null),
      (t.id, 'installation_ombokning',    'installation', 'Ombokning',              22, null),
      (t.id, 'installation_ej_tilltrade', 'installation', 'Ej tillträde',           23, null),
      (t.id, 'installation_fraga',        'installation', 'Installationsfråga',     24, null),
      (t.id, 'tv',                        null,           'TV',                     30, 'support'),
      (t.id, 'tv_fungerar_inte',          'tv',           'TV fungerar inte',       31, null),
      (t.id, 'tv_fraga',                  'tv',           'TV-fråga',               32, null),
      (t.id, 'tv_utrustning',             'tv',           'Utrustning',             33, null),
      (t.id, 'ovrigt',                    null,           'Övrigt',                 90, 'support'),
      (t.id, 'ovrigt_fraga',              'ovrigt',       'Fråga',                  91, null),
      (t.id, 'ovrigt_information',        'ovrigt',       'Information',            92, null),
      (t.id, 'ovrigt_annat',              'ovrigt',       'Annat',                  93, null)
    on conflict (tenant_id, key) do nothing;

    -- SLA (kalendertid)
    insert into sla_policies (tenant_id, priority, first_response, resolution) values
      (t.id, 'normal',   interval '24 hours', interval '5 days'),
      (t.id, 'high',     interval '8 hours',  interval '2 days'),
      (t.id, 'critical', interval '4 hours',  interval '1 day'),
      (t.id, 'urgent',   interval '1 hour',   interval '8 hours')
    on conflict do nothing;

    insert into case_counters (tenant_id) values (t.id) on conflict do nothing;

    -- Statusar
    update status_definitions set label = 'Ny', color = 'blue', sort_order = 10, is_initial = true, is_terminal = false
     where object_id = v_obj and key = 'new';
    update status_definitions set label = 'Pågår', color = 'amber', sort_order = 30, is_terminal = false
     where object_id = v_obj and key = 'in_progress';
    update status_definitions set label = 'Löst', color = 'green', sort_order = 70, is_terminal = true
     where object_id = v_obj and key = 'resolved';
    update status_definitions set label = 'Stängd', color = 'zinc', sort_order = 80, is_terminal = true
     where object_id = v_obj and key = 'closed';
    insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order) values
      (v_obj, t.id, 'assigned',           'Tilldelad',          'indigo', false, false, 20),
      (v_obj, t.id, 'waiting_customer',   'Väntar kund',        'violet', false, false, 40),
      (v_obj, t.id, 'waiting_internal',   'Väntar internt',     'sky',    false, false, 50),
      (v_obj, t.id, 'waiting_contractor', 'Väntar entreprenör', 'orange', false, false, 60)
    on conflict (object_id, key) do nothing;
    -- "waiting" ersätts av de tre väntestatusarna (ingen post använder den).
    delete from status_definitions sd
     where sd.object_id = v_obj and sd.key = 'waiting'
       and not exists (select 1 from records r where r.tenant_id = t.id and r.object_type = 'case' and r.status = 'waiting');

    -- Befintliga fält
    update field_definitions set label = 'Ämne', sort_order = 10,
           options = options || '{"section":"grunduppgifter"}'
     where object_id = v_obj and key = 'name';
    update field_definitions set label = 'Ärendenummer', sort_order = 5,
           options = options || '{"section":"grunduppgifter","readonly":true}'
     where object_id = v_obj and key = 'case_number';
    update field_definitions set label = 'Prioritet', sort_order = 30,
           options = jsonb_build_object('section','grunduppgifter','choices', jsonb_build_array(
             jsonb_build_object('key','normal','label','Normal'),
             jsonb_build_object('key','high','label','Hög'),
             jsonb_build_object('key','critical','label','Kritisk'),
             jsonb_build_object('key','urgent','label','Akut')))
     where object_id = v_obj and key = 'priority';
    update field_definitions set label = 'Källa', sort_order = 40,
           options = jsonb_build_object('section','grunduppgifter','choices', jsonb_build_array(
             jsonb_build_object('key','email','label','E-post'),
             jsonb_build_object('key','phone','label','Telefon'),
             jsonb_build_object('key','app','label','App'),
             jsonb_build_object('key','web','label','Webb'),
             jsonb_build_object('key','sms','label','SMS'),
             jsonb_build_object('key','internal','label','Intern'),
             jsonb_build_object('key','api','label','API'),
             jsonb_build_object('key','partner','label','Partner')))
     where object_id = v_obj and key = 'channel';
    update field_definitions set label = 'Kategori', sort_order = 20
     where object_id = v_obj and key = 'category';
    -- Ersätts av väntestatusarna — göms, tas inte bort.
    update field_definitions set visibility = 'hidden' where object_id = v_obj and key = 'waiting_on';
    update field_definitions set label = 'Lösning', sort_order = 200 where object_id = v_obj and key = 'resolution';

    -- Nya fält
    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility) values
      (v_obj, t.id, 'subcategory',           'Underkategori',          'select',   false, '{"section":"grunduppgifter","choices":[]}', 21, 'all'),
      (v_obj, t.id, 'ansvarig',              'Ansvarig',               'user',     false, '{"section":"grunduppgifter","owner_field":true}', 25, 'all'),
      (v_obj, t.id, 'team',                  'Team',                   'select',   false, '{"section":"grunduppgifter","choices":[{"key":"support","label":"Kundtjänst"},{"key":"delivery","label":"Leverans"},{"key":"sales","label":"Sälj"},{"key":"management","label":"Admin/Ledning"}]}', 26, 'all'),
      (v_obj, t.id, 'kund_epost',            'Kundens e-post',         'email',    false, '{"section":"kund"}', 50, 'all'),
      (v_obj, t.id, 'kund_telefon',          'Kundens telefon',        'phone',    false, '{"section":"kund"}', 51, 'all'),
      (v_obj, t.id, 'fastighet_namn',        'Fastighet',              'text',     false, '{"section":"kund","readonly":true}', 52, 'all'),
      (v_obj, t.id, 'lagenhet_namn',         'Lägenhet',               'text',     false, '{"section":"kund","readonly":true}', 53, 'all'),
      (v_obj, t.id, 'first_response_due_at', 'Första svar senast',     'datetime', false, '{"section":"sla","readonly":true}', 60, 'all'),
      (v_obj, t.id, 'resolution_due_at',     'Lösning senast',         'datetime', false, '{"section":"sla","readonly":true,"_overdue":true}', 61, 'all'),
      (v_obj, t.id, 'first_response_at',     'Första svar',            'datetime', false, '{"section":"sla","readonly":true}', 62, 'all'),
      (v_obj, t.id, 'resolved_at',           'Löst',                   'datetime', false, '{"section":"sla","readonly":true}', 63, 'all'),
      (v_obj, t.id, 'closed_at',             'Stängd',                 'datetime', false, '{"section":"sla","readonly":true}', 64, 'all'),
      (v_obj, t.id, 'last_activity_at',      'Senaste aktivitet',      'datetime', false, '{"section":"sla","readonly":true}', 65, 'all'),
      (v_obj, t.id, 'last_inbound_at',       'Senaste inkommande',     'datetime', false, '{"section":"sla","readonly":true}', 66, 'hidden'),
      (v_obj, t.id, 'mailbox',               'Brevlåda',               'text',     false, '{"section":"ovrigt","readonly":true}', 90, 'hidden'),
      (v_obj, t.id, 'reopened_from',         'Fortsättning på ärende', 'text',     false, '{"section":"ovrigt","readonly":true}', 91, 'hidden')
    on conflict (object_id, key) do nothing;

    -- Relationer: kund blir valfri (inkommande mejl har ingen känd koncern).
    update relationship_definitions set is_required = false where tenant_id = t.id and rel_type = 'case_for';
    update relationship_definitions set label_forward = 'Koncern' where tenant_id = t.id and rel_type = 'case_for';
    insert into relationship_definitions (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required) values
      (t.id, 'case_lagenhet',    'case', 'd2d_lagenhet',      'many_to_one', 'Lägenhet',         'Ärenden', false),
      (t.id, 'case_forvaltning', 'case', 'forvaltningsbolag', 'many_to_one', 'Förvaltningsbolag','Ärenden', false),
      (t.id, 'case_direktagt',   'case', 'direktagt_bolag',   'many_to_one', 'Direktägt bolag',  'Ärenden', false),
      (t.id, 'case_d2d_projekt', 'case', 'd2d_projekt',       'many_to_one', 'D2D-projekt',      'Ärenden', false)
    on conflict (tenant_id, rel_type) do nothing;

    -- Roll: Kundtjänst (ser och hanterar ärenden; ser inte alla D2D-lägenheter)
    select id into v_role from roles where tenant_id = t.id and key = 'kundtjanst';
    if v_role is null then
      insert into roles (tenant_id, key, name, description)
      values (t.id, 'kundtjanst', 'Kundtjänst', 'Hanterar hyresgästärenden')
      returning id into v_role;
    end if;
    insert into role_permissions (role_id, tenant_id, object_type, action, scope)
    select v_role, t.id, p.o, p.a, 'tenant'
      from (values ('case','read'),('case','create'),('case','update'),
                   ('property','read'),('delivery','read'),('koncernmoder','read'),
                   ('forvaltningsbolag','read'),('direktagt_bolag','read'),('d2d_projekt','read'),
                   ('task','read'),('task','create'),('task','update'),
                   ('activity','read'),('activity','create')) as p(o, a)
     where not exists (select 1 from role_permissions rp
                        where rp.role_id = v_role and rp.object_type = p.o and rp.action = p.a);

    -- Aron och Anton → Kundtjänst (+ avdelningen Kundtjänst)
    insert into user_roles (user_id, role_id, tenant_id)
    select u.id, v_role, t.id from users u
     where u.tenant_id = t.id
       and lower(u.email::text) in ('aron@connectestate.se', 'anton.haggberg@connectestate.se')
       and not exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role_id = v_role);
    insert into department_members (department_id, user_id, tenant_id, is_lead)
    select d.id, u.id, t.id, false
      from users u join departments d on d.tenant_id = t.id and d.key = 'support'
     where u.tenant_id = t.id
       and lower(u.email::text) in ('aron@connectestate.se', 'anton.haggberg@connectestate.se')
       and not exists (select 1 from department_members dm where dm.user_id = u.id and dm.department_id = d.id);

    -- Testposten CE-0001: mappa bort den gamla kategorin.
    update records set data = data || '{"category":"internet","subcategory":"internet_fungerar_inte"}'
     where tenant_id = t.id and object_type = 'case' and data->>'category' = 'fault';
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Kategorival genereras från case_categories
-- ---------------------------------------------------------------------------
create or replace function public.sync_case_category_choices(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_obj uuid;
begin
  select id into v_obj from object_definitions where tenant_id = p_tenant and key = 'case';
  if v_obj is null then return; end if;
  update field_definitions set options = (options - 'choices') || jsonb_build_object('choices', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label) order by c.sort_order)
        from case_categories c where c.tenant_id = p_tenant and c.parent_key is null and c.is_active), '[]'::jsonb))
   where object_id = v_obj and key = 'category';
  update field_definitions set options = (options - 'choices') || jsonb_build_object('choices', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'parent', c.parent_key) order by c.sort_order)
        from case_categories c where c.tenant_id = p_tenant and c.parent_key is not null and c.is_active), '[]'::jsonb))
   where object_id = v_obj and key = 'subcategory';
end $$;
revoke all on function public.sync_case_category_choices(uuid) from public, anon, authenticated;

select public.sync_case_category_choices(id) from tenants;

-- ---------------------------------------------------------------------------
-- 4. SLA-beräkning
-- ---------------------------------------------------------------------------
/** 'met' | 'ok' | 'warning' | 'breached' | null — för ett deadline-par. */
create or replace function public.case_sla_state(p_start timestamptz, p_due timestamptz, p_done timestamptz,
                                                 p_warn_ratio numeric default 0.25)
returns text language sql stable as $$
  select case
    when p_due is null then null
    when p_done is not null then case when p_done <= p_due then 'met' else 'breached' end
    when now() > p_due then 'breached'
    when p_start is not null and p_due > p_start
         and (p_due - now()) < (p_due - p_start) * p_warn_ratio then 'warning'
    when p_start is null and p_due - now() < interval '2 hours' then 'warning'
    else 'ok'
  end
$$;

-- ---------------------------------------------------------------------------
-- 5. Trigger: ärendenummer, ansvarig ↔ owner, SLA, tidsstämplar, auto-status
-- ---------------------------------------------------------------------------
create or replace function public.case_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_nr bigint; v_pol sla_policies%rowtype; v_new_ansv uuid; v_old_ansv uuid;
  v_prio text; v_old_prio text; v_start timestamptz; v_now text;
begin
  if new.object_type <> 'case' then return new; end if;
  v_now := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  if tg_op = 'INSERT' then
    -- Ärendenummer (om det inte redan satts)
    if coalesce(new.data->>'case_number', '') = '' then
      insert into case_counters (tenant_id) values (new.tenant_id) on conflict do nothing;
      update case_counters set next_value = next_value + 1
       where tenant_id = new.tenant_id returning next_value - 1 into v_nr;
      new.data := new.data || jsonb_build_object('case_number', 'CE-' || v_nr);
    end if;
    if coalesce(new.data->>'priority', '') = '' then
      new.data := new.data || '{"priority":"normal"}';
    end if;
    -- Ett nytt ärende är otilldelat tills någon tilldelas uttryckligen
    -- (create_record sätter annars skaparen som ägare).
    if coalesce(new.data->>'ansvarig', '') = '' then
      new.owner_user_id := null;
    end if;
    if new.data->>'last_activity_at' is null then
      new.data := new.data || jsonb_build_object('last_activity_at', v_now);
    end if;
  end if;

  -- Ansvarig ↔ owner_user_id (samma mönster som affärernas säljare)
  v_new_ansv := nullif(new.data->>'ansvarig', '')::uuid;
  v_old_ansv := case when tg_op = 'UPDATE' then nullif(old.data->>'ansvarig', '')::uuid end;
  if tg_op = 'INSERT' or v_new_ansv is distinct from v_old_ansv then
    new.owner_user_id := v_new_ansv;
  elsif tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id then
    new.data := new.data || jsonb_build_object('ansvarig', new.owner_user_id);
    v_new_ansv := new.owner_user_id;
  end if;

  -- Auto-status vid tilldelning
  if v_new_ansv is not null and new.status = 'new'
     and (tg_op = 'INSERT' or v_old_ansv is null) then
    new.status := 'assigned';
  elsif v_new_ansv is null and new.status = 'assigned' then
    new.status := 'new';
  end if;

  -- SLA: beräknas vid skapande och när prioriteten ändras
  v_prio := coalesce(new.data->>'priority', 'normal');
  v_old_prio := case when tg_op = 'UPDATE' then coalesce(old.data->>'priority', 'normal') end;
  if tg_op = 'INSERT' or v_prio is distinct from v_old_prio
     or new.data->>'first_response_due_at' is null then
    select * into v_pol from sla_policies where tenant_id = new.tenant_id and priority = v_prio;
    if found then
      v_start := coalesce(new.created_at, now());
      new.data := new.data || jsonb_build_object(
        'first_response_due_at', to_char((v_start + v_pol.first_response) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'resolution_due_at',     to_char((v_start + v_pol.resolution)     at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    end if;
  end if;

  -- Tidsstämplar för löst/stängd; återöppning nollställer
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'resolved' then
      new.data := new.data || jsonb_build_object('resolved_at', v_now, 'closed_at', null);
    elsif new.status = 'closed' then
      new.data := new.data || jsonb_build_object('closed_at', v_now)
               || case when new.data->>'resolved_at' is null then jsonb_build_object('resolved_at', v_now) else '{}'::jsonb end;
    elsif tg_op = 'UPDATE' and old.status in ('resolved', 'closed') then
      new.data := new.data || jsonb_build_object('resolved_at', null, 'closed_at', null);
    end if;
  end if;

  return new;
end $$;

drop trigger if exists trg_case_before_write on public.records;
create trigger trg_case_before_write
  before insert or update on public.records
  for each row when (new.object_type = 'case')
  execute function public.case_before_write();

-- ---------------------------------------------------------------------------
-- 6. Audit: viktiga ändringar på ärenden, och audit_log blir append-only
-- ---------------------------------------------------------------------------
create or replace function public.case_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_before jsonb := '{}'; v_after jsonb := '{}'; k text;
begin
  if new.object_type <> 'case' then return null; end if;
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      v_before := v_before || jsonb_build_object('status', old.status);
      v_after  := v_after  || jsonb_build_object('status', new.status);
    end if;
    if new.owner_user_id is distinct from old.owner_user_id then
      v_before := v_before || jsonb_build_object('ansvarig', old.owner_user_id);
      v_after  := v_after  || jsonb_build_object('ansvarig', new.owner_user_id);
    end if;
    foreach k in array array['priority','category','subcategory','team','kund_epost','name'] loop
      if (new.data->k) is distinct from (old.data->k) then
        v_before := v_before || jsonb_build_object(k, old.data->k);
        v_after  := v_after  || jsonb_build_object(k, new.data->k);
      end if;
    end loop;
    if v_after = '{}'::jsonb then return null; end if;
  else
    v_after := jsonb_build_object('status', new.status, 'case_number', new.data->>'case_number',
                                  'channel', new.data->>'channel', 'priority', new.data->>'priority');
  end if;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, before, after)
  values (new.tenant_id, case when auth.uid() is null then 'integration' else 'user' end, auth.uid(),
          case when tg_op = 'INSERT' then 'case.created' else 'case.updated' end,
          'case', new.id, nullif(v_before, '{}'::jsonb), v_after);
  return null;
end $$;

drop trigger if exists trg_case_audit on public.records;
create trigger trg_case_audit
  after insert or update on public.records
  for each row when (new.object_type = 'case')
  execute function public.case_audit();

create or replace function public.audit_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log kan inte ändras eller raderas' using errcode = '42501';
end $$;
drop trigger if exists trg_audit_log_immutable on public.audit_log;
create trigger trg_audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.audit_log_immutable();
revoke update, delete, truncate on public.audit_log from anon, authenticated;
