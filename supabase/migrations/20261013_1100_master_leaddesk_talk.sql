-- [Master] LeadDesk Talk (CTI): inställningar, nummeruppslag och samtalslogg.
--
-- * leaddesk_installningar   — en rad per tenant. Exakt inloggnings-URL (Talk-iframens src;
--                              dess origin är den enda godkända postMessage-origin),
--                              autocall, skärmpop per riktning, standardland, tidszon.
--                              RLS utan policies: läses/skrivs bara via RPC nedan.
-- * leaddesk_telefon_norm    — normaliserar ett nummer till +E.164-liknande form.
-- * hitta_poster_pa_telefon  — poster (alla fält av typen phone) som användaren får läsa.
-- * leaddesk_spara_samtal    — upsert av ett avslutat samtal (completed) i communications,
--                              idempotent på external_id = 'leaddesk:<call_id>'. Kopplar till
--                              posten och skriver en call-aktivitet i tidslinjen första gången.
-- * leaddesk_koppla_samtal   — koppla ett sparat samtal till en post i efterhand.
-- * leaddesk_mina_samtal     — senaste samtalen (egna; admin ser alla), inspelningslänk bara admin.

-- 1. Inställningar ---------------------------------------------------------------
create table if not exists public.leaddesk_installningar (
  tenant_id     uuid primary key references public.tenants(id) on delete cascade,
  login_url     text,
  autocall      boolean not null default true,
  skarmpop_in   boolean not null default true,
  skarmpop_ut   boolean not null default true,
  standardland  text    not null default 'SE',
  tidszon       text    not null default 'Europe/Stockholm',
  aktiv         boolean not null default true,
  uppdaterad    timestamptz not null default now(),
  uppdaterad_av uuid references public.users(id) on delete set null
);
alter table public.leaddesk_installningar enable row level security;

-- Godkänd URL: https, värd *.leaddesk.com, inga inloggningsuppgifter i URL:en.
create or replace function public.leaddesk_url_ok(p_url text)
returns boolean language sql immutable as $$
  select p_url ~ '^https://[a-z0-9][a-z0-9.-]*\.leaddesk\.com(:[0-9]+)?(/[^\s@]*)?$'
$$;

create or replace function public.leaddesk_installningar_hamta()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'loginUrl',     i.login_url,
    'autocall',     coalesce(i.autocall, true),
    'skarmpopIn',   coalesce(i.skarmpop_in, true),
    'skarmpopUt',   coalesce(i.skarmpop_ut, true),
    'standardland', coalesce(i.standardland, 'SE'),
    'tidszon',      coalesce(i.tidszon, 'Europe/Stockholm'),
    'aktiv',        coalesce(i.aktiv, true) and i.login_url is not null,
    'uppdaterad',   i.uppdaterad
  )
  from (select my_tenant_id() t) x
  left join leaddesk_installningar i on i.tenant_id = x.t
  where x.t is not null
$$;

create or replace function public.leaddesk_installningar_spara(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_t uuid := my_tenant_id(); v_url text;
begin
  if v_t is null or not is_admin() then
    raise exception 'Bara administratörer kan ändra LeadDesk-inställningarna' using errcode = '42501';
  end if;
  v_url := nullif(trim(coalesce(p->>'loginUrl', '')), '');
  if v_url is not null and not leaddesk_url_ok(v_url) then
    raise exception 'Inloggnings-URL:en måste börja med https:// och ligga under leaddesk.com' using errcode = '22023';
  end if;
  if coalesce(p->>'tidszon', 'Europe/Stockholm') not in (select name from pg_timezone_names) then
    raise exception 'Okänd tidszon' using errcode = '22023';
  end if;
  insert into leaddesk_installningar as i
    (tenant_id, login_url, autocall, skarmpop_in, skarmpop_ut, standardland, tidszon, aktiv, uppdaterad, uppdaterad_av)
  values (v_t, v_url,
          coalesce((p->>'autocall')::boolean, true),
          coalesce((p->>'skarmpopIn')::boolean, true),
          coalesce((p->>'skarmpopUt')::boolean, true),
          upper(coalesce(nullif(p->>'standardland', ''), 'SE')),
          coalesce(nullif(p->>'tidszon', ''), 'Europe/Stockholm'),
          coalesce((p->>'aktiv')::boolean, true),
          now(), auth.uid())
  on conflict (tenant_id) do update set
    login_url = excluded.login_url, autocall = excluded.autocall,
    skarmpop_in = excluded.skarmpop_in, skarmpop_ut = excluded.skarmpop_ut,
    standardland = excluded.standardland, tidszon = excluded.tidszon,
    aktiv = excluded.aktiv, uppdaterad = now(), uppdaterad_av = auth.uid();
  return leaddesk_installningar_hamta();
end $$;

-- 2. Telefonnummer -----------------------------------------------------------------
-- Landsprefix för standardlandet (bara de som är relevanta för oss; okänt land = ingen omskrivning).
create or replace function public.leaddesk_landsprefix(p_land text)
returns text language sql immutable as $$
  select case upper(coalesce(p_land, ''))
    when 'SE' then '46' when 'FI' then '358' when 'NO' then '47' when 'DK' then '45'
    when 'DE' then '49' when 'GB' then '44' else null end
$$;

-- "070-123 45 67" → "+46701234567"; "0046…" → "+46…"; "+46 (0)70…" → "+4670…".
create or replace function public.leaddesk_telefon_norm(p text, p_land text default 'SE')
returns text language plpgsql immutable as $$
declare s text; pre text := leaddesk_landsprefix(p_land);
begin
  if p is null then return null; end if;
  s := regexp_replace(p, '\(0\)', '', 'g');
  s := regexp_replace(s, '[^0-9+]', '', 'g');
  s := regexp_replace(s, '(?!^)\+', '', 'g');
  if s like '00%' then s := '+' || substr(s, 3); end if;
  if s not like '+%' and s like '0%' and pre is not null then s := '+' || pre || substr(s, 2); end if;
  if s not like '+%' and pre is not null and left(s, length(pre)) = pre and length(s) >= length(pre) + 7 then
    s := '+' || s;
  end if;
  if length(regexp_replace(s, '\D', '', 'g')) < 5 then return null; end if;
  return s;
end $$;

create or replace function public.hitta_poster_pa_telefon(p_nummer text)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_t uuid := my_tenant_id(); v_land text; v_n text;
begin
  if v_t is null then return '[]'::jsonb; end if;
  select coalesce(standardland, 'SE') into v_land from leaddesk_installningar where tenant_id = v_t;
  v_n := leaddesk_telefon_norm(p_nummer, coalesce(v_land, 'SE'));
  if v_n is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'objectType', r.object_type, 'objectLabel', o.label_singular,
             'title', coalesce(r.title, ''), 'field', f.key, 'fieldLabel', f.label,
             'status', r.status, 'updatedAt', r.updated_at)
           order by (r.object_type in ('contact','customer','case')) desc, r.updated_at desc)
    from field_definitions f
    join object_definitions o on o.id = f.object_id and o.tenant_id = v_t
    join records r on r.tenant_id = v_t and r.object_type = o.key and r.deleted_at is null
                  and coalesce(r.data->>f.key, '') <> ''
    where f.tenant_id = v_t and f.field_type = 'phone'
      and leaddesk_telefon_norm(r.data->>f.key, coalesce(v_land, 'SE')) = v_n
      and can_row(r.object_type, 'read', r.owner_user_id)
  ), '[]'::jsonb);
end $$;

-- 3. Samtalslogg ----------------------------------------------------------------------
-- LeadDesk-tider saknar tidszon: tolkas i inställningens tidszon (standard Europe/Stockholm).
-- Råvärdena sparas oförändrade i raw.
create or replace function public.leaddesk_tid(p text, p_tz text)
returns timestamptz language plpgsql stable as $$
begin
  if p is null or trim(p) = '' then return null; end if;
  return (p::timestamp) at time zone p_tz;
exception when others then return null;
end $$;

-- Intern: koppla samtal till post + call-aktivitet (bara första gången kopplingen görs).
create or replace function public.leaddesk_lank(p_comm uuid, p_record uuid, p_hur text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_t uuid := my_tenant_id(); v_type text; v_owner uuid; v_ny boolean; c record;
begin
  select object_type, owner_user_id into v_type, v_owner
    from records where id = p_record and tenant_id = v_t and deleted_at is null;
  if v_type is null then raise exception 'Posten finns inte' using errcode = 'P0002'; end if;
  if not can_row(v_type, 'read', v_owner) then
    raise exception 'Saknar behörighet till posten' using errcode = '42501';
  end if;
  insert into communication_links
    (communication_id, record_id, tenant_id, confidence, linked_by, linked_reason, confirmed_at, confirmed_by)
  values (p_comm, p_record, v_t, case when p_hur = 'user' then 1.00 else 0.90 end,
          case when p_hur = 'user' then 'user' else 'address' end,
          case when p_hur = 'user' then 'LeadDesk: kopplat av användaren' else 'LeadDesk: telefonnummer' end,
          now(), auth.uid())
  on conflict do nothing;
  get diagnostics v_ny = row_count;
  if v_ny then
    select * into c from communications where id = p_comm;
    perform log_activity(p_record, 'call', c.subject || coalesce(E'\n' || c.body_text, ''),
      jsonb_build_object('provider', 'leaddesk', 'callId', c.raw->>'id',
                         'communicationId', c.id, 'direction', c.direction,
                         'answered', c.raw->'answered', 'duration', c.raw->'duration'));
    perform emit_event('activity.logged', p_record,
      jsonb_build_object('activityType', 'call', 'provider', 'leaddesk'));
  end if;
  return v_ny;
end $$;

-- p_samtal = Talks completed-objekt (call). p_record_id = posten samtalet hör till (från
-- ringningsögonblicket), eller null. Upprepad completed med samma id ger ingen dubblett.
create or replace function public.leaddesk_spara_samtal(p_samtal jsonb, p_record_id uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_t uuid := my_tenant_id(); v_tz text; v_land text;
  v_id text; v_dir text; v_remote text; v_ans boolean; v_dur int;
  v_subject text; v_comm uuid; v_ny boolean; v_kopplad boolean := false; v_raw jsonb;
begin
  if v_t is null or auth.uid() is null then
    raise exception 'Inte inloggad' using errcode = '42501';
  end if;
  v_id := nullif(trim(coalesce(p_samtal->>'id', '')), '');
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'Samtals-id saknas eller är ogiltigt' using errcode = '22023';
  end if;
  v_dir := case p_samtal->>'direction' when 'in' then 'inbound' when 'out' then 'outbound' end;
  if v_dir is null then raise exception 'Okänd riktning' using errcode = '22023'; end if;

  select coalesce(tidszon, 'Europe/Stockholm'), coalesce(standardland, 'SE') into v_tz, v_land
    from leaddesk_installningar where tenant_id = v_t;
  v_tz := coalesce(v_tz, 'Europe/Stockholm'); v_land := coalesce(v_land, 'SE');

  v_remote := left(case v_dir when 'inbound' then p_samtal->>'from' else p_samtal->>'to' end, 40);
  v_remote := coalesce(leaddesk_telefon_norm(v_remote, v_land), v_remote,
                       leaddesk_telefon_norm(p_samtal->>'number', v_land));
  v_ans := case when jsonb_typeof(p_samtal->'answered') = 'boolean' then (p_samtal->>'answered')::boolean
                when p_samtal->>'answered' in ('1','true') then true
                when p_samtal->>'answered' in ('0','false') then false end;
  v_dur := case when (p_samtal->>'duration') ~ '^\d{1,7}$' then (p_samtal->>'duration')::int end;

  v_subject := case v_dir when 'inbound' then 'Inkommande samtal' else 'Utgående samtal' end
    || coalesce(' ' || v_remote, '')
    || case when v_ans is false then ' (obesvarat)'
            when v_dur is not null then ' · ' || (v_dur / 60) || ' min ' || (v_dur % 60) || ' s' else '' end
    || coalesce(' · ' || nullif(left(p_samtal#>>'{reason,name}', 80), ''), '');

  -- Bara kända fält sparas (inga okända nycklar från meddelandet).
  v_raw := jsonb_strip_nulls(jsonb_build_object(
    'id', v_id, 'direction', p_samtal->>'direction',
    'from', left(p_samtal->>'from', 40), 'to', left(p_samtal->>'to', 40),
    'answered', v_ans, 'duration', v_dur,
    'ringStart', left(p_samtal->>'ringStart', 30), 'callStart', left(p_samtal->>'callStart', 30),
    'talkStart', left(p_samtal->>'talkStart', 30), 'callEnd', left(p_samtal->>'callEnd', 30),
    'reasonName', left(p_samtal#>>'{reason,name}', 200),
    'reasonLogicalName', left(p_samtal#>>'{reason,logicalName}', 200),
    'recordUrl', case when (p_samtal->>'recordUrl') ~ '^https://' then left(p_samtal->>'recordUrl', 1000) end,
    'tidszon', v_tz, 'agentUserId', auth.uid()));

  insert into communications as c
    (tenant_id, channel, direction, provider, external_id, subject, body_text,
     from_address, to_addresses, occurred_at, raw, author_user_id, processing_status)
  values (v_t, 'call', v_dir, 'leaddesk', 'leaddesk:' || v_id, v_subject,
          nullif(left(trim(coalesce(p_samtal->>'comment', '')), 4000), ''),
          case v_dir when 'inbound' then v_remote end,
          case when v_dir = 'outbound' and v_remote is not null then array[v_remote] else '{}'::text[] end,
          coalesce(leaddesk_tid(p_samtal->>'callStart', v_tz), leaddesk_tid(p_samtal->>'ringStart', v_tz),
                   leaddesk_tid(p_samtal->>'callEnd', v_tz), now()),
          v_raw, auth.uid(), 'done')
  on conflict (tenant_id, provider, external_id) do update set
    subject = excluded.subject,
    body_text = coalesce(excluded.body_text, c.body_text),
    raw = c.raw || excluded.raw
  returning id, (xmax = 0) into v_comm, v_ny;

  if p_record_id is not null then
    v_kopplad := leaddesk_lank(v_comm, p_record_id, 'auto');
  end if;
  return jsonb_build_object('communicationId', v_comm, 'ny', v_ny, 'kopplad', v_kopplad);
end $$;

create or replace function public.leaddesk_koppla_samtal(p_communication_id uuid, p_record_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_ok boolean; v_agent uuid;
begin
  select (raw->>'agentUserId')::uuid into v_agent from communications
   where id = p_communication_id and tenant_id = my_tenant_id() and provider = 'leaddesk';
  if not found then raise exception 'Samtalet finns inte' using errcode = 'P0002'; end if;
  if v_agent is distinct from auth.uid() and not is_admin() then
    raise exception 'Bara den som tog samtalet eller en administratör kan koppla det' using errcode = '42501';
  end if;
  v_ok := leaddesk_lank(p_communication_id, p_record_id, 'user');
  return jsonb_build_object('kopplad', v_ok);
end $$;

-- Senaste samtal: egna (admin: alla), med kopplade poster. Inspelningslänk bara till admin.
create or replace function public.leaddesk_mina_samtal(p_limit int default 30)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(x order by x->>'occurredAt' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id, 'callId', c.raw->>'id', 'direction', c.direction, 'subject', c.subject,
      'comment', c.body_text, 'occurredAt', c.occurred_at,
      'remote', coalesce(c.from_address, c.to_addresses[1]),
      'answered', c.raw->'answered', 'duration', c.raw->'duration',
      'reason', c.raw->>'reasonName',
      'recordUrl', case when is_admin() then c.raw->>'recordUrl' end,
      'egen', (c.raw->>'agentUserId') = auth.uid()::text,
      'poster', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title, 'objectType', r.object_type))
                 from communication_links l join records r on r.id = l.record_id and r.deleted_at is null
                 where l.communication_id = c.id and can_row(r.object_type, 'read', r.owner_user_id)), '[]'::jsonb)
    ) x
    from communications c
    where c.tenant_id = my_tenant_id() and c.provider = 'leaddesk'
      and ((c.raw->>'agentUserId') = auth.uid()::text or is_admin())
    order by c.occurred_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) s
$$;

revoke all on function public.leaddesk_lank(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.leaddesk_installningar_hamta() from public, anon;
revoke all on function public.leaddesk_installningar_spara(jsonb) from public, anon;
revoke all on function public.hitta_poster_pa_telefon(text) from public, anon;
revoke all on function public.leaddesk_spara_samtal(jsonb, uuid) from public, anon;
revoke all on function public.leaddesk_koppla_samtal(uuid, uuid) from public, anon;
revoke all on function public.leaddesk_mina_samtal(int) from public, anon;
grant execute on function public.leaddesk_installningar_hamta() to authenticated;
grant execute on function public.leaddesk_installningar_spara(jsonb) to authenticated;
grant execute on function public.hitta_poster_pa_telefon(text) to authenticated;
grant execute on function public.leaddesk_spara_samtal(jsonb, uuid) to authenticated;
grant execute on function public.leaddesk_koppla_samtal(uuid, uuid) to authenticated;
grant execute on function public.leaddesk_mina_samtal(int) to authenticated;
