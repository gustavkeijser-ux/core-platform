-- D2D: manuell tilldelning per adress.
-- En säljare på en fastighet → 100 % (som förut, via d2d_set_fastighet_assignment).
-- Flera säljare → admin väljer per adressrad vem som får den. Valet sparas på
-- fastigheten (data.manuell_tilldelning = { lägenhets-id: säljar-id }) och
-- delas ut när projektet godkänns — eller direkt om projektet redan är godkänt.

create or replace function public.d2d_set_fastighet_manuell_tilldelning(p_fastighet_id uuid, p_tilldelning jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := my_tenant_id();
  v_owner uuid;
  v_total int;
  v_assigned int;
  v_saljare jsonb;
  v_projekt_godkant boolean;
  v_applied int := 0;
begin
  select owner_user_id into v_owner from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then raise exception 'Fastigheten finns inte' using errcode = 'P0002'; end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att tilldela säljare' using errcode = '42501';
  end if;
  if p_tilldelning is null or jsonb_typeof(p_tilldelning) <> 'object' then
    raise exception 'Ogiltig tilldelning' using errcode = '22023';
  end if;

  -- Bara lägenheter i just den här fastigheten, och bara aktiva användare.
  if exists (select 1 from jsonb_each_text(p_tilldelning) t
              where not exists (select 1 from relationships rl join records l on l.id = rl.from_record_id
                                 where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = p_fastighet_id
                                   and l.id::text = t.key and l.deleted_at is null)) then
    raise exception 'Tilldelningen innehåller adresser som inte hör till fastigheten' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each_text(p_tilldelning) t
              where not exists (select 1 from users u where u.id::text = t.value and u.tenant_id = v_tenant and u.is_active)) then
    raise exception 'Okänd säljare i tilldelningen' using errcode = '22023';
  end if;

  select count(*) into v_total from relationships rl join records l on l.id = rl.from_record_id
   where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = p_fastighet_id and l.deleted_at is null;
  select count(*) into v_assigned from jsonb_each_text(p_tilldelning);

  -- Procentandelar (för översikten) utifrån antal adresser per säljare.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', value,
           'procent', round(n * 100.0 / greatest(v_total, 1)), 'antal', n) order by n desc), '[]'::jsonb)
    into v_saljare
    from (select value, count(*) n from jsonb_each_text(p_tilldelning) group by value) s;

  update records
     set data = data || jsonb_build_object('saljartilldelning', v_saljare, 'manuell_tilldelning', p_tilldelning)
   where id = p_fastighet_id;

  -- Redan godkänt projekt → dela ut direkt.
  select exists (select 1 from relationships e join records p on p.id = e.to_record_id
                  where e.from_record_id = p_fastighet_id and e.rel_type = 'd2d_fast_projekt'
                    and p.status = 'godkant' and p.deleted_at is null)
    into v_projekt_godkant;
  if v_projekt_godkant then
    update records l
       set owner_user_id = t.value::uuid, data = l.data || jsonb_build_object('saljare', t.value)
      from jsonb_each_text(p_tilldelning) t
     where l.id::text = t.key and l.owner_user_id is distinct from t.value::uuid;
    get diagnostics v_applied = row_count;
  end if;

  return jsonb_build_object('ok', true, 'total', v_total, 'tilldelade', v_assigned,
                            'utdelade', v_applied, 'projektGodkant', v_projekt_godkant);
end $$;

grant execute on function public.d2d_set_fastighet_manuell_tilldelning(uuid, jsonb) to authenticated;

-- En säljare (procent) ersätter en tidigare manuell tilldelning.
create or replace function public.d2d_set_fastighet_assignment(p_fastighet_id uuid, p_assignments jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_owner uuid;
  v_sum numeric;
begin
  v_tenant := my_tenant_id();

  select owner_user_id into v_owner from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then
    raise exception 'Fastigheten finns inte' using errcode = 'P0002';
  end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att tilldela säljare' using errcode = '42501';
  end if;

  if p_assignments is null or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Minst en säljare måste anges' using errcode = '22023';
  end if;

  select coalesce(sum((x->>'procent')::numeric), 0) into v_sum
  from jsonb_array_elements(p_assignments) x;

  if abs(v_sum - 100) > 0.5 then
    raise exception 'Procentsatserna måste summera till 100 (fick %)', v_sum using errcode = '22023';
  end if;

  update records
     set data = (data - 'manuell_tilldelning') || jsonb_build_object('saljartilldelning', p_assignments)
   where id = p_fastighet_id and tenant_id = v_tenant;

  return jsonb_build_object('ok', true);
end
$$;

-- Godkänn: manuell tilldelning per adress går före procentfördelningen.
create or replace function public.d2d_approve_project(p_projekt_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_owner uuid;
  v_fastighet record;
  v_lag_ids uuid[];
  v_total int;
  v_a jsonb;
  v_cursor int;
  v_take int;
  v_seller uuid;
  v_n int;
  v_distributed int := 0;
  v_fastigheter_utan_tilldelning int := 0;
begin
  v_tenant := my_tenant_id();

  select owner_user_id into v_owner from records
   where id = p_projekt_id and tenant_id = v_tenant and object_type = 'd2d_projekt' and deleted_at is null;
  if not found then
    raise exception 'Projektet finns inte' using errcode = 'P0002';
  end if;
  if not can_row('d2d_projekt', 'update', v_owner) then
    raise exception 'Saknar behörighet att godkänna projektet' using errcode = '42501';
  end if;

  for v_fastighet in
    select r.id, r.data->'saljartilldelning' as tilldelning, r.data->'manuell_tilldelning' as manuell
    from records r
    join relationships rel
      on rel.from_record_id = r.id and rel.rel_type = 'd2d_fast_projekt' and rel.to_record_id = p_projekt_id
    where r.tenant_id = v_tenant and r.object_type = 'd2d_fastighet' and r.deleted_at is null
  loop
    -- Manuellt vald säljare per adress
    if jsonb_typeof(v_fastighet.manuell) = 'object' and v_fastighet.manuell <> '{}'::jsonb then
      update records l
         set owner_user_id = t.value::uuid, data = l.data || jsonb_build_object('saljare', t.value)
        from jsonb_each_text(v_fastighet.manuell) t
        join relationships rl on rl.from_record_id::text = t.key and rl.rel_type = 'd2d_lag_fastighet'
                             and rl.to_record_id = v_fastighet.id
       where l.id::text = t.key and l.deleted_at is null;
      get diagnostics v_n = row_count;
      v_distributed := v_distributed + v_n;
      continue;
    end if;

    if v_fastighet.tilldelning is null or jsonb_array_length(v_fastighet.tilldelning) = 0 then
      v_fastigheter_utan_tilldelning := v_fastigheter_utan_tilldelning + 1;
      continue;
    end if;

    select array_agg(l.id order by (l.data->>'gatunamn'), l.title) into v_lag_ids
    from records l
    join relationships rl
      on rl.from_record_id = l.id and rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = v_fastighet.id
    where l.tenant_id = v_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null;

    v_total := coalesce(array_length(v_lag_ids, 1), 0);
    if v_total = 0 then
      continue;
    end if;

    v_cursor := 1;
    for v_a in select * from jsonb_array_elements(v_fastighet.tilldelning)
    loop
      v_seller := (v_a->>'user_id')::uuid;
      v_take := round(v_total * (v_a->>'procent')::numeric / 100.0);
      if v_cursor + v_take - 1 > v_total then
        v_take := v_total - v_cursor + 1;
      end if;
      if v_take > 0 then
        update records
           set owner_user_id = v_seller,
               data = data || jsonb_build_object('saljare', v_seller::text)
         where id = any(v_lag_ids[v_cursor : v_cursor + v_take - 1]);
        v_distributed := v_distributed + v_take;
      end if;
      v_cursor := v_cursor + v_take;
    end loop;
  end loop;

  update records set status = 'godkant' where id = p_projekt_id and tenant_id = v_tenant;

  perform emit_event('d2d.project_approved', p_projekt_id,
    jsonb_build_object('distributed', v_distributed, 'fastigheterUtanTilldelning', v_fastigheter_utan_tilldelning));

  return jsonb_build_object('ok', true, 'distributed', v_distributed,
                            'fastigheterUtanTilldelning', v_fastigheter_utan_tilldelning);
end
$$;
