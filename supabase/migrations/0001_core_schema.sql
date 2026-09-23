-- =============================================================================
-- 0001 — Kärnschema (Supabase)
-- =============================================================================
--
-- Skillnader mot en fristående Postgres:
--   * users hänger på auth.users istället för att vara egen identitetstabell
--   * tenant_id läses ur JWT, inte ur en sessionsvariabel
--   * RLS och skrivväg ligger i 0002 och 0003
--
-- KONVENTIONER
--   Identifierare på engelska, kommentarer på svenska.
--   Domänobjekt (kund, projekt, ärende) ligger generiskt i `records`.
--   Tvärgående objekt (aktivitet, uppgift, mail, dokument) är hårdtypade.
-- =============================================================================

create extension if not exists citext;
create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- Tenants och identitet
-- -----------------------------------------------------------------------------

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       citext not null unique,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  constraint tenants_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
);

-- Profil kopplad till Supabase Auth. tenant_id speglar app_metadata i JWT.
-- Sanningen bor i JWT eftersom RLS läser därifrån; den här kolumnen finns
-- för joins och för att kunna lista en tenants användare.
create table public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete restrict,
  email         citext not null,
  full_name     text not null default '',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, email)
);

create index on public.users (tenant_id) where deleted_at is null;

create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  key        text not null,
  name       text not null,
  sort_order int not null default 0,
  unique (tenant_id, key),
  constraint departments_key_format check (key ~ '^[a-z][a-z0-9_]*$')
);

create table public.department_members (
  department_id uuid not null references public.departments(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  is_lead       boolean not null default false,
  primary key (department_id, user_id)
);

create index on public.department_members (user_id);
create index on public.department_members (tenant_id);

-- -----------------------------------------------------------------------------
-- Roller och behörigheter
-- -----------------------------------------------------------------------------

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null,
  name        text not null,
  description text,
  unique (tenant_id, key)
);

-- object_type pekar antingen på object_definitions.key eller på ett kärnobjekt
-- ('task', 'activity', 'communication', 'document', 'user', 'role', 'metadata')
-- eller på '*'. Därför text och inte en foreign key.
create table public.role_permissions (
  role_id     uuid not null references public.roles(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  object_type text not null,
  action      text not null,
  scope       text not null default 'own',
  primary key (role_id, object_type, action),
  constraint role_permissions_action check
    (action in ('read', 'create', 'update', 'delete', 'export')),
  constraint role_permissions_scope check
    (scope in ('own', 'department', 'tenant'))
);

create index on public.role_permissions (tenant_id);

create table public.user_roles (
  user_id   uuid not null references public.users(id) on delete cascade,
  role_id   uuid not null references public.roles(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  primary key (user_id, role_id)
);

create index on public.user_roles (role_id);
create index on public.user_roles (tenant_id);

-- -----------------------------------------------------------------------------
-- Metadata — det som gör systemet konfigurerbart per företag
-- -----------------------------------------------------------------------------

create table public.object_definitions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  key            text not null,
  label_singular text not null,
  label_plural   text not null,
  icon           text,
  title_field    text not null default 'name',
  sort_order     int not null default 0,
  is_active      boolean not null default true,
  unique (tenant_id, key),
  constraint object_definitions_key_format check (key ~ '^[a-z][a-z0-9_]*$')
);

create table public.field_definitions (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references public.object_definitions(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null,
  label       text not null,
  field_type  text not null,
  is_required boolean not null default false,
  is_unique   boolean not null default false,
  options     jsonb not null default '{}'::jsonb,
  help_text   text,
  visibility  text not null default 'all',
  sort_order  int not null default 0,
  unique (object_id, key),
  constraint field_definitions_key_format check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint field_definitions_type check (field_type in (
    'text', 'long_text', 'number', 'currency', 'percent',
    'date', 'datetime', 'boolean', 'select', 'multi_select',
    'user', 'email', 'phone', 'url', 'address', 'json')),
  constraint field_definitions_visibility check
    (visibility in ('all', 'department', 'restricted'))
);

create index on public.field_definitions (tenant_id);

create table public.relationship_definitions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  rel_type      text not null,
  from_object   text not null,
  to_object     text not null,
  cardinality   text not null default 'many_to_one',
  label_forward text not null,
  label_reverse text not null,
  is_required   boolean not null default false,
  unique (tenant_id, rel_type),
  constraint relationship_definitions_cardinality check (cardinality in
    ('one_to_one', 'many_to_one', 'one_to_many', 'many_to_many'))
);

create table public.status_definitions (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references public.object_definitions(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null,
  label       text not null,
  color       text,
  is_initial  boolean not null default false,
  is_terminal boolean not null default false,
  sort_order  int not null default 0,
  unique (object_id, key)
);

create index on public.status_definitions (tenant_id);
create unique index status_definitions_one_initial
  on public.status_definitions (object_id) where is_initial;

-- -----------------------------------------------------------------------------
-- Records — alla domänobjekt
-- -----------------------------------------------------------------------------

create table public.records (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  object_type   text not null,
  data          jsonb not null default '{}'::jsonb,
  status        text,
  owner_user_id uuid references public.users(id) on delete set null,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  title text generated always as (data->>'name') stored,
  search tsvector generated always as
    (to_tsvector('swedish'::regconfig, coalesce(data::text, ''))) stored,
  constraint records_data_is_object check (jsonb_typeof(data) = 'object')
);

comment on column public.records.title is
  'Genererad kolumn låst till data->>''name''. Varje objekttyp i varje mall '
  'måste därför ha ett fält som heter name.';

create index on public.records (tenant_id, object_type, status) where deleted_at is null;
create index on public.records (tenant_id, owner_user_id) where deleted_at is null;
create index on public.records (tenant_id, object_type, title) where deleted_at is null;
create index on public.records using gin (data jsonb_path_ops);
create index on public.records using gin (search);
create index on public.records using gin (title gin_trgm_ops);

create table public.relationships (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  from_record_id uuid not null references public.records(id) on delete cascade,
  to_record_id   uuid not null references public.records(id) on delete cascade,
  rel_type       text not null,
  created_at     timestamptz not null default now(),
  unique (from_record_id, to_record_id, rel_type),
  constraint relationships_no_self_loop check (from_record_id <> to_record_id)
);

create index on public.relationships (to_record_id, rel_type);
create index on public.relationships (tenant_id, rel_type);

-- -----------------------------------------------------------------------------
-- Tidslinje
-- -----------------------------------------------------------------------------

create table public.activities (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  record_id     uuid references public.records(id) on delete cascade,
  activity_type text not null,
  body          text,
  metadata      jsonb not null default '{}'::jsonb,
  actor_user_id uuid references public.users(id) on delete set null,
  actor_kind    text not null default 'user',
  occurred_at   timestamptz not null default now(),
  constraint activities_actor_kind check
    (actor_kind in ('user', 'ai', 'system', 'integration')),
  constraint activities_type check (activity_type in (
    'note', 'call', 'meeting', 'email', 'status_change',
    'field_change', 'relation_change', 'ai_action', 'record_created'))
);

create index on public.activities (tenant_id, record_id, occurred_at desc);

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  record_id        uuid references public.records(id) on delete cascade,
  title            text not null,
  description      text,
  assignee_user_id uuid references public.users(id) on delete set null,
  department_id    uuid references public.departments(id) on delete set null,
  priority         text not null default 'normal',
  due_at           timestamptz,
  completed_at     timestamptz,
  completed_by     uuid references public.users(id) on delete set null,
  created_by       uuid references public.users(id) on delete set null,
  created_source   text not null default 'user',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tasks_priority check (priority in ('low','normal','high','critical')),
  constraint tasks_source check
    (created_source in ('user', 'workflow', 'ai', 'integration'))
);

create index on public.tasks (tenant_id, assignee_user_id, due_at) where completed_at is null;
create index on public.tasks (tenant_id, department_id, due_at) where completed_at is null;
create index on public.tasks (tenant_id, record_id);

-- -----------------------------------------------------------------------------
-- Kommunikation och dokument
-- -----------------------------------------------------------------------------

create table public.communications (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  channel      text not null,
  direction    text not null,
  provider     text not null,
  external_id  text not null,
  thread_key   text,
  subject      text,
  body_text    text,
  from_address text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  occurred_at  timestamptz not null,
  ingested_at  timestamptz not null default now(),
  raw          jsonb not null default '{}'::jsonb,
  unique (tenant_id, provider, external_id),
  constraint communications_channel check
    (channel in ('email', 'call', 'sms', 'chat', 'meeting')),
  constraint communications_direction check
    (direction in ('inbound', 'outbound', 'internal'))
);

create index on public.communications (tenant_id, thread_key);
create index on public.communications (tenant_id, occurred_at desc);
create index on public.communications (tenant_id, from_address);

create table public.communication_links (
  communication_id uuid not null references public.communications(id) on delete cascade,
  record_id        uuid not null references public.records(id) on delete cascade,
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  confidence       numeric(3,2) not null default 1.00,
  linked_by        text not null,
  linked_reason    text,
  confirmed_at     timestamptz,
  confirmed_by     uuid references public.users(id) on delete set null,
  primary key (communication_id, record_id),
  constraint communication_links_confidence check (confidence between 0 and 1),
  constraint communication_links_by check (linked_by in
    ('thread', 'reference', 'address', 'text_match', 'ai', 'user'))
);

create index on public.communication_links (record_id);
create index on public.communication_links (tenant_id);

create table public.documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  provider    text not null,
  external_id text not null,
  name        text not null,
  mime_type   text,
  size_bytes  bigint,
  web_url     text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);

create table public.document_links (
  document_id uuid not null references public.documents(id) on delete cascade,
  record_id   uuid not null references public.records(id) on delete cascade,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  primary key (document_id, record_id)
);

create index on public.document_links (record_id);
create index on public.document_links (tenant_id);

-- -----------------------------------------------------------------------------
-- Events
-- -----------------------------------------------------------------------------
--
-- Konsumeras av en Edge Function på schema, eller av pg_cron. Ingen broker.
--   select * from events
--    where processed_at is null and next_attempt_at <= now()
--    order by occurred_at for update skip locked limit 20;

create table public.events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  event_type        text not null,
  subject_record_id uuid references public.records(id) on delete cascade,
  payload           jsonb not null default '{}'::jsonb,
  actor_user_id     uuid references public.users(id) on delete set null,
  actor_kind        text not null default 'user',
  occurred_at       timestamptz not null default now(),
  processed_at      timestamptz,
  attempts          int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error        text
);

create index on public.events (next_attempt_at, occurred_at) where processed_at is null;
create index on public.events (tenant_id, event_type, occurred_at desc);
create index on public.events (subject_record_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- AI
-- -----------------------------------------------------------------------------

create table public.ai_agents (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  department_id        uuid references public.departments(id) on delete cascade,
  key                  text not null,
  name                 text not null,
  system_prompt        text not null,
  allowed_object_types text[] not null default '{}',
  allowed_tools        text[] not null default '{}',
  model                text not null default 'claude-sonnet-4-6',
  requires_approval    boolean not null default true,
  is_active            boolean not null default true,
  unique (tenant_id, key)
);

comment on column public.ai_agents.allowed_object_types is
  'Tom array = allt användaren själv får se. Agentens effektiva behörighet är '
  'ALLTID snittet med den anropande användarens roller. En agent kan aldrig ge '
  'mer åtkomst än användaren redan har.';

create table public.ai_threads (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  agent_id   uuid not null references public.ai_agents(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on public.ai_threads (tenant_id, user_id, updated_at desc);

create table public.ai_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.ai_threads(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null,
  content    jsonb not null,
  created_at timestamptz not null default now(),
  constraint ai_messages_role check (role in ('user', 'assistant', 'tool'))
);

create index on public.ai_messages (thread_id, created_at);
create index on public.ai_messages (tenant_id);

create table public.ai_proposals (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  thread_id  uuid references public.ai_threads(id) on delete set null,
  agent_id   uuid not null references public.ai_agents(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  actions    jsonb not null,
  rationale  text,
  state      text not null default 'pending',
  decided_at timestamptz,
  decided_by uuid references public.users(id) on delete set null,
  result     jsonb,
  created_at timestamptz not null default now(),
  constraint ai_proposals_state check
    (state in ('pending', 'approved', 'rejected', 'applied', 'failed'))
);

create index on public.ai_proposals (tenant_id, state, created_at desc);

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------

create table public.audit_log (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete restrict,
  actor_kind  text not null,
  actor_id    uuid,
  action      text not null,
  object_type text,
  object_id   uuid,
  before      jsonb,
  after       jsonb,
  occurred_at timestamptz not null default now(),
  constraint audit_log_actor_kind check
    (actor_kind in ('user', 'ai', 'system', 'integration'))
);

create index on public.audit_log (tenant_id, object_id, occurred_at desc);
create index on public.audit_log (tenant_id, actor_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger users_updated_at before update on public.users
  for each row execute function public.set_updated_at();
create trigger records_updated_at before update on public.records
  for each row execute function public.set_updated_at();
create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Profil skapas automatiskt när en användare registreras i Supabase Auth
-- -----------------------------------------------------------------------------
--
-- tenant_id måste finnas i app_metadata när användaren skapas. Sätt det via
-- Admin API vid inbjudan; en användare kan aldrig sätta sitt eget app_metadata,
-- vilket är hela anledningen till att tenant får bo där.

create function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  v_tenant := nullif(new.raw_app_meta_data ->> 'tenant_id', '')::uuid;
  if v_tenant is null then
    -- Dashboardens "Add user"-flöde sätter inte app_metadata vid
    -- skapandet. Blockera inte auth.users-inserten för det — hoppa bara
    -- över public.users-raden tills tenant sätts och den skapas manuellt.
    return new;
  end if;

  insert into public.users (id, tenant_id, email, full_name)
  values (
    new.id,
    v_tenant,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
