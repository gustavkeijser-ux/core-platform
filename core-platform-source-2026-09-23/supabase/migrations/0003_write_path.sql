-- =============================================================================
-- 0003 — Skrivvägen
-- =============================================================================
--
-- DEN ENDA VÄGEN IN I `records`.
--
-- Klienten har inga insert-, update- eller delete-rättigheter (se 0002), så
-- detta är inte en konvention utan en spärr. Varje funktion gör fem saker i
-- samma transaktion:
--
--   1. behörighetskontroll
--   2. validering mot metadata
--   3. skrivning
--   4. aktivitet på tidslinjen + audit-rad
--   5. event
--
-- Alla är SECURITY DEFINER och sätter search_path explicit. Utan det kan en
-- angripare med rätt att skapa objekt i sitt eget schema kapa funktionen.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Validering mot fältdefinitionerna
-- -----------------------------------------------------------------------------
--
-- Returnerar normaliserad data eller kastar ett fel med SQLSTATE 22023, som
-- PostgREST översätter till HTTP 400 med meddelandet i felkroppen.
--
-- Två regler:
--   Okända nycklar avvisas. Annars fylls JSONB-kolumnen med stavfel som
--   ingen märker förrän en rapport ser konstig ut.
--   Värden lagras kanoniskt. Datum är alltid YYYY-MM-DD, tal är alltid
--   numeriska, annars fungerar varken sortering eller genererade kolumner.

create function public.validate_record_data(
  p_object_id uuid,
  p_data      jsonb,
  p_mode      text
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  f        record;
  v_key    text;
  v_raw    jsonb;
  v_out    jsonb := '{}'::jsonb;
  v_valid  text[];
  v_issues text[] := '{}';
begin
  select array_agg(key) into v_valid
    from field_definitions where object_id = p_object_id;

  for v_key in select jsonb_object_keys(p_data) loop
    if not (v_key = any(coalesce(v_valid, '{}'))) then
      v_issues := v_issues || format('%s: fältet finns inte på objektet', v_key);
    end if;
  end loop;

  for f in
    select key, label, field_type, is_required, options
      from field_definitions where object_id = p_object_id order by sort_order
  loop
    -- Vid update rörs bara fält som faktiskt skickats in. Att tolka en
    -- utelämnad nyckel som "sätt till null" gör partiella uppdateringar
    -- omöjliga och är en klassisk källa till dataförlust.
    if not (p_data ? f.key) then
      if p_mode = 'create' and f.is_required then
        v_issues := v_issues || format('%s är obligatoriskt', f.label);
      end if;
      continue;
    end if;

    v_raw := p_data -> f.key;

    if v_raw is null or jsonb_typeof(v_raw) = 'null'
       or (jsonb_typeof(v_raw) = 'string' and v_raw #>> '{}' = '') then
      if f.is_required then
        v_issues := v_issues || format('%s är obligatoriskt', f.label);
      else
        v_out := v_out || jsonb_build_object(f.key, null);
      end if;
      continue;
    end if;

    case f.field_type

      when 'number', 'currency', 'percent' then
        begin
          v_out := v_out || jsonb_build_object(
            f.key, to_jsonb((v_raw #>> '{}')::numeric));
        exception when others then
          v_issues := v_issues || format('%s måste vara ett tal', f.label);
        end;

      when 'boolean' then
        if jsonb_typeof(v_raw) <> 'boolean' then
          v_issues := v_issues || format('%s måste vara true eller false', f.label);
        else
          v_out := v_out || jsonb_build_object(f.key, v_raw);
        end if;

      when 'date' then
        begin
          v_out := v_out || jsonb_build_object(
            f.key, to_char((v_raw #>> '{}')::date, 'YYYY-MM-DD'));
        exception when others then
          v_issues := v_issues || format('%s måste vara ett datum (ÅÅÅÅ-MM-DD)', f.label);
        end;

      when 'datetime' then
        begin
          v_out := v_out || jsonb_build_object(
            f.key, to_char((v_raw #>> '{}')::timestamptz, 'YYYY-MM-DD"T"HH24:MI:SSOF'));
        exception when others then
          v_issues := v_issues || format('%s måste vara en giltig tidpunkt', f.label);
        end;

      when 'email' then
        if (v_raw #>> '{}') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
          v_issues := v_issues || format('%s är inte en giltig e-postadress', f.label);
        else
          v_out := v_out || jsonb_build_object(f.key, lower(trim(v_raw #>> '{}')));
        end if;

      when 'user' then
        begin
          v_out := v_out || jsonb_build_object(f.key, (v_raw #>> '{}')::uuid);
        exception when others then
          v_issues := v_issues || format('%s måste vara ett användar-id', f.label);
        end;

      when 'select' then
        -- free_text betyder att listan växer under drift. Att kräva en
        -- administratör för varje nytt värde vore fel.
        if coalesce((f.options ->> 'free_text')::boolean, false) = false
           and f.options ? 'choices'
           and not exists (
             select 1 from jsonb_array_elements(f.options -> 'choices') c
              where c ->> 'key' = v_raw #>> '{}')
        then
          v_issues := v_issues || format('%s har ett okänt värde', f.label);
        else
          v_out := v_out || jsonb_build_object(f.key, v_raw #>> '{}');
        end if;

      when 'multi_select' then
        if jsonb_typeof(v_raw) <> 'array' then
          v_issues := v_issues || format('%s måste vara en lista', f.label);
        elsif coalesce((f.options ->> 'free_text')::boolean, false) = false
              and f.options ? 'choices'
              and exists (
                select 1 from jsonb_array_elements_text(v_raw) v
                 where not exists (
                   select 1 from jsonb_array_elements(f.options -> 'choices') c
                    where c ->> 'key' = v))
        then
          v_issues := v_issues || format('%s innehåller okända värden', f.label);
        else
          v_out := v_out || jsonb_build_object(f.key, v_raw);
        end if;

      when 'address', 'json' then
        if jsonb_typeof(v_raw) <> 'object' then
          v_issues := v_issues || format('%s måste vara ett objekt', f.label);
        else
          v_out := v_out || jsonb_build_object(f.key, v_raw);
        end if;

      else
        v_out := v_out || jsonb_build_object(f.key, trim(v_raw #>> '{}'));

    end case;
  end loop;

  if array_length(v_issues, 1) > 0 then
    raise exception 'Ogiltig data: %', array_to_string(v_issues, '; ')
      using errcode = '22023';
  end if;

  return v_out;
end
$$;

-- -----------------------------------------------------------------------------
-- Sidoeffekter
-- -----------------------------------------------------------------------------

create function public.log_activity(
  p_record_id uuid, p_type text, p_body text, p_metadata jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into activities
    (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (my_tenant_id(), p_record_id, p_type, p_body, p_metadata, auth.uid(), 'user')
$$;

create function public.emit_event(
  p_type text, p_record_id uuid, p_payload jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into events
    (tenant_id, event_type, subject_record_id, payload, actor_user_id, actor_kind)
  values (my_tenant_id(), p_type, p_record_id, p_payload, auth.uid(), 'user')
$$;

create function public.write_audit(
  p_action text, p_object_type text, p_object_id uuid,
  p_before jsonb, p_after jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into audit_log
    (tenant_id, actor_kind, actor_id, action, object_type, object_id, before, after)
  values (my_tenant_id(), 'user', auth.uid(), p_action, p_object_type,
          p_object_id, p_before, p_after)
$$;

-- -----------------------------------------------------------------------------
-- Skapa
-- -----------------------------------------------------------------------------

create function public.create_record(
  p_object_type text,
  p_data        jsonb default '{}'::jsonb,
  p_status      text default null,
  p_owner       uuid default null
) returns public.records
language plpgsql security definer set search_path = public as $$
declare
  v_obj    object_definitions%rowtype;
  v_data   jsonb;
  v_status text;
  v_row    records%rowtype;
begin
  if my_tenant_id() is null then
    raise exception 'Ingen tenant i token' using errcode = '42501';
  end if;

  select * into v_obj from object_definitions
   where tenant_id = my_tenant_id() and key = p_object_type and is_active;
  if not found then
    raise exception 'Okänd objekttyp: %', p_object_type using errcode = '22023';
  end if;

  if not can_do(p_object_type, 'create') then
    raise exception 'Saknar behörighet att skapa %', p_object_type
      using errcode = '42501';
  end if;

  -- Att sätta ägare till någon annan än sig själv är ett bredare privilegium
  -- än att bara skapa posten. Utan den här spärren kunde en användare med
  -- department-scope tilldela vem som helst i avdelningen som ägare och
  -- därigenom kringgå en snävare 'own'-scope som sätts senare.
  if p_owner is not null and p_owner <> auth.uid()
     and my_scope(p_object_type, 'create') is distinct from 'tenant'
  then
    raise exception 'Saknar behörighet att sätta ägare till en annan användare'
      using errcode = '42501';
  end if;

  v_data := validate_record_data(v_obj.id, p_data, 'create');

  v_status := coalesce(
    p_status,
    (select key from status_definitions where object_id = v_obj.id and is_initial)
  );
  if v_status is not null and not exists (
    select 1 from status_definitions where object_id = v_obj.id and key = v_status)
  then
    raise exception 'Okänd status % för %', v_status, p_object_type
      using errcode = '22023';
  end if;

  insert into records
    (tenant_id, object_type, data, status, owner_user_id, created_by)
  values
    (my_tenant_id(), p_object_type, v_data, v_status,
     coalesce(p_owner, auth.uid()), auth.uid())
  returning * into v_row;

  perform log_activity(v_row.id, 'record_created', 'Posten skapades', '{}'::jsonb);

  perform write_audit('create', p_object_type, v_row.id, null, v_data);
  perform emit_event('record.created', v_row.id,
    jsonb_build_object('objectType', p_object_type, 'status', v_status));

  return v_row;
end
$$;

-- -----------------------------------------------------------------------------
-- Uppdatera
-- -----------------------------------------------------------------------------

create function public.update_record(
  p_id     uuid,
  p_data   jsonb default null,
  p_status text default null,
  p_owner  uuid default null
) returns public.records
language plpgsql security definer set search_path = public as $$
declare
  v_before  records%rowtype;
  v_obj     object_definitions%rowtype;
  v_patch   jsonb := '{}'::jsonb;
  v_next    jsonb;
  v_status  text;
  v_row     records%rowtype;
  v_key     text;
  v_label   text;
begin
  select * into v_before from records
   where id = p_id and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then
    raise exception 'Ingen post med id %', p_id using errcode = 'P0002';
  end if;

  if not can_row(v_before.object_type, 'update', v_before.owner_user_id) then
    raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
  end if;

  -- Samma spärr som i create_record: omtilldelning till en annan användare
  -- kräver tenant-brett scope, annars kan department-scope missbrukas för
  -- att flytta poster bort från eller till sig själv.
  if p_owner is not null and p_owner <> auth.uid()
     and my_scope(v_before.object_type, 'update') is distinct from 'tenant'
  then
    raise exception 'Saknar behörighet att sätta ägare till en annan användare'
      using errcode = '42501';
  end if;

  select * into v_obj from object_definitions
   where tenant_id = my_tenant_id() and key = v_before.object_type;

  if p_data is not null then
    v_patch := validate_record_data(v_obj.id, p_data, 'update');
  end if;

  v_status := coalesce(p_status, v_before.status);
  if v_status is not null and not exists (
    select 1 from status_definitions where object_id = v_obj.id and key = v_status)
  then
    raise exception 'Okänd status %', v_status using errcode = '22023';
  end if;

  v_next := v_before.data || v_patch;

  update records
     set data = v_next,
         status = v_status,
         owner_user_id = coalesce(p_owner, owner_user_id)
   where id = p_id
  returning * into v_row;

  -- Fältändringar på tidslinjen, så att "vem ändrade det här och när" går
  -- att svara på utan att gräva i audit-loggen.
  for v_key in select jsonb_object_keys(v_patch) loop
    if (v_before.data -> v_key) is distinct from (v_next -> v_key) then
      select label into v_label from field_definitions
       where object_id = v_obj.id and key = v_key;
      perform log_activity(p_id, 'field_change',
        coalesce(v_label, v_key) || ' ändrades',
        jsonb_build_object('field', v_key,
          'from', v_before.data -> v_key, 'to', v_next -> v_key));
    end if;
  end loop;

  if v_before.status is distinct from v_row.status then
    perform log_activity(p_id, 'status_change',
      'Status ändrades till ' || coalesce(
        (select label from status_definitions
          where object_id = v_obj.id and key = v_row.status), 'ingen status'),
      jsonb_build_object('from', v_before.status, 'to', v_row.status));
    perform emit_event('record.status_changed', p_id, jsonb_build_object(
      'objectType', v_before.object_type,
      'from', v_before.status, 'to', v_row.status));
  end if;

  if v_patch <> '{}'::jsonb or p_owner is not null then
    perform emit_event('record.updated', p_id, jsonb_build_object(
      'objectType', v_before.object_type,
      'changedFields', (select jsonb_agg(k) from jsonb_object_keys(v_patch) k)));
  end if;

  perform write_audit('update', v_before.object_type, p_id, v_before.data, v_next);
  return v_row;
end
$$;

-- -----------------------------------------------------------------------------
-- Ta bort (mjuk)
-- -----------------------------------------------------------------------------

create function public.delete_record(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_before records%rowtype;
begin
  select * into v_before from records
   where id = p_id and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then
    raise exception 'Ingen post med id %', p_id using errcode = 'P0002';
  end if;

  if not can_row(v_before.object_type, 'delete', v_before.owner_user_id) then
    raise exception 'Saknar behörighet att ta bort posten' using errcode = '42501';
  end if;

  update records set deleted_at = now() where id = p_id;
  perform write_audit('delete', v_before.object_type, p_id, v_before.data, null);
  perform emit_event('record.deleted', p_id,
    jsonb_build_object('objectType', v_before.object_type));
end
$$;

-- -----------------------------------------------------------------------------
-- Relationer
-- -----------------------------------------------------------------------------

create function public.add_relation(
  p_from uuid, p_rel_type text, p_to uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_def       relationship_definitions%rowtype;
  v_from_type text;
  v_to_type   text;
  v_from_owner uuid;
begin
  select object_type, owner_user_id into v_from_type, v_from_owner
    from records where id = p_from and tenant_id = my_tenant_id() and deleted_at is null;
  select object_type into v_to_type
    from records where id = p_to and tenant_id = my_tenant_id() and deleted_at is null;

  if v_from_type is null or v_to_type is null then
    raise exception 'En av posterna finns inte' using errcode = 'P0002';
  end if;

  if not can_row(v_from_type, 'update', v_from_owner) then
    raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
  end if;

  select * into v_def from relationship_definitions
   where tenant_id = my_tenant_id() and rel_type = p_rel_type;
  if not found then
    raise exception 'Okänd relationstyp %', p_rel_type using errcode = '22023';
  end if;

  if v_from_type <> v_def.from_object or v_to_type <> v_def.to_object then
    raise exception 'Relationen % går från % till %, inte från % till %',
      p_rel_type, v_def.from_object, v_def.to_object, v_from_type, v_to_type
      using errcode = '22023';
  end if;

  -- many_to_one och one_to_one får bara ha en kant utåt. Ersätt i stället
  -- för att avvisa: användaren flyttar en post till en ny förälder, och att
  -- kräva att den gamla kopplingen tas bort först vore ett steg utan värde.
  if v_def.cardinality in ('many_to_one', 'one_to_one') then
    delete from relationships where from_record_id = p_from and rel_type = p_rel_type;
  end if;

  -- one_to_many är spegelbilden: en "to"-post får bara höra till en
  -- "from"-post. Om t.ex. delivery_property blir one_to_many (en leverans,
  -- flera fastigheter) ska varje fastighet ändå bara tillhöra en leverans.
  if v_def.cardinality = 'one_to_many' then
    delete from relationships where to_record_id = p_to and rel_type = p_rel_type;
  end if;

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  values (my_tenant_id(), p_from, p_to, p_rel_type)
  on conflict do nothing;

  perform log_activity(p_from, 'relation_change',
    v_def.label_forward || ' kopplades',
    jsonb_build_object('relType', p_rel_type, 'toRecordId', p_to));
  perform emit_event('relationship.created', p_from,
    jsonb_build_object('relType', p_rel_type, 'toRecordId', p_to));
end
$$;

create function public.remove_relation(
  p_from uuid, p_rel_type text, p_to uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare v_type text; v_owner uuid;
begin
  select object_type, owner_user_id into v_type, v_owner
    from records where id = p_from and tenant_id = my_tenant_id();
  if v_type is null then
    raise exception 'Posten finns inte' using errcode = 'P0002';
  end if;
  if not can_row(v_type, 'update', v_owner) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;

  delete from relationships
   where from_record_id = p_from and to_record_id = p_to and rel_type = p_rel_type;
end
$$;

-- -----------------------------------------------------------------------------
-- Metadata till klienten
-- -----------------------------------------------------------------------------
--
-- Ett anrop vid uppstart. Returnerar bara objekttyper användaren får läsa,
-- så det finns aldrig ett menyval i gränssnittet som leder till 403.

create function public.get_metadata() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('objects', coalesce(jsonb_agg(o order by o->>'sortOrder'), '[]'::jsonb))
  from (
    select jsonb_build_object(
      'key', od.key,
      'labelSingular', od.label_singular,
      'labelPlural', od.label_plural,
      'icon', od.icon,
      'titleField', od.title_field,
      'sortOrder', od.sort_order,
      'fields', coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', fd.key, 'label', fd.label, 'fieldType', fd.field_type,
          'isRequired', fd.is_required, 'options', fd.options,
          'helpText', fd.help_text, 'sortOrder', fd.sort_order
        ) order by fd.sort_order)
        from field_definitions fd where fd.object_id = od.id
      ), '[]'::jsonb),
      'statuses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', sd.key, 'label', sd.label, 'color', sd.color,
          'isInitial', sd.is_initial, 'isTerminal', sd.is_terminal
        ) order by sd.sort_order)
        from status_definitions sd where sd.object_id = od.id
      ), '[]'::jsonb),
      'relations', jsonb_build_object(
        'outgoing', coalesce((
          select jsonb_agg(to_jsonb(r)) from (
            select rel_type as "relType", from_object as "fromObject",
                   to_object as "toObject", cardinality,
                   label_forward as "labelForward", label_reverse as "labelReverse",
                   is_required as "isRequired"
              from relationship_definitions
             where tenant_id = od.tenant_id and from_object = od.key) r
        ), '[]'::jsonb),
        'incoming', coalesce((
          select jsonb_agg(to_jsonb(r)) from (
            select rel_type as "relType", from_object as "fromObject",
                   to_object as "toObject", cardinality,
                   label_forward as "labelForward", label_reverse as "labelReverse",
                   is_required as "isRequired"
              from relationship_definitions
             where tenant_id = od.tenant_id and to_object = od.key) r
        ), '[]'::jsonb)
      ),
      'can', jsonb_build_object(
        'create', can_do(od.key, 'create'),
        'update', can_do(od.key, 'update'),
        'delete', can_do(od.key, 'delete')
      )
    ) as o
    from object_definitions od
    where od.tenant_id = my_tenant_id()
      and od.is_active
      and can_do(od.key, 'read')
  ) s
$$;

-- Posten plus dess grannar i objektgrafen, åt båda hållen. RLS på records
-- filtrerar bort grannar användaren inte får se, utan att avslöja att de finns.
create function public.get_record_with_relations(p_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'record', to_jsonb(r),
    'related', coalesce((
      select jsonb_agg(jsonb_build_object(
        'relType', e.rel_type,
        'direction', case when e.from_record_id = r.id then 'outgoing' else 'incoming' end,
        'label', case when e.from_record_id = r.id then rd.label_forward else rd.label_reverse end,
        'record', jsonb_build_object(
          'id', o.id, 'objectType', o.object_type,
          'title', o.title, 'status', o.status)
      ))
      from relationships e
      join records o on o.id = case when e.from_record_id = r.id
                                    then e.to_record_id else e.from_record_id end
      left join relationship_definitions rd
             on rd.tenant_id = r.tenant_id and rd.rel_type = e.rel_type
      where e.from_record_id = r.id or e.to_record_id = r.id
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'type', a.activity_type, 'body', a.body,
        'metadata', a.metadata, 'actorKind', a.actor_kind,
        'actorUserId', a.actor_user_id, 'occurredAt', a.occurred_at
      ) order by a.occurred_at desc)
      from activities a where a.record_id = r.id limit 50
    ), '[]'::jsonb)
  )
  from records r where r.id = p_id
$$;

-- -----------------------------------------------------------------------------
-- Rättigheter
-- -----------------------------------------------------------------------------

grant execute on function
  public.create_record(text, jsonb, text, uuid),
  public.update_record(uuid, jsonb, text, uuid),
  public.delete_record(uuid),
  public.add_relation(uuid, text, uuid),
  public.remove_relation(uuid, text, uuid),
  public.get_metadata(),
  public.get_record_with_relations(uuid),
  public.my_tenant_id(),
  public.can_do(text, text)
to authenticated;

-- Hjälpfunktionerna anropas bara inifrån RLS-policies och andra funktioner.
revoke execute on function
  public.log_activity(uuid, text, text, jsonb),
  public.emit_event(text, uuid, jsonb),
  public.write_audit(text, text, uuid, jsonb, jsonb),
  public.validate_record_data(uuid, jsonb, text)
from public, anon, authenticated;
