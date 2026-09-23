-- =============================================================================
-- 0009 — Admin-RPCs för fälthantering
-- =============================================================================
-- Låter admin lägga till, uppdatera och ta bort fältdefinitioner.
-- Kräver att anropande user har admin-roll.
-- =============================================================================

-- ── Uppdatera get_metadata: inkludera visibility i fältdefinitioner ──────────
create or replace function public.get_metadata()
returns jsonb language sql stable security definer as $$
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
          'helpText', fd.help_text, 'sortOrder', fd.sort_order,
          'visibility', fd.visibility
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

-- ── Hjälpfunktion: kontrollera admin ────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.user_roles ur
    join   public.roles r on r.id = ur.role_id
    where  ur.user_id = auth.uid()
      and  r.key = 'admin'
  );
$$;

-- ── Skapa fält ──────────────────────────────────────────────────────────────
create or replace function public.admin_create_field(
  p_object_type  text,
  p_key          text,
  p_label        text,
  p_field_type   text default 'text',
  p_is_required  boolean default false,
  p_options      jsonb default '{}'::jsonb,
  p_help_text    text default null,
  p_sort_order   integer default null
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant  uuid;
  v_obj_id  uuid;
  v_sort    integer;
  v_field   record;
begin
  if not public.is_admin() then
    raise exception 'Åtkomst nekad — admin krävs.';
  end if;

  select tenant_id into v_tenant
    from public.users where id = auth.uid();

  select id into v_obj_id
    from public.object_definitions
   where tenant_id = v_tenant and key = p_object_type;

  if v_obj_id is null then
    raise exception 'Objekttyp "%" finns ej.', p_object_type;
  end if;

  -- Auto sort_order om ej angiven
  if p_sort_order is null then
    select coalesce(max(sort_order), 0) + 10 into v_sort
      from public.field_definitions
     where object_id = v_obj_id;
  else
    v_sort := p_sort_order;
  end if;

  insert into public.field_definitions
    (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, help_text, visibility, sort_order)
  values
    (v_obj_id, v_tenant, p_key, p_label, p_field_type, p_is_required, false, p_options, p_help_text, 'all', v_sort)
  returning * into v_field;

  return jsonb_build_object(
    'id', v_field.id,
    'key', v_field.key,
    'label', v_field.label,
    'field_type', v_field.field_type,
    'sort_order', v_field.sort_order
  );
end;
$$;

-- ── Uppdatera fält (label, visibility, sort_order, options, etc.) ───────────
create or replace function public.admin_update_field(
  p_object_type  text,
  p_key          text,
  p_updates      jsonb
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant  uuid;
  v_obj_id  uuid;
  v_field   record;
begin
  if not public.is_admin() then
    raise exception 'Åtkomst nekad — admin krävs.';
  end if;

  select tenant_id into v_tenant
    from public.users where id = auth.uid();

  select id into v_obj_id
    from public.object_definitions
   where tenant_id = v_tenant and key = p_object_type;

  if v_obj_id is null then
    raise exception 'Objekttyp "%" finns ej.', p_object_type;
  end if;

  update public.field_definitions set
    label       = coalesce(p_updates->>'label',      label),
    visibility  = coalesce(p_updates->>'visibility',  visibility),
    sort_order  = coalesce((p_updates->>'sort_order')::int, sort_order),
    options     = case when p_updates ? 'options' then (p_updates->'options') else options end,
    help_text   = case when p_updates ? 'help_text' then (p_updates->>'help_text') else help_text end,
    is_required = coalesce((p_updates->>'is_required')::boolean, is_required)
  where object_id = v_obj_id and key = p_key
  returning * into v_field;

  if v_field is null then
    raise exception 'Fält "%" hittades inte på "%".', p_key, p_object_type;
  end if;

  return jsonb_build_object('ok', true, 'key', v_field.key, 'visibility', v_field.visibility, 'sort_order', v_field.sort_order);
end;
$$;

-- ── Ta bort fält ────────────────────────────────────────────────────────────
create or replace function public.admin_delete_field(
  p_object_type  text,
  p_key          text
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant  uuid;
  v_obj_id  uuid;
  v_deleted text;
begin
  if not public.is_admin() then
    raise exception 'Åtkomst nekad — admin krävs.';
  end if;

  select tenant_id into v_tenant
    from public.users where id = auth.uid();

  select id into v_obj_id
    from public.object_definitions
   where tenant_id = v_tenant and key = p_object_type;

  if v_obj_id is null then
    raise exception 'Objekttyp "%" finns ej.', p_object_type;
  end if;

  delete from public.field_definitions
  where object_id = v_obj_id and key = p_key
  returning key into v_deleted;

  if v_deleted is null then
    raise exception 'Fält "%" hittades inte på "%".', p_key, p_object_type;
  end if;

  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

-- ── Batch-uppdatera sort_order (för drag-and-drop) ──────────────────────────
create or replace function public.admin_reorder_fields(
  p_object_type  text,
  p_order        jsonb  -- [{"key": "name", "sort_order": 10}, ...]
)
returns jsonb language plpgsql security definer as $$
declare
  v_tenant  uuid;
  v_obj_id  uuid;
  v_item    jsonb;
begin
  if not public.is_admin() then
    raise exception 'Åtkomst nekad — admin krävs.';
  end if;

  select tenant_id into v_tenant
    from public.users where id = auth.uid();

  select id into v_obj_id
    from public.object_definitions
   where tenant_id = v_tenant and key = p_object_type;

  if v_obj_id is null then
    raise exception 'Objekttyp "%" finns ej.', p_object_type;
  end if;

  for v_item in select * from jsonb_array_elements(p_order)
  loop
    update public.field_definitions
       set sort_order = (v_item->>'sort_order')::int
     where object_id = v_obj_id
       and key = v_item->>'key';
  end loop;

  return jsonb_build_object('ok', true, 'updated', jsonb_array_length(p_order));
end;
$$;
