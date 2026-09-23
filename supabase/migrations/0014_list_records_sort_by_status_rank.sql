-- Sortering på statuskolumnen ("status") i list_records_filtered ska följa
-- statusdefinitionens rangordning (sort_order, t.ex. 0/10/20 ... 99 för
-- leveranser: "0. Signerat avtal" ... "99. Avslutad"), inte alfabetisk
-- sortering på statusnyckeln (r.status, t.ex. "avslutad", "bestallt_ga1",
-- "vilande" ...) som annars hamnar i fel inbördes ordning.
--
-- Bakgrund: Gustav vill att Leveranser som standard visas i stigande
-- statusordning (0/1 ... 99). Med den gamla sorteringen (ORDER BY r.status)
-- sorterades leveranserna alfabetiskt på statusnyckeln i stället för på
-- statusens faktiska position i flödet.

CREATE OR REPLACE FUNCTION public.list_records_filtered(p_object_type text, p_search text DEFAULT NULL::text, p_filters jsonb DEFAULT '[]'::jsonb, p_sort_field text DEFAULT 'updated_at'::text, p_sort_dir text DEFAULT 'desc'::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid;
  v_typer    jsonb;
  v_f        jsonb;
  v_falt     text;
  v_op       text;
  v_typ      text;
  v_uttryck  text;
  v_villkor  text[] := '{}';
  v_where    text;
  v_sort     text;
  v_sql      text;
  v_items    jsonb;
  v_total    bigint;
  v_v        jsonb;
begin
  v_tenant := my_tenant_id();

  if not can_do(p_object_type, 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;

  select jsonb_object_agg(fd.key, fd.field_type) into v_typer
    from field_definitions fd join object_definitions od on od.id = fd.object_id
   where od.key = p_object_type and od.tenant_id = v_tenant;
  v_typer := coalesce(v_typer, '{}'::jsonb)
             || '{"__status":"text","__title":"text","__updated_at":"date","__created_at":"date"}'::jsonb;

  for v_f in select * from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb))
  loop
    v_falt := v_f->>'field';
    v_op   := coalesce(v_f->>'op', 'eq');
    v_v    := v_f->'value';

    -- Bara fält som finns i metadata, plus de fyra systemkolumnerna
    if v_falt is null or not (v_typer ? v_falt) then
      continue;
    end if;
    v_typ := v_typer->>v_falt;

    -- Uttryck att jämföra mot
    if v_falt = '__status' then
      v_uttryck := 'r.status';
    elsif v_falt = '__title' then
      v_uttryck := 'r.title';
    elsif v_falt = '__updated_at' then
      v_uttryck := 'r.updated_at';
    elsif v_falt = '__created_at' then
      v_uttryck := 'r.created_at';
    elsif v_typ = 'number' then
      v_uttryck := format('nullif(btrim(r.data->>%L), '''')::numeric', v_falt);
    elsif v_typ in ('date','datetime') then
      v_uttryck := format('nullif(btrim(r.data->>%L), '''')::date', v_falt);
    elsif v_typ = 'boolean' then
      v_uttryck := format('(r.data->%L)::boolean', v_falt);
    else
      v_uttryck := format('r.data->>%L', v_falt);
    end if;

    -- Operatorer
    if v_op = 'empty' then
      v_villkor := v_villkor || format('(%s is null%s)', v_uttryck,
        case when v_typ in ('text','long_text','select') then format(' or btrim(r.data->>%L) = ''''', v_falt) else '' end);
    elsif v_op = 'not_empty' then
      v_villkor := v_villkor || format('(%s is not null%s)', v_uttryck,
        case when v_typ in ('text','long_text','select') then format(' and btrim(r.data->>%L) <> ''''', v_falt) else '' end);
    elsif v_op = 'contains' then
      v_villkor := v_villkor || format('(%s ilike %L)', v_uttryck, '%' || (v_v #>> '{}') || '%');
    elsif v_op = 'not_contains' then
      v_villkor := v_villkor || format('(coalesce(%s, '''') not ilike %L)', v_uttryck, '%' || (v_v #>> '{}') || '%');
    elsif v_op in ('gt','gte','lt','lte') then
      v_villkor := v_villkor || format('(%s %s %L)', v_uttryck,
        case v_op when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,
        v_v #>> '{}');
    elsif v_op = 'between' then
      if jsonb_typeof(v_v) = 'array' and jsonb_array_length(v_v) = 2 then
        v_villkor := v_villkor || format('(%s between %L and %L)', v_uttryck,
          v_v->>0, v_v->>1);
      end if;
    elsif v_op = 'in' then
      if jsonb_typeof(v_v) = 'array' and jsonb_array_length(v_v) > 0 then
        v_villkor := v_villkor || format('(%s in (%s))', v_uttryck,
          (select string_agg(quote_literal(x), ',') from jsonb_array_elements_text(v_v) as x));
      end if;
    elsif v_op = 'neq' then
      v_villkor := v_villkor || format('(%s is distinct from %L)', v_uttryck, v_v #>> '{}');
    else -- eq
      v_villkor := v_villkor || format('(%s = %L)', v_uttryck, v_v #>> '{}');
    end if;
  end loop;

  v_where := 'r.tenant_id = ' || quote_literal(v_tenant)
          || ' and r.object_type = ' || quote_literal(p_object_type)
          || ' and r.deleted_at is null'
          || ' and can_row(r.object_type, ''read'', r.owner_user_id)';

  if coalesce(btrim(p_search), '') <> '' then
    v_where := v_where || format(' and r.title ilike %L', '%' || btrim(p_search) || '%');
  end if;
  if array_length(v_villkor, 1) is not null then
    v_where := v_where || ' and ' || array_to_string(v_villkor, ' and ');
  end if;

  -- Sortering
  -- OBS: "status" sorteras på statusdefinitionens rangordning (sort_order,
  -- t.ex. 0/10/20 .../99 för leveranser), inte alfabetiskt på statusnyckeln
  -- (r.status) — annars hamnar t.ex. "avslutad" och "bestallt_ga1" fel
  -- inbördes jämfört med den ordning statusarna faktiskt representerar.
  if p_sort_field = 'status' then
    v_sort := format(
      '(select sd.sort_order from status_definitions sd
          join object_definitions od2 on od2.id = sd.object_id
         where od2.tenant_id = %L and od2.key = %L and sd.key = r.status)',
      v_tenant, p_object_type
    );
  elsif p_sort_field in ('updated_at','created_at','title') then
    v_sort := 'r.' || p_sort_field;
  elsif v_typer ? p_sort_field then
    v_sort := case
      when v_typer->>p_sort_field = 'number' then format('nullif(btrim(r.data->>%L),'''')::numeric', p_sort_field)
      when v_typer->>p_sort_field in ('date','datetime') then format('nullif(btrim(r.data->>%L),'''')::date', p_sort_field)
      else format('r.data->>%L', p_sort_field) end;
  else
    v_sort := 'r.updated_at';
  end if;
  v_sort := v_sort || case when lower(coalesce(p_sort_dir,'desc')) = 'asc' then ' asc nulls last' else ' desc nulls last' end;

  execute format('select count(*) from records r where %s', v_where) into v_total;

  v_sql := format($q$
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
      select r.id, r.object_type, r.data, r.status, r.owner_user_id,
             r.title, r.created_at, r.updated_at
        from records r
       where %s
       order by %s
       limit %s offset %s
    ) x $q$, v_where, v_sort, greatest(coalesce(p_limit,25),1), greatest(coalesce(p_offset,0),0));
  execute v_sql into v_items;

  return jsonb_build_object('items', v_items, 'total', v_total,
                            'limit', p_limit, 'offset', p_offset);
end $function$;
