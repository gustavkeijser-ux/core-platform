-- =====================================================================
--  0060 — Ärenden enligt Fas 3-skisserna:
--   • list_arenden: ärendelistan med kombinerbara filter (status,
--     kategori, prioritet, ansvarig), sortering och antal per färdig vy
--     (Mina, Nya, Försenade, Väntar på svar, Ej tilldelade).
--   • arende_skapa: Skapa ärende i fyra steg (vem, var, vad,
--     hantering) i ett anrop.
--   • case_set_deadline: deadline kan sättas och ändras för hand.
--   • case_liknande: liknande öppna ärenden på samma objekt/fastighet.
--   • Statusfärger enligt designsystemet: blå = pågående, amber =
--     väntande, grön = klar, grå = inaktiv.
-- =====================================================================

create or replace function public.list_arenden(
  p_filter text default 'open', p_search text default null,
  p_status text default null, p_category text default null, p_priority text default null,
  p_owner text default null, p_sort text default 'deadline',
  p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := my_tenant_id(); v_scope text; v_q text := nullif(trim(coalesce(p_search, '')), '');
        v_res jsonb; v_counts jsonb;
begin
  if not can_do('case', 'read') then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  v_scope := my_scope('case', 'read');

  with base as (
    select r.*,
           nullif(r.data->>'first_response_at', '')::timestamptz as fra,
           nullif(r.data->>'first_response_due_at', '')::timestamptz as frd,
           nullif(r.data->>'resolution_due_at', '')::timestamptz as rd,
           nullif(r.data->>'resolved_at', '')::timestamptz as rat,
           coalesce(nullif(r.data->>'last_activity_at', '')::timestamptz, r.updated_at) as lat
      from records r
     where r.tenant_id = v_tenant and r.object_type = 'case' and r.deleted_at is null
       and in_scope(v_scope, r.owner_user_id)
  ), scored as (
    select b.*,
      case when b.status in ('resolved', 'closed') then null
           when b.fra is null then public.case_sla_state(b.created_at, b.frd, null)
           else public.case_sla_state(b.created_at, b.rd, b.rat) end as sla,
      case when b.status in ('resolved', 'closed') then null
           when b.fra is null then least(b.frd, b.rd) else b.rd end as next_due
      from base b
  ), sokt as (
    select * from scored r
     where (v_q is null
            or r.data->>'case_number' ilike '%' || v_q || '%'
            or r.title ilike '%' || v_q || '%'
            or r.data->>'kund_epost' ilike '%' || v_q || '%'
            or r.data->>'kund_namn' ilike '%' || v_q || '%'
            or r.data->>'fastighet_namn' ilike '%' || v_q || '%'
            or r.data->>'lagenhet_namn' ilike '%' || v_q || '%'
            or exists (select 1 from communication_links cl join communications cm on cm.id = cl.communication_id
                        where cl.record_id = r.id
                          and (cm.search @@ websearch_to_tsquery('swedish', v_q)
                               or cm.from_address ilike '%' || v_q || '%'
                               or cm.subject ilike '%' || v_q || '%')))
       and (p_status is null or r.status = any(string_to_array(p_status, ',')))
       and (p_category is null or r.data->>'category' = p_category)
       and (p_priority is null or coalesce(r.data->>'priority', 'normal') = p_priority)
       and (p_owner is null
            or (p_owner = 'none' and r.owner_user_id is null)
            or (p_owner = 'me' and r.owner_user_id = auth.uid())
            or (p_owner not in ('none', 'me') and r.owner_user_id::text = p_owner))
  ), filtered as (
    select * from sokt s where case coalesce(p_filter, 'open')
      when 'all' then true
      when 'open' then s.status not in ('resolved', 'closed')
      when 'new' then s.status = 'new'
      when 'mine' then s.owner_user_id = auth.uid() and s.status not in ('resolved', 'closed')
      when 'unassigned' then s.owner_user_id is null and s.status not in ('resolved', 'closed')
      when 'in_progress' then s.status in ('assigned', 'in_progress')
      when 'waiting' then s.status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')
      when 'waiting_customer' then s.status = 'waiting_customer'
      when 'waiting_internal' then s.status = 'waiting_internal'
      when 'waiting_contractor' then s.status = 'waiting_contractor'
      when 'resolved' then s.status = 'resolved'
      when 'closed' then s.status in ('resolved', 'closed')
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
        'kundEpost', f.data->>'kund_epost', 'kundNamn', nullif(f.data->>'kund_namn', ''),
        'fastighet', f.data->>'fastighet_namn', 'lagenhet', f.data->>'lagenhet_namn',
        'ownerUserId', f.owner_user_id, 'channel', f.data->>'channel',
        'lastActivityAt', f.lat, 'createdAt', f.created_at, 'sla', f.sla, 'nextDue', f.next_due,
        'deadline', f.rd, 'firstResponseAt', f.fra,
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
        case when p_sort = 'created' then extract(epoch from f.created_at) * -1 end,
        case when p_sort = 'activity' then extract(epoch from f.lat) * -1 end,
        case when p_sort = 'priority' or p_sort is null or p_sort = 'deadline'
             then case when f.status in ('resolved', 'closed') then 1 else 0 end end,
        case when p_sort = 'priority' then
          case f.data->>'priority' when 'urgent' then 0 when 'critical' then 1 when 'high' then 2 else 3 end end,
        f.next_due asc nulls last, f.lat desc
      limit greatest(least(coalesce(p_limit, 50), 500), 1) offset greatest(coalesce(p_offset, 0), 0)) q), '[]'::jsonb)
  ) into v_res;

  select jsonb_build_object(
    'open',       count(*) filter (where status not in ('resolved', 'closed')),
    'new',        count(*) filter (where status = 'new'),
    'mine',       count(*) filter (where owner_user_id = auth.uid() and status not in ('resolved', 'closed')),
    'unassigned', count(*) filter (where owner_user_id is null and status not in ('resolved', 'closed')),
    'in_progress', count(*) filter (where status in ('assigned', 'in_progress')),
    'waiting',    count(*) filter (where status in ('waiting_customer', 'waiting_internal', 'waiting_contractor')),
    'overdue',    count(*) filter (where status not in ('resolved', 'closed')
                    and (case when nullif(data->>'first_response_at', '') is null
                              then least(nullif(data->>'first_response_due_at', '')::timestamptz, nullif(data->>'resolution_due_at', '')::timestamptz)
                              else nullif(data->>'resolution_due_at', '')::timestamptz end) < now()),
    'closed',     count(*) filter (where status in ('resolved', 'closed')),
    'all',        count(*))
    into v_counts
    from records r
   where r.tenant_id = v_tenant and r.object_type = 'case' and r.deleted_at is null
     and in_scope(v_scope, r.owner_user_id);

  return v_res || jsonb_build_object('counts', v_counts);
end $$;
revoke all on function public.list_arenden(text, text, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.list_arenden(text, text, text, text, text, text, text, integer, integer) to authenticated;

-- Deadline för hand (åsidosätter SLA-policyns förslag tills prioriteten ändras).
create or replace function public.case_set_deadline(p_case uuid, p_deadline timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare c records;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id()
     and object_type = 'case' and deleted_at is null for update;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then
    raise exception 'Saknar behörighet att ändra ärendet' using errcode = '42501';
  end if;
  update records set data = data || jsonb_build_object(
      'resolution_due_at', case when p_deadline is null then null
                                else to_char(p_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'last_activity_at', public.ce_iso(now()))
   where id = p_case;
  insert into activities (tenant_id, record_id, activity_type, body, actor_user_id, actor_kind)
  values (c.tenant_id, p_case, 'field_change',
          case when p_deadline is null then 'Deadline togs bort'
               else 'Deadline: ' || to_char(p_deadline at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI') end,
          auth.uid(), 'user');
end $$;
revoke all on function public.case_set_deadline(uuid, timestamptz) from public, anon;
grant execute on function public.case_set_deadline(uuid, timestamptz) to authenticated;

-- Nya ärendefält: kundens namn, beskrivning och planerad åtgärd.
insert into field_definitions (object_id, tenant_id, key, label, field_type, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.typ, v.so
  from object_definitions od,
       (values ('kund_namn', 'Kundens namn', 'text', 85), ('beskrivning', 'Beskrivning', 'long_text', 86),
               ('planerad_atgard', 'Planerad åtgärd', 'text', 87)) v(key, label, typ, so)
 where od.key = 'case'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- Skapa ärende: vem, var, vad och hantering i ett anrop. Kategori är
-- obligatorisk på ärenden, så posten skapas direkt med den.
create or replace function public.arende_skapa(
  p_title text, p_channel text default 'phone', p_kund_epost text default null, p_kund_namn text default null,
  p_kund_telefon text default null, p_body text default null, p_priority text default 'normal',
  p_category text default null, p_ansvarig uuid default null, p_deadline timestamptz default null,
  p_atgard text default null, p_lagenhet uuid default null, p_property uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_row records; v_cat text;
begin
  if coalesce(trim(p_title), '') = '' and coalesce(trim(p_body), '') = '' then
    raise exception 'Ange rubrik eller beskrivning' using errcode = '22023';
  end if;
  v_cat := coalesce(nullif(p_category, ''), (select key from case_categories where tenant_id = my_tenant_id()
                                               and parent_key is null order by (key = 'ovrigt') desc, sort_order limit 1));
  select * into v_row from create_record('case', jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(nullif(trim(p_title), ''), left(trim(p_body), 80)),
    'channel', coalesce(p_channel, 'internal'),
    'priority', coalesce(nullif(p_priority, ''), 'normal'),
    'category', v_cat,
    'ansvarig', p_ansvarig,
    'kund_epost', nullif(trim(coalesce(p_kund_epost, '')), ''),
    'kund_namn', nullif(trim(coalesce(p_kund_namn, '')), ''),
    'kund_telefon', nullif(trim(coalesce(p_kund_telefon, '')), ''),
    'beskrivning', nullif(trim(coalesce(p_body, '')), ''),
    'planerad_atgard', nullif(trim(coalesce(p_atgard, '')), ''))), 'new', null);
  if coalesce(trim(p_body), '') <> '' then perform public.case_add_note(v_row.id, 'Beskrivning: ' || trim(p_body)); end if;
  if p_lagenhet is not null then perform public.case_link(v_row.id, 'case_lagenhet', p_lagenhet); end if;
  if p_property is not null then perform public.case_link(v_row.id, 'case_property', p_property); end if;
  if p_lagenhet is null and p_property is null then perform public.case_autolink(v_row.id); end if;
  if p_deadline is not null then perform public.case_set_deadline(v_row.id, p_deadline); end if;
  return v_row.id;
end $$;
revoke all on function public.arende_skapa(text, text, text, text, text, text, text, text, uuid, timestamptz, text, uuid, uuid) from public, anon;
grant execute on function public.arende_skapa(text, text, text, text, text, text, text, text, uuid, timestamptz, text, uuid, uuid) to authenticated;

-- Gamla "Nytt ärende" föll på att Kategori är obligatorisk: ge den en kategori.
create or replace function public.case_create(p_title text, p_channel text default 'internal', p_kund_epost text default null, p_body text default null)
returns uuid language sql security definer set search_path = public as $$
  select public.arende_skapa(p_title, p_channel, p_kund_epost, null, null, p_body)
$$;

-- Liknande ärenden: samma lägenhet, samma fastighet eller samma kund (12 mån).
create or replace function public.case_liknande(p_lagenhet uuid default null, p_property uuid default null,
                                                p_kund_epost text default null, p_category text default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with c as (
    select r.id, r.title, r.status, r.data, r.created_at,
           exists (select 1 from relationships x where x.from_record_id = r.id and x.rel_type = 'case_lagenhet' and x.to_record_id = p_lagenhet) samma_obj,
           exists (select 1 from relationships x where x.from_record_id = r.id and x.rel_type = 'case_property' and x.to_record_id = p_property) samma_fast,
           (p_kund_epost is not null and lower(r.data->>'kund_epost') = lower(trim(p_kund_epost))) samma_kund
      from records r
     where r.tenant_id = my_tenant_id() and r.object_type = 'case' and r.deleted_at is null
       and can_row('case', 'read', r.owner_user_id)
       and r.created_at > now() - interval '12 months'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'caseNumber', data->>'case_number', 'title', title, 'status', status,
           'createdAt', created_at,
           'varfor', case when samma_obj then 'Samma lägenhet' when samma_fast then 'Samma fastighet' else 'Samma kund' end)
         order by (status in ('resolved', 'closed')), samma_obj desc, (p_category is not null and data->>'category' = p_category) desc, created_at desc), '[]'::jsonb)
    from (select * from c where samma_obj or samma_fast or samma_kund
           order by (status in ('resolved', 'closed')), samma_obj desc, created_at desc limit 5) t
$$;
revoke all on function public.case_liknande(uuid, uuid, text, text) from public, anon;
grant execute on function public.case_liknande(uuid, uuid, text, text) to authenticated;

-- Statusfärger enligt designsystemet (status bärs aldrig av färg ensam).
update status_definitions sd set color = v.color
  from object_definitions od,
       (values ('new', 'blue'), ('assigned', 'blue'), ('in_progress', 'blue'),
               ('waiting_customer', 'amber'), ('waiting_internal', 'amber'), ('waiting_contractor', 'amber'),
               ('resolved', 'green'), ('closed', 'zinc')) v(key, color)
 where od.id = sd.object_id and od.key = 'case' and sd.key = v.key;
