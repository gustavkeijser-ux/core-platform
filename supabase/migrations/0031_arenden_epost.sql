-- Ärendehantering v1 – e-post (Microsoft 365), meddelanden, bilagor, RPC:er.
--
-- Återanvänder communications / communication_links (meddelanden) och
-- documents (bilagor). Allt additivt.
--
-- Flöde:
--   Edge function mail-sync (pg_cron varje minut)
--     → Graph delta på Inkorg + Skickat (ImmutableId)
--     → mail_ingest_message(): upsert i communications (idempotent på
--       Graph-id + Internet Message ID) → process_inbound_email()
--     → trådning (In-Reply-To/References → conversationId → [CE-nr] i ämnet)
--     → nytt ärende eller nytt meddelande på befintligt ärende.
--   Handläggare svarar → case_queue_reply() → edge function mail-send
--     → Graph createReply + send → mail_mark_sent().
--   Interna kommentarer = communications.channel 'internal_note' — kan
--   aldrig skickas (mail-send accepterar bara direction 'outbound').

-- ---------------------------------------------------------------------------
-- 1. Meddelanden
-- ---------------------------------------------------------------------------
alter table public.communications
  add column if not exists mailbox             text,
  add column if not exists internet_message_id text,
  add column if not exists conversation_id     text,
  add column if not exists in_reply_to         text,
  add column if not exists references_ids      text[] not null default '{}',
  add column if not exists body_html           text,
  add column if not exists bcc_addresses       text[] not null default '{}',
  add column if not exists is_read             boolean,
  add column if not exists has_attachments     boolean not null default false,
  add column if not exists headers             jsonb not null default '{}'::jsonb,
  add column if not exists folder              text,
  add column if not exists author_user_id      uuid references public.users(id) on delete set null,
  add column if not exists processing_status   text not null default 'done',
  add column if not exists processing_attempts int  not null default 0,
  add column if not exists processing_error    text,
  add column if not exists processed_at        timestamptz,
  add column if not exists send_status         text,
  add column if not exists send_error          text,
  add column if not exists sent_at             timestamptz;

alter table public.communications drop constraint if exists communications_channel;
alter table public.communications add constraint communications_channel
  check (channel in ('email', 'call', 'sms', 'chat', 'meeting', 'letter', 'internal_note'));
alter table public.communications drop constraint if exists communications_processing_status;
alter table public.communications add constraint communications_processing_status
  check (processing_status in ('pending', 'done', 'ignored', 'failed'));
alter table public.communications drop constraint if exists communications_send_status;
alter table public.communications add constraint communications_send_status
  check (send_status is null or send_status in ('pending', 'sending', 'sent', 'failed'));

-- Andra dedupliceringsnyckeln (utöver tenant+provider+external_id):
-- samma Internet Message ID i samma brevlåda importeras bara en gång.
create unique index if not exists communications_mailbox_imid_uniq
  on public.communications (tenant_id, mailbox, internet_message_id)
  where internet_message_id is not null and mailbox is not null;
create index if not exists communications_imid_idx
  on public.communications (tenant_id, internet_message_id) where internet_message_id is not null;
create index if not exists communications_conv_idx
  on public.communications (tenant_id, conversation_id) where conversation_id is not null;
create index if not exists communications_pending_idx
  on public.communications (processing_status, processing_attempts) where processing_status in ('pending', 'failed');
create index if not exists communications_from_trgm
  on public.communications using gin (from_address gin_trgm_ops);
alter table public.communications add column if not exists search tsvector
  generated always as (to_tsvector('swedish'::regconfig,
    coalesce(subject, '') || ' ' || coalesce(body_text, ''))) stored;
create index if not exists communications_search_idx on public.communications using gin (search);

-- ---------------------------------------------------------------------------
-- 2. Bilagor (documents)
-- ---------------------------------------------------------------------------
alter table public.documents
  add column if not exists communication_id uuid references public.communications(id) on delete cascade,
  add column if not exists storage_path     text,
  add column if not exists content_id       text,
  add column if not exists is_inline        boolean not null default false,
  add column if not exists sender           text,
  add column if not exists received_at      timestamptz,
  add column if not exists blocked_reason   text;
create index if not exists documents_communication_idx on public.documents (communication_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('case-attachments', 'case-attachments', false, 26214400)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Åtkomst: meddelanden och bilagor syns bara via poster man får läsa.
--    (Tidigare: hela tenanten. Tabellerna är tomma, så inget påverkas.)
-- ---------------------------------------------------------------------------
create or replace function public.can_read_communication(p_comm uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from communication_links cl
      join records r on r.id = cl.record_id
     where cl.communication_id = p_comm
       and r.tenant_id = my_tenant_id() and r.deleted_at is null
       and can_row(r.object_type, 'read', r.owner_user_id))
$$;

drop policy if exists tenant_read on public.communications;
create policy linked_read on public.communications for select
  using (tenant_id = my_tenant_id() and public.can_read_communication(id));
drop policy if exists tenant_read on public.communication_links;
create policy linked_read on public.communication_links for select
  using (tenant_id = my_tenant_id() and exists (
    select 1 from records r where r.id = record_id and r.deleted_at is null
       and can_row(r.object_type, 'read', r.owner_user_id)));
drop policy if exists tenant_read on public.documents;
create policy linked_read on public.documents for select
  using (tenant_id = my_tenant_id() and (
    (communication_id is not null and public.can_read_communication(communication_id))
    or exists (select 1 from document_links dl join records r on r.id = dl.record_id
                where dl.document_id = documents.id and r.deleted_at is null
                  and can_row(r.object_type, 'read', r.owner_user_id))));

revoke truncate on public.communications, public.communication_links, public.documents from anon, authenticated;

-- Bilagefiler: <tenant>/<communication_id>/<fil>. Läsbar om meddelandet är läsbart.
drop policy if exists case_attachments_read on storage.objects;
create or replace function public.can_read_attachment_path(p_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_parts text[] := string_to_array(p_name, '/');
begin
  if array_length(v_parts, 1) < 3 or v_parts[1] <> my_tenant_id()::text
     or v_parts[2] !~ '^[0-9a-f-]{36}$' then
    return false;
  end if;
  return public.can_read_communication(v_parts[2]::uuid);
end $$;
create policy case_attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'case-attachments' and public.can_read_attachment_path(name));

-- ---------------------------------------------------------------------------
-- 4. Brevlåda, synkstatus, körningslogg
-- ---------------------------------------------------------------------------
create table if not exists public.mail_accounts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  provider     text not null default 'microsoft_graph',
  mailbox      citext not null,
  is_active    boolean not null default true,
  -- Mejl mottagna före denna tidpunkt importeras inte (ingen historik-flod).
  import_from  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (tenant_id, mailbox)
);

create table if not exists public.mail_sync_state (
  account_id           uuid not null references public.mail_accounts(id) on delete cascade,
  folder               text not null,          -- 'inbox' | 'sentitems'
  delta_link           text,
  last_success_at      timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures int not null default 0,
  messages_imported    bigint not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (account_id, folder)
);

create table if not exists public.integration_runs (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  account_id  uuid references public.mail_accounts(id) on delete cascade,
  kind        text not null default 'mail_sync',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',
  fetched     int not null default 0,
  imported    int not null default 0,
  duplicates  int not null default 0,
  failed      int not null default 0,
  error       text,
  constraint integration_runs_status check (status in ('running', 'ok', 'error', 'not_configured'))
);
create index if not exists integration_runs_recent on public.integration_runs (account_id, started_at desc);

alter table public.mail_accounts    enable row level security;
alter table public.mail_sync_state  enable row level security;
alter table public.integration_runs enable row level security;
drop policy if exists admin_read on public.mail_accounts;
create policy admin_read on public.mail_accounts for select using (tenant_id = my_tenant_id() and is_admin());
drop policy if exists admin_read on public.mail_sync_state;
create policy admin_read on public.mail_sync_state for select using (is_admin() and exists (
  select 1 from mail_accounts a where a.id = account_id and a.tenant_id = my_tenant_id()));
drop policy if exists admin_read on public.integration_runs;
create policy admin_read on public.integration_runs for select using (tenant_id = my_tenant_id() and is_admin());
grant select on public.mail_accounts, public.mail_sync_state, public.integration_runs to authenticated;

insert into public.mail_accounts (tenant_id, mailbox)
select id, 'hyresgast@connectestate.se' from public.tenants
 where exists (select 1 from object_definitions od where od.tenant_id = tenants.id and od.key = 'case')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5. Hjälpfunktioner
-- ---------------------------------------------------------------------------
create or replace function public.ce_iso(p timestamptz) returns text
language sql immutable as $$ select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

/** Uppdaterar visningsfälten fastighet_namn/lagenhet_namn på ett ärende. */
create or replace function public.case_refresh_links(p_case uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_lag records; v_prop records; v_lag_name text;
begin
  select r.* into v_lag from relationships e join records r on r.id = e.to_record_id
   where e.from_record_id = p_case and e.rel_type = 'case_lagenhet' and r.deleted_at is null limit 1;
  select r.* into v_prop from relationships e join records r on r.id = e.to_record_id
   where e.from_record_id = p_case and e.rel_type = 'case_property' and r.deleted_at is null limit 1;
  if v_lag.id is not null then
    v_lag_name := nullif(trim(concat_ws(' ',
      nullif(trim(concat_ws(' ', v_lag.data->>'gatunamn', v_lag.data->>'gatunummer')), ''),
      case when coalesce(v_lag.title, '') <> '' then 'lgh ' || v_lag.title end)), '');
  end if;
  update records set data = data || jsonb_build_object(
      'lagenhet_namn', v_lag_name,
      'fastighet_namn', coalesce(v_prop.title, v_prop.data->>'fastighetsbeteckning_komplett'))
   where id = p_case;
end $$;

create or replace function public.case_relationship_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.rel_type, old.rel_type) in ('case_lagenhet', 'case_property') then
    perform public.case_refresh_links(coalesce(new.from_record_id, old.from_record_id));
  end if;
  return null;
end $$;
drop trigger if exists trg_case_relationship_changed on public.relationships;
create trigger trg_case_relationship_changed
  after insert or delete on public.relationships
  for each row execute function public.case_relationship_changed();

/** Försök koppla ett ärende till lägenhet + fastighet utifrån e-postadressen. */
create or replace function public.case_autolink(p_case uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c records; v_lag uuid; v_prop uuid; v_email text;
begin
  select * into c from records where id = p_case;
  v_email := lower(nullif(c.data->>'kund_epost', ''));
  if v_email is null then return; end if;
  if exists (select 1 from relationships where from_record_id = p_case and rel_type in ('case_lagenhet', 'case_property')) then
    return;
  end if;

  -- 1) Ett tidigare ärende från samma adress som redan är kopplat (manuellt eller automatiskt)
  select e.to_record_id into v_lag from records o
    join relationships e on e.from_record_id = o.id and e.rel_type = 'case_lagenhet'
   where o.tenant_id = c.tenant_id and o.object_type = 'case' and o.id <> p_case
     and o.deleted_at is null and lower(o.data->>'kund_epost') = v_email
   order by o.created_at desc limit 1;
  select e.to_record_id into v_prop from records o
    join relationships e on e.from_record_id = o.id and e.rel_type = 'case_property'
   where o.tenant_id = c.tenant_id and o.object_type = 'case' and o.id <> p_case
     and o.deleted_at is null and lower(o.data->>'kund_epost') = v_email
   order by o.created_at desc limit 1;

  -- 2) Exakt en D2D-lägenhet med samma kund-e-post
  if v_lag is null then
    select case when count(*) = 1 then (array_agg(l.id))[1] end into v_lag
      from records l
     where l.tenant_id = c.tenant_id and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and lower(l.data->>'kund_epost') = v_email;
  end if;

  -- Fastighet via lägenhet → D2D-fastighet → fastighet
  if v_lag is not null and v_prop is null then
    select fp.to_record_id into v_prop
      from relationships lf
      join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_property'
     where lf.from_record_id = v_lag and lf.rel_type = 'd2d_lag_fastighet' limit 1;
  end if;

  if v_lag is not null then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (c.tenant_id, p_case, v_lag, 'case_lagenhet') on conflict do nothing;
  end if;
  if v_prop is not null then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (c.tenant_id, p_case, v_prop, 'case_property') on conflict do nothing;
  end if;
  if v_lag is not null or v_prop is not null then
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind)
    values (c.tenant_id, p_case, 'relation_change', 'Kopplades automatiskt via kundens e-postadress',
            jsonb_build_object('lagenhetId', v_lag, 'propertyId', v_prop), 'system');
  end if;
end $$;

/** Hitta ärendet ett meddelande hör till. Returnerar (case_id, hur). */
create or replace function public.mail_find_case(p_comm communications)
returns table (case_id uuid, linked_by text, reason text)
language plpgsql stable security definer set search_path = public as $$
declare v_ids text[]; v_nr text;
begin
  -- 1) In-Reply-To / References → ett känt meddelande som hör till ett ärende
  v_ids := array_remove(array_append(coalesce(p_comm.references_ids, '{}'), p_comm.in_reply_to), null);
  if array_length(v_ids, 1) > 0 then
    return query
      select cl.record_id, 'reference'::text, 'In-Reply-To/References'::text
        from communications c
        join communication_links cl on cl.communication_id = c.id
        join records r on r.id = cl.record_id and r.object_type = 'case' and r.deleted_at is null
       where c.tenant_id = p_comm.tenant_id and c.internet_message_id = any(v_ids) and c.id <> p_comm.id
       order by c.occurred_at desc limit 1;
    if found then return; end if;
  end if;

  -- 2) Microsofts conversationId (samma brevlåda)
  if p_comm.conversation_id is not null then
    return query
      select cl.record_id, 'thread'::text, 'Samma konversation (conversationId)'::text
        from communications c
        join communication_links cl on cl.communication_id = c.id
        join records r on r.id = cl.record_id and r.object_type = 'case' and r.deleted_at is null
       where c.tenant_id = p_comm.tenant_id and c.conversation_id = p_comm.conversation_id
         and c.mailbox is not distinct from p_comm.mailbox and c.id <> p_comm.id
       order by c.occurred_at desc limit 1;
    if found then return; end if;
  end if;

  -- 3) Ärendenummer i ämnesraden, t.ex. "SV: Internet [CE-10042]"
  v_nr := substring(coalesce(p_comm.subject, '') from '\[?(CE-\d{4,})\]?');
  if v_nr is not null then
    return query
      select r.id, 'reference'::text, ('Ärendenummer ' || v_nr || ' i ämnet')::text
        from records r
       where r.tenant_id = p_comm.tenant_id and r.object_type = 'case' and r.deleted_at is null
         and r.data->>'case_number' = v_nr
       limit 1;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Import (anropas bara av edge function med service-nyckel)
-- ---------------------------------------------------------------------------
/** Idempotent import av ett normaliserat Graph-meddelande.
 *  p_msg: {id, internetMessageId, conversationId, inReplyTo, references[],
 *          from, to[], cc[], bcc[], subject, bodyText, bodyHtml, receivedAt,
 *          isRead, hasAttachments, folder, headers{}} */
create or replace function public.mail_ingest_message(p_account uuid, p_msg jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a mail_accounts; v_id uuid; v_dir text; v_from text; v_existing uuid;
begin
  select * into a from mail_accounts where id = p_account and is_active;
  if not found then raise exception 'Okänt eller inaktivt e-postkonto'; end if;
  if coalesce(p_msg->>'id', '') = '' then raise exception 'Meddelande saknar id'; end if;

  -- Redan importerat? (Graph-id eller Internet Message ID) → bara uppdatera läst-status.
  select id into v_existing from communications
   where tenant_id = a.tenant_id and provider = 'microsoft_graph'
     and (external_id = p_msg->>'id'
          or (internet_message_id is not null and internet_message_id = p_msg->>'internetMessageId'
              and mailbox = a.mailbox::text))
   limit 1;
  if v_existing is not null then
    update communications set is_read = coalesce((p_msg->>'isRead')::boolean, is_read)
     where id = v_existing;
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;

  v_from := lower(nullif(trim(p_msg->>'from'), ''));
  v_dir := case when v_from = lower(a.mailbox::text) or p_msg->>'folder' = 'sentitems' then 'outbound' else 'inbound' end;

  insert into communications (
    tenant_id, channel, direction, provider, external_id, thread_key, subject, body_text, body_html,
    from_address, to_addresses, cc_addresses, bcc_addresses, occurred_at, raw,
    mailbox, internet_message_id, conversation_id, in_reply_to, references_ids,
    is_read, has_attachments, headers, folder, processing_status, send_status, sent_at)
  values (
    a.tenant_id, 'email', v_dir, 'microsoft_graph', p_msg->>'id', p_msg->>'conversationId',
    nullif(p_msg->>'subject', ''), p_msg->>'bodyText', p_msg->>'bodyHtml',
    v_from,
    coalesce(array(select lower(x) from jsonb_array_elements_text(coalesce(p_msg->'to', '[]')) x), '{}'),
    coalesce(array(select lower(x) from jsonb_array_elements_text(coalesce(p_msg->'cc', '[]')) x), '{}'),
    coalesce(array(select lower(x) from jsonb_array_elements_text(coalesce(p_msg->'bcc', '[]')) x), '{}'),
    coalesce((p_msg->>'receivedAt')::timestamptz, now()), '{}'::jsonb,
    a.mailbox::text, nullif(p_msg->>'internetMessageId', ''), nullif(p_msg->>'conversationId', ''),
    nullif(p_msg->>'inReplyTo', ''),
    coalesce(array(select x from jsonb_array_elements_text(coalesce(p_msg->'references', '[]')) x), '{}'),
    (p_msg->>'isRead')::boolean, coalesce((p_msg->>'hasAttachments')::boolean, false),
    coalesce(p_msg->'headers', '{}'::jsonb), p_msg->>'folder', 'pending',
    case when v_dir = 'outbound' then 'sent' end,
    case when v_dir = 'outbound' then coalesce((p_msg->>'receivedAt')::timestamptz, now()) end)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Samtidig import av samma mejl — den andra vann. Ingen dubblett.
    select id into v_existing from communications
     where tenant_id = a.tenant_id and provider = 'microsoft_graph' and external_id = p_msg->>'id';
    return jsonb_build_object('id', v_existing, 'duplicate', true);
  end if;

  perform public.process_inbound_email(v_id);
  return jsonb_build_object('id', v_id, 'duplicate', false,
    'caseId', (select record_id from communication_links where communication_id = v_id limit 1),
    'status', (select processing_status from communications where id = v_id));
end $$;

/** Koppla ett importerat meddelande till rätt ärende (eller skapa ett).
 *  Säker att köra flera gånger: redan kopplade meddelanden lämnas orörda. */
create or replace function public.process_inbound_email(p_comm uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m communications; f record; v_case uuid; v_case_row records; v_auto boolean; v_status text;
  v_new_case boolean := false; v_reopened_from uuid; v_now text := public.ce_iso(now());
begin
  select * into m from communications where id = p_comm for update;
  if not found then return null; end if;
  select record_id into v_case from communication_links where communication_id = p_comm limit 1;
  if v_case is not null then
    update communications set processing_status = 'done', processed_at = coalesce(processed_at, now()) where id = p_comm;
    return v_case;
  end if;

  -- Serialisera per konversation så två samtidiga körningar inte skapar två ärenden.
  perform pg_advisory_xact_lock(hashtextextended(m.tenant_id::text || ':' || coalesce(m.conversation_id, m.internet_message_id, m.id::text), 0));

  begin
    -- Autosvar, studsar och systemavsändare skapar aldrig ärenden.
    v_auto := coalesce(lower(m.headers->>'auto-submitted'), 'no') <> 'no'
           or m.headers ? 'x-autoreply' or m.headers ? 'x-autorespond'
           or lower(coalesce(m.headers->>'precedence', '')) in ('bulk', 'junk', 'auto_reply', 'list')
           or m.from_address ~* '^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@';

    select * into f from public.mail_find_case(m) limit 1;
    v_case := f.case_id;

    if m.direction = 'outbound' then
      -- Skickat direkt från Outlook: koppla bara om tråden är känd.
      if v_case is null then
        update communications set processing_status = 'ignored', processing_error = 'Utgående utan känt ärende',
               processed_at = now() where id = p_comm;
        return null;
      end if;
    elsif v_case is null and v_auto then
      update communications set processing_status = 'ignored', processing_error = 'Autosvar/systemavsändare',
             processed_at = now() where id = p_comm;
      return null;
    end if;

    if v_case is not null then
      select * into v_case_row from records where id = v_case;
      -- Svar på ett stängt ärende → nytt ärende som länkas till det gamla.
      if m.direction = 'inbound' and not v_auto and v_case_row.status = 'closed' then
        v_reopened_from := v_case;
        v_case := null;
      end if;
    end if;

    if v_case is null then
      insert into records (tenant_id, object_type, status, owner_user_id, created_by, data)
      values (m.tenant_id, 'case', 'new', null, null, jsonb_build_object(
        'name', coalesce(nullif(trim(regexp_replace(coalesce(m.subject, ''), '^\s*((SV|RE|VB|FW|FWD|AW)\s*:\s*)+', '', 'i')), ''), '(Inget ämne)'),
        'channel', 'email', 'priority', 'normal',
        'kund_epost', m.from_address, 'mailbox', m.mailbox,
        'last_inbound_at', public.ce_iso(m.occurred_at), 'last_activity_at', public.ce_iso(m.occurred_at),
        'reopened_from', v_reopened_from))
      returning id into v_case;
      v_new_case := true;
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind, occurred_at)
      values (m.tenant_id, v_case, 'record_created',
              case when v_reopened_from is null then 'Ärende skapat från e-post'
                   else 'Ärende skapat från e-post (fortsättning på '
                        || (select data->>'case_number' from records where id = v_reopened_from) || ')' end,
              jsonb_build_object('communicationId', p_comm), 'integration', m.occurred_at);
    end if;

    insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason)
    values (p_comm, v_case, m.tenant_id, case when v_new_case then 1.00 else 0.95 end,
            case when v_new_case then 'address' else coalesce(f.linked_by, 'thread') end,
            case when v_new_case then 'Nytt ärende' else f.reason end)
    on conflict do nothing;

    -- Uppdatera ärendet
    select * into v_case_row from records where id = v_case;
    if m.direction = 'inbound' and not v_new_case then
      v_status := case
        when v_auto then v_case_row.status
        when v_case_row.status = 'resolved' then 'in_progress'          -- återöppna
        when v_case_row.status = 'waiting_customer' then 'in_progress'  -- kunden har svarat
        else v_case_row.status end;
      update records set status = v_status,
             data = data || jsonb_build_object('last_inbound_at', public.ce_iso(m.occurred_at),
                                               'last_activity_at', public.ce_iso(m.occurred_at))
       where id = v_case;
      if v_status is distinct from v_case_row.status then
        insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind)
        values (m.tenant_id, v_case, 'status_change',
                'Status ändrades automatiskt till ' || (select sd.label from status_definitions sd
                   join object_definitions od on od.id = sd.object_id
                  where od.tenant_id = m.tenant_id and od.key = 'case' and sd.key = v_status) || ' (kunden svarade)',
                jsonb_build_object('from', v_case_row.status, 'to', v_status), 'integration');
      end if;
    elsif m.direction = 'outbound' then
      update records set data = data || jsonb_build_object('last_activity_at', v_now)
             || case when v_case_row.data->>'first_response_at' is null
                     then jsonb_build_object('first_response_at', public.ce_iso(m.occurred_at)) else '{}'::jsonb end
       where id = v_case;
    end if;

    if v_new_case then
      perform public.case_autolink(v_case);
    end if;

    update communications set processing_status = 'done', processing_error = null, processed_at = now()
     where id = p_comm;
    return v_case;
  exception when others then
    update communications set processing_status = 'failed', processing_attempts = processing_attempts + 1,
           processing_error = left(sqlerrm, 500) where id = p_comm;
    return null;
  end;
end $$;

/** Registrera en bilaga som redan laddats upp till storage (edge function). */
create or replace function public.mail_register_attachment(
  p_comm uuid, p_external_id text, p_name text, p_mime text, p_size bigint,
  p_storage_path text, p_content_id text, p_is_inline boolean, p_blocked_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare m communications; v_id uuid;
begin
  select * into m from communications where id = p_comm;
  if not found then raise exception 'Okänt meddelande'; end if;
  insert into documents (tenant_id, provider, external_id, name, mime_type, size_bytes,
                         communication_id, storage_path, content_id, is_inline, sender, received_at, blocked_reason)
  values (m.tenant_id, 'microsoft_graph', p_external_id, coalesce(nullif(trim(p_name), ''), 'bilaga'),
          p_mime, p_size, p_comm, p_storage_path, p_content_id, coalesce(p_is_inline, false),
          m.from_address, m.occurred_at, p_blocked_reason)
  on conflict (tenant_id, provider, external_id) do update
     set storage_path = coalesce(excluded.storage_path, documents.storage_path),
         blocked_reason = excluded.blocked_reason
  returning id into v_id;
  return v_id;
end $$;

/** Kör om meddelanden vars behandling misslyckats (anropas av mail-sync). */
create or replace function public.mail_retry_pending(p_limit int default 50)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from communications
            where provider = 'microsoft_graph' and processing_status in ('pending', 'failed')
              and processing_attempts < 10
            order by occurred_at limit p_limit loop
    perform public.process_inbound_email(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

/** Synkstatus (edge function). */
create or replace function public.mail_sync_report(
  p_account uuid, p_folder text, p_delta_link text, p_ok boolean, p_error text, p_imported int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into mail_sync_state (account_id, folder) values (p_account, p_folder) on conflict do nothing;
  update mail_sync_state set
    delta_link = coalesce(p_delta_link, delta_link),
    last_success_at = case when p_ok then now() else last_success_at end,
    last_error = case when p_ok then last_error else left(p_error, 1000) end,
    last_error_at = case when p_ok then last_error_at else now() end,
    consecutive_failures = case when p_ok then 0 else consecutive_failures + 1 end,
    messages_imported = messages_imported + coalesce(p_imported, 0),
    updated_at = now()
  where account_id = p_account and folder = p_folder;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Svar (handläggare) — köas här, skickas av edge function mail-send
-- ---------------------------------------------------------------------------
create or replace function public.case_queue_reply(p_case uuid, p_body text, p_next_status text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare c records; v_to text; v_id uuid; v_subject text; v_last communications;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then
    raise exception 'Saknar behörighet att svara på ärendet' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Svaret är tomt' using errcode = '22023'; end if;
  if p_next_status is not null and not exists (
      select 1 from status_definitions sd join object_definitions od on od.id = sd.object_id
       where od.tenant_id = c.tenant_id and od.key = 'case' and sd.key = p_next_status) then
    raise exception 'Okänd status' using errcode = '22023';
  end if;

  select cm.* into v_last from communications cm join communication_links cl on cl.communication_id = cm.id
   where cl.record_id = p_case and cm.channel = 'email' and cm.direction = 'inbound'
   order by cm.occurred_at desc limit 1;
  v_to := coalesce(v_last.from_address, nullif(c.data->>'kund_epost', ''));
  if v_to is null then raise exception 'Ärendet saknar mottagare (kundens e-post)' using errcode = '22023'; end if;

  v_subject := coalesce(nullif(v_last.subject, ''), c.data->>'name');
  if position(c.data->>'case_number' in coalesce(v_subject, '')) = 0 then
    v_subject := v_subject || ' [' || (c.data->>'case_number') || ']';
  end if;

  insert into communications (tenant_id, channel, direction, provider, external_id, thread_key,
    subject, body_text, from_address, to_addresses, occurred_at, mailbox, conversation_id,
    in_reply_to, author_user_id, processing_status, send_status, headers)
  values (c.tenant_id, 'email', 'outbound', 'microsoft_graph', 'pending:' || gen_random_uuid(),
    v_last.conversation_id, v_subject, trim(p_body),
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    array[v_to], now(),
    coalesce(c.data->>'mailbox', (select mailbox::text from mail_accounts where tenant_id = c.tenant_id and is_active limit 1)),
    v_last.conversation_id, v_last.internet_message_id, auth.uid(), 'done', 'pending',
    jsonb_build_object('replyToGraphId', v_last.external_id, 'nextStatus', p_next_status))
  returning id into v_id;

  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason, confirmed_at, confirmed_by)
  values (v_id, p_case, c.tenant_id, 1, 'user', 'Svar från CRM', now(), auth.uid());
  return v_id;
end $$;

/** Edge function: markera svar som skickat (service-nyckel). */
create or replace function public.mail_mark_sent(p_comm uuid, p_graph_id text, p_internet_message_id text,
                                                 p_conversation_id text, p_draft boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare m communications; v_case uuid; c records; v_next text;
begin
  select * into m from communications where id = p_comm for update;
  if not found then raise exception 'Okänt meddelande'; end if;
  if p_draft then
    -- Utkast skapat men inte skickat ännu — spara id:t så ett omförsök inte skapar ett nytt.
    update communications set external_id = coalesce(p_graph_id, external_id), send_status = 'sending',
           internet_message_id = coalesce(p_internet_message_id, internet_message_id),
           conversation_id = coalesce(p_conversation_id, conversation_id)
     where id = p_comm;
    return;
  end if;
  update communications set external_id = coalesce(p_graph_id, external_id), send_status = 'sent',
         send_error = null, sent_at = now(), occurred_at = now(),
         internet_message_id = coalesce(p_internet_message_id, internet_message_id),
         conversation_id = coalesce(p_conversation_id, conversation_id), thread_key = coalesce(p_conversation_id, thread_key)
   where id = p_comm;

  select record_id into v_case from communication_links where communication_id = p_comm limit 1;
  select * into c from records where id = v_case;
  v_next := coalesce(m.headers->>'nextStatus',
                     case when c.status in ('new', 'assigned') then 'in_progress' end);
  update records set
    status = coalesce(v_next, status),
    data = data || jsonb_build_object('last_activity_at', public.ce_iso(now()))
         || case when data->>'first_response_at' is null then jsonb_build_object('first_response_at', public.ce_iso(now())) else '{}'::jsonb end
   where id = v_case;
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (m.tenant_id, v_case, 'email', 'Svar skickades till ' || array_to_string(m.to_addresses, ', '),
          jsonb_build_object('communicationId', p_comm), m.author_user_id, 'user');
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, after)
  values (m.tenant_id, 'user', m.author_user_id, 'case.reply_sent', 'case', v_case,
          jsonb_build_object('communicationId', p_comm, 'to', m.to_addresses));
end $$;

create or replace function public.mail_mark_send_failed(p_comm uuid, p_error text)
returns void language sql security definer set search_path = public as $$
  update communications set send_status = 'failed', send_error = left(p_error, 1000) where id = p_comm
$$;

-- ---------------------------------------------------------------------------
-- 8. Handläggar-RPC:er
-- ---------------------------------------------------------------------------
create or replace function public.case_status_label(p_tenant uuid, p_status text) returns text
language sql stable security definer set search_path = public as $$
  select sd.label from status_definitions sd join object_definitions od on od.id = sd.object_id
   where od.tenant_id = p_tenant and od.key = 'case' and sd.key = p_status
$$;

create or replace function public.case_choice_label(p_tenant uuid, p_field text, p_key text) returns text
language sql stable security definer set search_path = public as $$
  select ch->>'label' from field_definitions fd
    join object_definitions od on od.id = fd.object_id
    cross join lateral jsonb_array_elements(coalesce(fd.options->'choices', '[]'::jsonb)) ch
   where od.tenant_id = p_tenant and od.key = 'case' and fd.key = p_field and ch->>'key' = p_key
   limit 1
$$;

/** Ändra status/prioritet/kategori/ansvarig/team. NULL = oförändrat;
 *  p_unassign = true tar bort ansvarig. */
create or replace function public.case_set(
  p_case uuid, p_status text default null, p_priority text default null,
  p_category text default null, p_subcategory text default null,
  p_ansvarig uuid default null, p_unassign boolean default false, p_team text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c records; v_patch jsonb := '{}'; v_row records; v_name text; v_msgs text[] := '{}';
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null for update;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then
    raise exception 'Saknar behörighet att ändra ärendet' using errcode = '42501';
  end if;

  if p_priority is not null and p_priority is distinct from c.data->>'priority' then
    if p_priority not in ('normal', 'high', 'critical', 'urgent') then raise exception 'Okänd prioritet' using errcode = '22023'; end if;
    v_patch := v_patch || jsonb_build_object('priority', p_priority);
    v_msgs := v_msgs || ('Prioritet ändrades ' || coalesce(case_choice_label(c.tenant_id, 'priority', c.data->>'priority'), '—')
                         || ' → ' || coalesce(case_choice_label(c.tenant_id, 'priority', p_priority), p_priority));
  end if;
  if p_category is not null and p_category is distinct from c.data->>'category' then
    if not exists (select 1 from case_categories where tenant_id = c.tenant_id and key = p_category and parent_key is null) then
      raise exception 'Okänd kategori' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('category', p_category,
      'subcategory', case when p_subcategory is not null then p_subcategory else null end);
    v_msgs := v_msgs || ('Kategori: ' || (select label from case_categories where tenant_id = c.tenant_id and key = p_category));
  end if;
  if p_subcategory is not null and p_subcategory is distinct from c.data->>'subcategory' then
    if not exists (select 1 from case_categories where tenant_id = c.tenant_id and key = p_subcategory
                     and parent_key = coalesce(p_category, c.data->>'category')) then
      raise exception 'Underkategorin hör inte till kategorin' using errcode = '22023';
    end if;
    v_patch := v_patch || jsonb_build_object('subcategory', p_subcategory);
    v_msgs := v_msgs || ('Underkategori: ' || (select label from case_categories where tenant_id = c.tenant_id and key = p_subcategory));
  end if;
  if p_team is not null and p_team is distinct from c.data->>'team' then
    v_patch := v_patch || jsonb_build_object('team', nullif(p_team, ''));
  end if;
  if p_unassign and c.owner_user_id is not null then
    v_patch := v_patch || jsonb_build_object('ansvarig', null);
    v_msgs := v_msgs || 'Ansvarig togs bort'::text;
  elsif p_ansvarig is not null and p_ansvarig is distinct from c.owner_user_id then
    if not exists (select 1 from users where id = p_ansvarig and tenant_id = c.tenant_id and is_active) then
      raise exception 'Okänd användare' using errcode = '22023';
    end if;
    select coalesce(full_name, email::text) into v_name from users where id = p_ansvarig;
    v_patch := v_patch || jsonb_build_object('ansvarig', p_ansvarig);
    v_msgs := v_msgs || (v_name || ' tilldelades ärendet');
  end if;
  if p_status is not null and p_status is distinct from c.status then
    if not exists (select 1 from status_definitions sd join object_definitions od on od.id = sd.object_id
                    where od.tenant_id = c.tenant_id and od.key = 'case' and sd.key = p_status) then
      raise exception 'Okänd status' using errcode = '22023';
    end if;
  end if;

  if v_patch = '{}'::jsonb and (p_status is null or p_status = c.status) then
    return to_jsonb(c);
  end if;

  update records set data = data || v_patch || jsonb_build_object('last_activity_at', public.ce_iso(now())),
         status = coalesce(p_status, status)
   where id = p_case returning * into v_row;

  if v_row.status is distinct from c.status then
    v_msgs := v_msgs || ('Status ändrades ' || coalesce(case_status_label(c.tenant_id, c.status), c.status)
                         || ' → ' || coalesce(case_status_label(c.tenant_id, v_row.status), v_row.status));
  end if;
  if array_length(v_msgs, 1) > 0 then
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (c.tenant_id, p_case,
            case when v_row.status is distinct from c.status then 'status_change' else 'field_change' end,
            array_to_string(v_msgs, ' · '),
            jsonb_build_object('from', jsonb_build_object('status', c.status, 'owner', c.owner_user_id, 'priority', c.data->>'priority'),
                               'to', jsonb_build_object('status', v_row.status, 'owner', v_row.owner_user_id, 'priority', v_row.data->>'priority')),
            auth.uid(), 'user');
  end if;
  return to_jsonb(v_row);
end $$;

create or replace function public.case_add_note(p_case uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c records; v_id uuid;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Kommentaren är tom' using errcode = '22023'; end if;
  insert into communications (tenant_id, channel, direction, provider, external_id, body_text,
                              occurred_at, author_user_id, processing_status)
  values (c.tenant_id, 'internal_note', 'internal', 'crm', 'note:' || gen_random_uuid(), trim(p_body),
          now(), auth.uid(), 'done')
  returning id into v_id;
  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, confirmed_at, confirmed_by)
  values (v_id, p_case, c.tenant_id, 1, 'user', now(), auth.uid());
  update records set data = data || jsonb_build_object('last_activity_at', public.ce_iso(now())) where id = p_case;
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, after)
  values (c.tenant_id, 'user', auth.uid(), 'case.note_added', 'case', p_case, jsonb_build_object('communicationId', v_id));
  return v_id;
end $$;

/** Skapa ärende manuellt (t.ex. från telefon) — samma grundobjekt. */
create or replace function public.case_create(p_title text, p_channel text default 'internal',
                                              p_kund_epost text default null, p_body text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_row records;
begin
  select * into v_row from create_record('case', jsonb_build_object(
    'name', p_title, 'channel', coalesce(p_channel, 'internal'), 'priority', 'normal',
    'kund_epost', nullif(trim(coalesce(p_kund_epost, '')), '')), 'new', null);
  if coalesce(trim(p_body), '') <> '' then perform public.case_add_note(v_row.id, p_body); end if;
  perform public.case_autolink(v_row.id);
  return v_row.id;
end $$;

/** Ärendeinkorgen: filtrerad, sökbar lista med SLA-läge. */
create or replace function public.list_cases(p_filter text default 'open', p_search text default null,
                                             p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := my_tenant_id(); v_scope text; v_q text := nullif(trim(coalesce(p_search, '')), '');
        v_res jsonb; v_counts jsonb;
begin
  if not can_do('case', 'read') then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  v_scope := my_scope('case', 'read');

  with base as (
    select r.*,
           coalesce(nullif(r.data->>'first_response_at', '')::timestamptz, null) as fra,
           nullif(r.data->>'first_response_due_at', '')::timestamptz as frd,
           nullif(r.data->>'resolution_due_at', '')::timestamptz as rd,
           nullif(r.data->>'resolved_at', '')::timestamptz as rat,
           coalesce(nullif(r.data->>'last_activity_at', '')::timestamptz, r.updated_at) as lat
      from records r
     where r.tenant_id = v_tenant and r.object_type = 'case' and r.deleted_at is null
       and in_scope(v_scope, r.owner_user_id)
       and (v_q is null
            or r.data->>'case_number' ilike '%' || v_q || '%'
            or r.title ilike '%' || v_q || '%'
            or r.data->>'kund_epost' ilike '%' || v_q || '%'
            or r.data->>'fastighet_namn' ilike '%' || v_q || '%'
            or r.data->>'lagenhet_namn' ilike '%' || v_q || '%'
            or exists (select 1 from communication_links cl join communications cm on cm.id = cl.communication_id
                        where cl.record_id = r.id
                          and (cm.search @@ websearch_to_tsquery('swedish', v_q)
                               or cm.from_address ilike '%' || v_q || '%'
                               or cm.subject ilike '%' || v_q || '%')))
  ), scored as (
    select b.*,
      case when b.status in ('resolved', 'closed') then null
           when b.fra is null then public.case_sla_state(b.created_at, b.frd, null)
           else public.case_sla_state(b.created_at, b.rd, b.rat) end as sla,
      case when b.status in ('resolved', 'closed') then null
           when b.fra is null then least(b.frd, b.rd) else b.rd end as next_due
      from base b
  ), filtered as (
    select * from scored s where case coalesce(p_filter, 'open')
      when 'all' then true
      when 'open' then s.status not in ('resolved', 'closed')
      when 'new' then s.status = 'new'
      when 'mine' then s.owner_user_id = auth.uid() and s.status not in ('resolved', 'closed')
      when 'unassigned' then s.owner_user_id is null and s.status not in ('resolved', 'closed')
      when 'in_progress' then s.status in ('assigned', 'in_progress')
      when 'waiting_customer' then s.status = 'waiting_customer'
      when 'waiting_internal' then s.status = 'waiting_internal'
      when 'waiting_contractor' then s.status = 'waiting_contractor'
      when 'resolved' then s.status = 'resolved'
      when 'closed' then s.status = 'closed'
      when 'overdue' then s.sla = 'breached'
      else true end
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'items', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object(
        'id', f.id, 'caseNumber', f.data->>'case_number', 'title', f.title, 'status', f.status,
        'priority', coalesce(f.data->>'priority', 'normal'),
        'category', f.data->>'category', 'subcategory', f.data->>'subcategory',
        'categoryLabel', (select label from case_categories cc where cc.tenant_id = v_tenant and cc.key = f.data->>'category'),
        'subcategoryLabel', (select label from case_categories cc where cc.tenant_id = v_tenant and cc.key = f.data->>'subcategory'),
        'kundEpost', f.data->>'kund_epost', 'fastighet', f.data->>'fastighet_namn', 'lagenhet', f.data->>'lagenhet_namn',
        'ownerUserId', f.owner_user_id, 'channel', f.data->>'channel',
        'lastActivityAt', f.lat, 'createdAt', f.created_at, 'sla', f.sla, 'nextDue', f.next_due,
        'firstResponseAt', f.fra,
        'preview', (select left(regexp_replace(coalesce(cm.body_text, ''), '\s+', ' ', 'g'), 140)
                      from communication_links cl join communications cm on cm.id = cl.communication_id
                     where cl.record_id = f.id and cm.channel = 'email'
                     order by cm.occurred_at desc limit 1),
        'lastDirection', (select cm.direction from communication_links cl join communications cm on cm.id = cl.communication_id
                           where cl.record_id = f.id and cm.channel = 'email'
                           order by cm.occurred_at desc limit 1)
      ) x
      from filtered f
      order by
        case when f.status in ('resolved', 'closed') then 1 else 0 end,
        case f.data->>'priority' when 'urgent' then 0 when 'critical' then 1 when 'high' then 2 else 3 end,
        f.next_due asc nulls last, f.lat desc
      limit greatest(least(coalesce(p_limit, 50), 200), 1) offset greatest(coalesce(p_offset, 0), 0)) q), '[]'::jsonb)
  ) into v_res;

  select jsonb_build_object(
    'open',               count(*) filter (where status not in ('resolved', 'closed')),
    'new',                count(*) filter (where status = 'new'),
    'mine',               count(*) filter (where owner_user_id = auth.uid() and status not in ('resolved', 'closed')),
    'unassigned',         count(*) filter (where owner_user_id is null and status not in ('resolved', 'closed')),
    'in_progress',        count(*) filter (where status in ('assigned', 'in_progress')),
    'waiting_customer',   count(*) filter (where status = 'waiting_customer'),
    'waiting_internal',   count(*) filter (where status = 'waiting_internal'),
    'waiting_contractor', count(*) filter (where status = 'waiting_contractor'),
    'resolved',           count(*) filter (where status = 'resolved'),
    'closed',             count(*) filter (where status = 'closed'),
    'all',                count(*))
    into v_counts
    from records r
   where r.tenant_id = v_tenant and r.object_type = 'case' and r.deleted_at is null
     and in_scope(v_scope, r.owner_user_id);

  return v_res || jsonb_build_object('counts', v_counts);
end $$;

/** Ett ärende med konversation, bilagor, händelser och kopplingar. */
create or replace function public.get_case(p_case uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c records;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null;
  if not found or not can_row('case', 'read', c.owner_user_id) then
    raise exception 'Ärendet finns inte' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'case', to_jsonb(c),
    'canUpdate', can_row('case', 'update', c.owner_user_id),
    'categoryLabel', (select label from case_categories where tenant_id = c.tenant_id and key = c.data->>'category'),
    'subcategoryLabel', (select label from case_categories where tenant_id = c.tenant_id and key = c.data->>'subcategory'),
    'sla', jsonb_build_object(
      'firstResponse', public.case_sla_state(c.created_at, nullif(c.data->>'first_response_due_at', '')::timestamptz,
                                             nullif(c.data->>'first_response_at', '')::timestamptz),
      'resolution', public.case_sla_state(c.created_at, nullif(c.data->>'resolution_due_at', '')::timestamptz,
                                          nullif(c.data->>'resolved_at', '')::timestamptz)),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'channel', m.channel, 'direction', m.direction, 'subject', m.subject,
        'bodyText', m.body_text, 'hasHtml', m.body_html is not null,
        'from', m.from_address, 'to', m.to_addresses, 'cc', m.cc_addresses,
        'occurredAt', m.occurred_at, 'authorUserId', m.author_user_id,
        'sendStatus', m.send_status, 'sendError', m.send_error,
        'attachments', coalesce((select jsonb_agg(jsonb_build_object(
            'id', d.id, 'name', d.name, 'mimeType', d.mime_type, 'sizeBytes', d.size_bytes,
            'storagePath', d.storage_path, 'isInline', d.is_inline, 'blockedReason', d.blocked_reason,
            'sender', d.sender, 'receivedAt', d.received_at) order by d.name)
          from documents d where d.communication_id = m.id and not d.is_inline), '[]'::jsonb)
      ) order by m.occurred_at, m.id)
      from communications m join communication_links cl on cl.communication_id = m.id
     where cl.record_id = p_case), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'type', a.activity_type, 'body', a.body, 'actorUserId', a.actor_user_id,
        'actorKind', a.actor_kind, 'occurredAt', a.occurred_at) order by a.occurred_at)
      from activities a where a.record_id = p_case
       and a.activity_type in ('record_created', 'status_change', 'field_change', 'relation_change')), '[]'::jsonb),
    'related', coalesce((select jsonb_agg(jsonb_build_object(
        'relType', e.rel_type, 'label', rd.label_forward,
        'id', o.id, 'objectType', o.object_type, 'title', o.title, 'status', o.status))
      from relationships e join records o on o.id = e.to_record_id and o.deleted_at is null
      left join relationship_definitions rd on rd.tenant_id = c.tenant_id and rd.rel_type = e.rel_type
     where e.from_record_id = p_case), '[]'::jsonb),
    'otherCases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'caseNumber', o.data->>'case_number', 'title', o.title, 'status', o.status, 'createdAt', o.created_at)
        order by o.created_at desc)
      from records o where o.tenant_id = c.tenant_id and o.object_type = 'case' and o.deleted_at is null
       and o.id <> p_case and nullif(c.data->>'kund_epost', '') is not null
       and lower(o.data->>'kund_epost') = lower(c.data->>'kund_epost')), '[]'::jsonb)
  );
end $$;

/** HTML-versionen av ett mejl (hämtas bara när handläggaren ber om den). */
create or replace function public.get_message_html(p_comm uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_read_communication(p_comm) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return (select body_html from communications where id = p_comm);
end $$;

/** Dashboard: ärendeöversikt. */
create or replace function public.get_case_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := my_tenant_id(); v_scope text;
begin
  if not can_do('case', 'read') then return null; end if;
  v_scope := my_scope('case', 'read');
  return (
    with s as (
      select r.status, r.owner_user_id, r.created_at,
             case when r.status in ('resolved', 'closed') then null
                  when nullif(r.data->>'first_response_at', '') is null
                    then public.case_sla_state(r.created_at, nullif(r.data->>'first_response_due_at', '')::timestamptz, null)
                  else public.case_sla_state(r.created_at, nullif(r.data->>'resolution_due_at', '')::timestamptz, null) end sla,
             case when r.status in ('resolved', 'closed') then null
                  when nullif(r.data->>'first_response_at', '') is null
                    then least(nullif(r.data->>'first_response_due_at', '')::timestamptz, nullif(r.data->>'resolution_due_at', '')::timestamptz)
                  else nullif(r.data->>'resolution_due_at', '')::timestamptz end due
        from records r
       where r.tenant_id = v_tenant and r.object_type = 'case' and r.deleted_at is null
         and in_scope(v_scope, r.owner_user_id))
    select jsonb_build_object(
      'today', jsonb_build_object(
        'new',        count(*) filter (where status = 'new'),
        'createdToday', count(*) filter (where created_at >= date_trunc('day', now() at time zone 'Europe/Stockholm') at time zone 'Europe/Stockholm'),
        'inProgress', count(*) filter (where status in ('assigned', 'in_progress')),
        'waiting',    count(*) filter (where status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')),
        'overdue',    count(*) filter (where sla = 'breached'),
        'unassigned', count(*) filter (where owner_user_id is null and status not in ('resolved', 'closed'))),
      'mine', jsonb_build_object(
        'new',        count(*) filter (where owner_user_id = auth.uid() and status in ('new', 'assigned')),
        'inProgress', count(*) filter (where owner_user_id = auth.uid() and status = 'in_progress'),
        'waiting',    count(*) filter (where owner_user_id = auth.uid() and status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')),
        'slaToday',   count(*) filter (where owner_user_id = auth.uid() and due is not null
                                         and due < (date_trunc('day', now() at time zone 'Europe/Stockholm') + interval '1 day') at time zone 'Europe/Stockholm'),
        'overdue',    count(*) filter (where owner_user_id = auth.uid() and sla = 'breached')))
    from s);
end $$;

/** Admin: status för Microsoft 365-integrationen. */
create or replace function public.mail_integration_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara admin' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', a.id, 'mailbox', a.mailbox, 'isActive', a.is_active, 'importFrom', a.import_from,
      'folders', coalesce((select jsonb_agg(jsonb_build_object(
          'folder', s.folder, 'lastSuccessAt', s.last_success_at, 'lastError', s.last_error,
          'lastErrorAt', s.last_error_at, 'consecutiveFailures', s.consecutive_failures,
          'messagesImported', s.messages_imported, 'hasDelta', s.delta_link is not null))
        from mail_sync_state s where s.account_id = a.id), '[]'::jsonb),
      'lastRun', (select to_jsonb(ir) - 'tenant_id' from integration_runs ir where ir.account_id = a.id
                   order by ir.started_at desc limit 1),
      'lastOkRun', (select max(finished_at) from integration_runs ir where ir.account_id = a.id and ir.status = 'ok'),
      'runs24h', (select count(*) from integration_runs ir where ir.account_id = a.id and ir.started_at > now() - interval '24 hours'),
      'errors24h', (select count(*) from integration_runs ir where ir.account_id = a.id and ir.status = 'error'
                     and ir.started_at > now() - interval '24 hours'),
      'imported', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.provider = 'microsoft_graph'
                    and c.mailbox = a.mailbox::text and c.direction = 'inbound'),
      'failedProcessing', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.provider = 'microsoft_graph'
                            and c.processing_status = 'failed'),
      'failedSends', (select count(*) from communications c where c.tenant_id = a.tenant_id and c.send_status = 'failed')))
    from mail_accounts a where a.tenant_id = my_tenant_id()), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Behörigheter på funktionerna
-- ---------------------------------------------------------------------------
revoke all on function public.mail_ingest_message(uuid, jsonb)          from public, anon, authenticated;
revoke all on function public.process_inbound_email(uuid)               from public, anon, authenticated;
revoke all on function public.mail_register_attachment(uuid, text, text, text, bigint, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.mail_retry_pending(int)                   from public, anon, authenticated;
revoke all on function public.mail_sync_report(uuid, text, text, boolean, text, int) from public, anon, authenticated;
revoke all on function public.mail_mark_sent(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.mail_mark_send_failed(uuid, text)         from public, anon, authenticated;
revoke all on function public.case_autolink(uuid)                       from public, anon, authenticated;
revoke all on function public.case_refresh_links(uuid)                  from public, anon, authenticated;
revoke all on function public.mail_find_case(communications)            from public, anon, authenticated;
grant execute on function public.mail_ingest_message(uuid, jsonb), public.process_inbound_email(uuid),
  public.mail_register_attachment(uuid, text, text, text, bigint, text, text, boolean, text),
  public.mail_retry_pending(int), public.mail_sync_report(uuid, text, text, boolean, text, int),
  public.mail_mark_sent(uuid, text, text, text, boolean), public.mail_mark_send_failed(uuid, text)
  to service_role;

grant execute on function public.case_queue_reply(uuid, text, text), public.case_set(uuid, text, text, text, text, uuid, boolean, text),
  public.case_add_note(uuid, text), public.case_create(text, text, text, text), public.list_cases(text, text, int, int),
  public.get_case(uuid), public.get_message_html(uuid), public.get_case_summary(), public.mail_integration_status()
  to authenticated;
