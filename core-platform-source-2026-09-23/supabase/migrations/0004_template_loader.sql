-- =============================================================================
-- 0004 — Mall-laddare
-- =============================================================================
--
-- Importerar en tenant-mall (JSON) direkt i SQL-editorn. Ersätter Node-
-- skriptet, eftersom ett Lovable-projekt inte har någon backend att köra det i.
--
-- Anropas med service-nyckeln, aldrig från klienten:
--
--   select load_tenant_template('{ ... hela mallen ... }'::jsonb);
--
-- Idempotent. Kör om så många gånger du vill; befintliga rader uppdateras
-- på nyckel. Fält raderas aldrig automatiskt — det skulle göra data osynlig.
--
-- Den här funktionen känner inte till någon bransch. Den känner bara till
-- mallformatet. Om du någonsin behöver ändra här för att få in ett nytt
-- företag har något hårdkodats fel.
-- =============================================================================

create function public.load_tenant_template(p_template jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid;
  v_obj      jsonb;
  v_field    jsonb;
  v_status   jsonb;
  v_rel      jsonb;
  v_role     jsonb;
  v_perm     jsonb;
  v_action   text;
  v_agent    jsonb;
  v_dept     jsonb;
  v_object_id uuid;
  v_role_id  uuid;
  v_dept_ids jsonb := '{}'::jsonb;
  v_title    text;
  v_issues   text[] := '{}';
  v_keys     text[];
begin
  -- --- Validering före skrivning ------------------------------------------
  --
  -- Fångar de fel som annars blir kryptiska constraint-violations eller,
  -- värre, tyst trasig konfiguration.

  for v_obj in select * from jsonb_array_elements(p_template -> 'objects') loop
    v_title := coalesce(v_obj ->> 'title_field', 'name');

    -- records.title är en genererad kolumn låst till data->>'name'. Bryts
    -- konventionen slutar listor, sortering och sökning att fungera.
    if v_title <> 'name' then
      v_issues := v_issues || format(
        '%s: title_field måste vara ''name'' så länge records.title är genererad',
        v_obj ->> 'key');
    end if;

    select array_agg(f ->> 'key') into v_keys
      from jsonb_array_elements(v_obj -> 'fields') f;

    if not ('name' = any(coalesce(v_keys, '{}'))) then
      v_issues := v_issues || format('%s: saknar fältet ''name''', v_obj ->> 'key');
    end if;

    if jsonb_array_length(coalesce(v_obj -> 'statuses', '[]'::jsonb)) > 0
       and (select count(*) from jsonb_array_elements(v_obj -> 'statuses') s
             where (s ->> 'is_initial')::boolean) <> 1
    then
      v_issues := v_issues || format(
        '%s: exakt en status måste ha is_initial', v_obj ->> 'key');
    end if;
  end loop;

  select array_agg(o ->> 'key') into v_keys
    from jsonb_array_elements(p_template -> 'objects') o;

  for v_rel in select * from jsonb_array_elements(p_template -> 'relationships') loop
    if not (v_rel ->> 'from_object' = any(v_keys)) then
      v_issues := v_issues || format('relation %s: okänt from_object %s',
        v_rel ->> 'rel_type', v_rel ->> 'from_object');
    end if;
    if not (v_rel ->> 'to_object' = any(v_keys)) then
      v_issues := v_issues || format('relation %s: okänt to_object %s',
        v_rel ->> 'rel_type', v_rel ->> 'to_object');
    end if;
  end loop;

  if array_length(v_issues, 1) > 0 then
    raise exception 'Mallen är ogiltig: %', array_to_string(v_issues, E'\n  ')
      using errcode = '22023';
  end if;

  -- --- Tenant ---------------------------------------------------------------

  insert into tenants (slug, name)
  values (p_template -> 'tenant' ->> 'slug', p_template -> 'tenant' ->> 'name')
  on conflict (slug) do update set name = excluded.name
  returning id into v_tenant;

  -- --- Avdelningar ----------------------------------------------------------

  for v_dept in select * from jsonb_array_elements(p_template -> 'departments') loop
    insert into departments (tenant_id, key, name, sort_order)
    values (v_tenant, v_dept ->> 'key', v_dept ->> 'name',
            coalesce((v_dept ->> 'sort_order')::int, 0))
    on conflict (tenant_id, key) do update
      set name = excluded.name, sort_order = excluded.sort_order;

    v_dept_ids := v_dept_ids || jsonb_build_object(
      v_dept ->> 'key',
      (select id from departments where tenant_id = v_tenant and key = v_dept ->> 'key'));
  end loop;

  -- --- Roller ---------------------------------------------------------------
  --
  -- Rättigheter ersätts helt, så att borttagna rättigheter faktiskt försvinner.
  -- Arv plattas ut en nivå; egna rättigheter vinner över ärvda.

  for v_role in select * from jsonb_array_elements(p_template -> 'roles') loop
    insert into roles (tenant_id, key, name)
    values (v_tenant, v_role ->> 'key', v_role ->> 'name')
    on conflict (tenant_id, key) do update set name = excluded.name
    returning id into v_role_id;

    delete from role_permissions where role_id = v_role_id;

    if v_role ? 'inherits' then
      for v_perm in
        select p from jsonb_array_elements(p_template -> 'roles') r,
                      jsonb_array_elements(r -> 'permissions') p
         where r ->> 'key' = v_role ->> 'inherits'
      loop
        for v_action in select jsonb_array_elements_text(v_perm -> 'actions') loop
          insert into role_permissions (role_id, tenant_id, object_type, action, scope)
          values (v_role_id, v_tenant, v_perm ->> 'object_type', v_action,
                  coalesce(v_perm ->> 'scope', 'own'))
          on conflict (role_id, object_type, action) do nothing;
        end loop;
      end loop;
    end if;

    for v_perm in select * from jsonb_array_elements(v_role -> 'permissions') loop
      for v_action in select jsonb_array_elements_text(v_perm -> 'actions') loop
        insert into role_permissions (role_id, tenant_id, object_type, action, scope)
        values (v_role_id, v_tenant, v_perm ->> 'object_type', v_action,
                coalesce(v_perm ->> 'scope', 'own'))
        on conflict (role_id, object_type, action) do update
          set scope = excluded.scope;
      end loop;
    end loop;
  end loop;

  -- --- Objekt, fält, statusar -----------------------------------------------

  for v_obj in select * from jsonb_array_elements(p_template -> 'objects') loop
    insert into object_definitions
      (tenant_id, key, label_singular, label_plural, icon, title_field, sort_order)
    values (v_tenant, v_obj ->> 'key', v_obj ->> 'label_singular',
            v_obj ->> 'label_plural', v_obj ->> 'icon',
            coalesce(v_obj ->> 'title_field', 'name'),
            coalesce((v_obj ->> 'sort_order')::int, 0))
    on conflict (tenant_id, key) do update set
      label_singular = excluded.label_singular,
      label_plural   = excluded.label_plural,
      icon           = excluded.icon,
      title_field    = excluded.title_field,
      sort_order     = excluded.sort_order
    returning id into v_object_id;

    for v_field in select * from jsonb_array_elements(v_obj -> 'fields') loop
      insert into field_definitions
        (object_id, tenant_id, key, label, field_type, is_required, is_unique,
         options, help_text, visibility, sort_order)
      values (v_object_id, v_tenant, v_field ->> 'key', v_field ->> 'label',
              v_field ->> 'field_type',
              coalesce((v_field ->> 'is_required')::boolean, false),
              coalesce((v_field ->> 'is_unique')::boolean, false),
              coalesce(v_field -> 'options', '{}'::jsonb),
              v_field ->> 'help_text',
              coalesce(v_field ->> 'visibility', 'all'),
              coalesce((v_field ->> 'sort_order')::int, 0))
      on conflict (object_id, key) do update set
        label       = excluded.label,
        field_type  = excluded.field_type,
        is_required = excluded.is_required,
        is_unique   = excluded.is_unique,
        options     = excluded.options,
        help_text   = excluded.help_text,
        visibility  = excluded.visibility,
        sort_order  = excluded.sort_order;
    end loop;

    for v_status in select * from jsonb_array_elements(coalesce(v_obj -> 'statuses', '[]'::jsonb)) loop
      insert into status_definitions
        (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
      values (v_object_id, v_tenant, v_status ->> 'key', v_status ->> 'label',
              v_status ->> 'color',
              coalesce((v_status ->> 'is_initial')::boolean, false),
              coalesce((v_status ->> 'is_terminal')::boolean, false),
              coalesce((v_status ->> 'sort_order')::int, 0))
      on conflict (object_id, key) do update set
        label       = excluded.label,
        color       = excluded.color,
        is_initial  = excluded.is_initial,
        is_terminal = excluded.is_terminal,
        sort_order  = excluded.sort_order;
    end loop;
  end loop;

  -- --- Relationer -----------------------------------------------------------

  for v_rel in select * from jsonb_array_elements(p_template -> 'relationships') loop
    insert into relationship_definitions
      (tenant_id, rel_type, from_object, to_object, cardinality,
       label_forward, label_reverse, is_required)
    values (v_tenant, v_rel ->> 'rel_type', v_rel ->> 'from_object',
            v_rel ->> 'to_object', coalesce(v_rel ->> 'cardinality', 'many_to_one'),
            v_rel ->> 'label_forward', v_rel ->> 'label_reverse',
            coalesce((v_rel ->> 'is_required')::boolean, false))
    on conflict (tenant_id, rel_type) do update set
      from_object   = excluded.from_object,
      to_object     = excluded.to_object,
      cardinality   = excluded.cardinality,
      label_forward = excluded.label_forward,
      label_reverse = excluded.label_reverse,
      is_required   = excluded.is_required;
  end loop;

  -- --- AI-agenter -----------------------------------------------------------

  for v_agent in select * from jsonb_array_elements(coalesce(p_template -> 'ai_agents', '[]'::jsonb)) loop
    insert into ai_agents
      (tenant_id, department_id, key, name, system_prompt,
       allowed_object_types, allowed_tools, requires_approval, model)
    values (
      v_tenant,
      nullif(v_dept_ids ->> (v_agent ->> 'department'), '')::uuid,
      v_agent ->> 'key', v_agent ->> 'name', v_agent ->> 'system_prompt',
      coalesce((select array_agg(x) from jsonb_array_elements_text(
        v_agent -> 'allowed_object_types') x), '{}'),
      coalesce((select array_agg(x) from jsonb_array_elements_text(
        v_agent -> 'allowed_tools') x), '{}'),
      coalesce((v_agent ->> 'requires_approval')::boolean, true),
      coalesce(v_agent ->> 'model', 'claude-sonnet-4-6'))
    on conflict (tenant_id, key) do update set
      department_id        = excluded.department_id,
      name                 = excluded.name,
      system_prompt        = excluded.system_prompt,
      allowed_object_types = excluded.allowed_object_types,
      allowed_tools        = excluded.allowed_tools,
      requires_approval    = excluded.requires_approval,
      model                = excluded.model;
  end loop;

  return v_tenant;
end
$$;

-- Bara service-nyckeln får ladda mallar. En inloggad användare ska aldrig
-- kunna skriva om sin egen tenants konfiguration den här vägen.
revoke execute on function public.load_tenant_template(jsonb)
  from public, anon, authenticated;
