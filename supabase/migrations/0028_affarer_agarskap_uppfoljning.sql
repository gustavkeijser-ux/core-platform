-- Affärer, steg 1: ägarskap & fördelning + aktiviteter & uppföljning.
--
--  * "Säljare" på affären blir ett riktigt användarfält och styr ägaren
--    (owner_user_id) — det är ägaren som RLS-scope "own" (rollen Säljare)
--    tittar på, så en B2B-säljare ser exakt sina tilldelade affärer.
--  * Nya fält: Nästa steg, Nästa steg datum, Senaste kontakt.
--  * set_next_step(): sätter nästa steg + datum och ersätter affärens
--    öppna uppföljningsuppgift, så den alltid finns i "Mina uppgifter".
--  * bulk_assign(): tilldela/fördela många poster på en gång (chef/admin).
--  * Loggat samtal/möte/mejl sätter "Senaste kontakt" automatiskt.

-- 1. Fält ---------------------------------------------------------------------
update field_definitions fd
   set field_type = 'user',
       label = 'Säljare',
       options = (fd.options - 'choices') || '{"owner_field": true, "section": "grunduppgifter"}'::jsonb
  from object_definitions od
 where od.id = fd.object_id and od.key = 'deal' and fd.key = 'saljare';

-- Fritext-säljare (om någon finns) kan inte tolkas som användare — rensa.
update records set data = data - 'saljare'
 where object_type = 'deal' and data ? 'saljare'
   and coalesce(data->>'saljare', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.typ, false, v.opts::jsonb, v.sort
  from object_definitions od
 cross join (values
   ('nasta_steg',       'Nästa steg',       'text',     '{"section":"uppfoljning"}', 900),
   ('nasta_steg_datum', 'Nästa steg datum', 'date',     '{"section":"uppfoljning","_overdue":true}', 901),
   ('senaste_kontakt',  'Senaste kontakt',  'datetime', '{"section":"uppfoljning"}', 902)
 ) as v(key, label, typ, opts, sort)
 where od.key = 'deal'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- Standardkolumner i Affärer (om inga kolumner valts ännu).
do $$
declare o record;
begin
  for o in select id from object_definitions where key = 'deal' loop
    if not exists (select 1 from field_definitions where object_id = o.id and options ? '_column') then
      update field_definitions f
         set options = f.options || jsonb_build_object('_column', true, '_column_order', v.n)
                     || case when v.k = 'saljare' then '{"_status_after":true}'::jsonb else '{}'::jsonb end
        from (values ('saljare',0),('nasta_steg_datum',1),('nasta_steg',2),('senaste_kontakt',3),
                     ('antal_hushall',4),('value',5)) as v(k, n)
       where f.object_id = o.id and f.key = v.k;
    end if;
  end loop;
end $$;

-- 2. Säljare <-> ägare ----------------------------------------------------------
create or replace function public.deal_sync_saljare()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_new uuid; v_old uuid;
begin
  if new.object_type <> 'deal' then return new; end if;

  v_new := nullif(new.data->>'saljare', '')::uuid;
  v_old := case when tg_op = 'UPDATE' then nullif(old.data->>'saljare', '')::uuid end;

  if tg_op = 'INSERT' or v_new is distinct from v_old then
    -- Bara den som får ändra alla affärer (chef/admin) får tilldela någon
    -- annan; en säljare kan bara ta en affär själv.
    if auth.uid() is not null and v_new is distinct from auth.uid()
       and public.my_scope('deal', 'update') is distinct from 'tenant'
       and tg_op = 'UPDATE' then
      raise exception 'Saknar behörighet att tilldela affären till någon annan'
        using errcode = '42501';
    end if;
    if v_new is not null then
      new.owner_user_id := v_new;
    end if;
  elsif tg_op = 'UPDATE' and new.owner_user_id is distinct from old.owner_user_id
        and new.owner_user_id is not null then
    -- Ägaren ändrad på annat sätt → spegla till Säljare.
    new.data := new.data || jsonb_build_object('saljare', new.owner_user_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_deal_sync_saljare on public.records;
create trigger trg_deal_sync_saljare
  before insert or update on public.records
  for each row when (new.object_type = 'deal')
  execute function public.deal_sync_saljare();

-- 3. Aktiviteter: e-post som snabbloggtyp + Senaste kontakt ---------------------
create or replace function public.add_quick_activity(p_record_id uuid, p_type text, p_body text)
returns void language plpgsql security definer set search_path = public as $function$
declare v_type text; v_owner uuid;
begin
  if p_type not in ('note', 'call', 'meeting', 'email') then
    raise exception 'Ogiltig aktivitetstyp för manuell loggning: %', p_type
      using errcode = '22023';
  end if;
  if p_body is null or trim(p_body) = '' then
    raise exception 'Anteckningen kan inte vara tom' using errcode = '22023';
  end if;

  select object_type, owner_user_id into v_type, v_owner
    from records where id = p_record_id and tenant_id = my_tenant_id() and deleted_at is null;
  if v_type is null then
    raise exception 'Posten finns inte' using errcode = 'P0002';
  end if;
  if not can_row(v_type, 'update', v_owner) then
    raise exception 'Saknar behörighet att logga på posten' using errcode = '42501';
  end if;

  perform log_activity(p_record_id, p_type, trim(p_body), '{}'::jsonb);
  perform emit_event('activity.logged', p_record_id,
    jsonb_build_object('activityType', p_type));
end
$function$;

create or replace function public.deal_touch_senaste_kontakt()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.activity_type in ('call', 'meeting', 'email') then
    update records
       set data = data || jsonb_build_object('senaste_kontakt',
             to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     where id = new.record_id and object_type = 'deal';
  end if;
  return new;
end $$;

drop trigger if exists trg_deal_touch_senaste_kontakt on public.activities;
create trigger trg_deal_touch_senaste_kontakt
  after insert on public.activities
  for each row execute function public.deal_touch_senaste_kontakt();

-- 4. Nästa steg -----------------------------------------------------------------
alter table public.tasks drop constraint if exists tasks_source;
alter table public.tasks add constraint tasks_source check (created_source = any (array[
  'user','workflow','ai','integration','checklist','status','next_step']));

create or replace function public.set_next_step(p_record_id uuid, p_text text, p_date date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row records; v_task uuid; v_assignee uuid;
begin
  -- update_record gör behörighetskontroll + validering + fältlogg.
  v_row := public.update_record(p_record_id, jsonb_build_object(
    'nasta_steg', nullif(trim(coalesce(p_text, '')), ''),
    'nasta_steg_datum', p_date));

  -- Ersätt affärens öppna uppföljningsuppgift.
  update tasks set completed_at = now(), completed_by = auth.uid()
   where record_id = p_record_id and created_source = 'next_step' and completed_at is null;

  if p_date is not null then
    v_assignee := coalesce(v_row.owner_user_id, auth.uid());
    insert into tasks (tenant_id, record_id, title, assignee_user_id, priority, due_at, created_by, created_source)
    values (v_row.tenant_id, p_record_id,
            coalesce(nullif(trim(coalesce(p_text, '')), ''), 'Följ upp') || ' – ' || coalesce(v_row.title, 'affär'),
            v_assignee, 'normal',
            (p_date::timestamp + time '09:00') at time zone 'Europe/Stockholm',
            auth.uid(), 'next_step')
    returning id into v_task;
  end if;

  return jsonb_build_object('record', to_jsonb(v_row), 'taskId', v_task);
end $$;

-- 5. Tilldela / fördela många poster ------------------------------------------------
create or replace function public.bulk_assign(p_ids uuid[], p_user_ids uuid[], p_field text default 'saljare')
returns integer language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_i int := 0; v_n int; v_type text;
begin
  v_n := coalesce(array_length(p_user_ids, 1), 0);
  if v_n = 0 then
    raise exception 'Välj minst en säljare' using errcode = '22023';
  end if;
  foreach v_id in array p_ids loop
    select object_type into v_type from records where id = v_id and tenant_id = my_tenant_id();
    if v_type is null then continue; end if;
    if public.my_scope(v_type, 'update') is distinct from 'tenant' then
      raise exception 'Saknar behörighet att fördela poster' using errcode = '42501';
    end if;
    -- Round-robin: 1 säljare = alla till hen, flera = jämn fördelning.
    perform public.update_record(v_id, jsonb_build_object(p_field, p_user_ids[(v_i % v_n) + 1]));
    v_i := v_i + 1;
  end loop;
  return v_i;
end $$;

grant execute on function public.set_next_step(uuid, text, date) to authenticated;
grant execute on function public.bulk_assign(uuid[], uuid[], text) to authenticated;
