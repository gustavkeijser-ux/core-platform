-- Ärendehantering v1 – hjälp-RPC:er för ärendevyn.

/** Användare som kan hantera ärenden (admin + roller med case:update). */
create or replace function public.case_assignable_users()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(u.full_name, u.email::text))
                            order by coalesce(u.full_name, u.email::text)), '[]'::jsonb)
    from users u
   where u.tenant_id = my_tenant_id() and u.is_active and u.deleted_at is null
     and can_do('case', 'read')
     and exists (select 1 from user_roles ur join role_permissions rp on rp.role_id = ur.role_id
                  where ur.user_id = u.id and rp.object_type in ('case', '*') and rp.action = 'update')
$$;

/** Sök fastighet eller lägenhet att koppla till ett ärende. Kundtjänst har
 *  medvetet inte generell läsrätt på D2D-lägenheter (då skulle säljarvyn
 *  visa alla lägenheter för den som både säljer och sitter i kundtjänst),
 *  så sökningen går via den här funktionen och visar bara det som behövs. */
create or replace function public.case_search_link_targets(p_type text, p_q text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_q text := nullif(trim(coalesce(p_q, '')), '');
begin
  if not can_do('case', 'update') then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  if p_type not in ('property', 'd2d_lagenhet') then raise exception 'Okänd typ' using errcode = '22023'; end if;
  if v_q is null or length(v_q) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'id', r.id,
      'title', case when p_type = 'd2d_lagenhet'
                    then nullif(trim(concat_ws(' ', r.data->>'gatunamn', r.data->>'gatunummer',
                           case when coalesce(r.title, '') <> '' then 'lgh ' || r.title end)), '')
                    else r.title end,
      'subtitle', case when p_type = 'd2d_lagenhet'
                       then concat_ws(' · ', nullif(r.data->>'postort', ''), nullif(r.data->>'fastighetsbeteckning', ''))
                       else concat_ws(' · ', nullif(r.data->>'street_address', ''), nullif(r.data->>'city', '')) end) x
      from records r
     where r.tenant_id = my_tenant_id() and r.object_type = p_type and r.deleted_at is null
       and (r.title ilike '%' || v_q || '%'
            or (p_type = 'd2d_lagenhet' and (concat_ws(' ', r.data->>'gatunamn', r.data->>'gatunummer') ilike '%' || v_q || '%'
                                             or r.data->>'kund_epost' ilike '%' || v_q || '%'))
            or (p_type = 'property' and (r.data->>'street_address' ilike '%' || v_q || '%'
                                         or r.data->>'fastighetsbeteckning_komplett' ilike '%' || v_q || '%')))
     order by r.title
     limit 15) s), '[]'::jsonb);
end $$;

/** Koppla/koppla loss fastighet eller lägenhet på ett ärende. */
create or replace function public.case_link(p_case uuid, p_rel_type text, p_target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c records; v_def relationship_definitions; v_target records; v_prop uuid;
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id() and object_type = 'case' and deleted_at is null;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  select * into v_def from relationship_definitions where tenant_id = c.tenant_id and rel_type = p_rel_type and from_object = 'case';
  if not found then raise exception 'Okänd koppling' using errcode = '22023'; end if;

  delete from relationships where from_record_id = p_case and rel_type = p_rel_type;
  if p_target is not null then
    select * into v_target from records where id = p_target and tenant_id = c.tenant_id and deleted_at is null
       and object_type = v_def.to_object;
    if not found then raise exception 'Posten finns inte' using errcode = 'P0002'; end if;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    values (c.tenant_id, p_case, p_target, p_rel_type);
    -- Lägenhet vald och ingen fastighet kopplad → ta fastigheten från lägenheten.
    if p_rel_type = 'case_lagenhet' and not exists (
         select 1 from relationships where from_record_id = p_case and rel_type = 'case_property') then
      select fp.to_record_id into v_prop from relationships lf
        join relationships fp on fp.from_record_id = lf.to_record_id and fp.rel_type = 'd2d_fast_property'
       where lf.from_record_id = p_target and lf.rel_type = 'd2d_lag_fastighet' limit 1;
      if v_prop is not null then
        insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
        values (c.tenant_id, p_case, v_prop, 'case_property') on conflict do nothing;
      end if;
    end if;
  end if;
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (c.tenant_id, p_case, 'relation_change',
          v_def.label_forward || case when p_target is null then ' togs bort' else ' kopplades: ' || coalesce(
            case when v_target.object_type = 'd2d_lagenhet'
                 then nullif(trim(concat_ws(' ', v_target.data->>'gatunamn', v_target.data->>'gatunummer',
                        case when coalesce(v_target.title, '') <> '' then 'lgh ' || v_target.title end)), '')
                 else v_target.title end, '') end,
          jsonb_build_object('relType', p_rel_type, 'toRecordId', p_target), auth.uid(), 'user');
  insert into audit_log (tenant_id, actor_kind, actor_id, action, object_type, object_id, after)
  values (c.tenant_id, 'user', auth.uid(), 'case.link', 'case', p_case, jsonb_build_object('relType', p_rel_type, 'target', p_target));
end $$;

/** Sätt/ändra kundens e-post på ett ärende (t.ex. manuellt skapat). */
create or replace function public.case_set_customer_email(p_case uuid, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare c records; v text := lower(nullif(trim(coalesce(p_email, '')), ''));
begin
  select * into c from records where id = p_case and tenant_id = my_tenant_id() and object_type = 'case' and deleted_at is null;
  if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
  if not can_row('case', 'update', c.owner_user_id) then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  if v is not null and v !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Ogiltig e-postadress' using errcode = '22023'; end if;
  update records set data = data || jsonb_build_object('kund_epost', v) where id = p_case;
  perform public.case_autolink(p_case);
end $$;

grant execute on function public.case_assignable_users(), public.case_search_link_targets(text, text),
  public.case_link(uuid, text, uuid), public.case_set_customer_email(uuid, text) to authenticated;
