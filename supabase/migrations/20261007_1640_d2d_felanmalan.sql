-- D2D: felanmälan från säljarvyn (steg 3). Säljare saknar behörighet till Ärenden, så allt går via
-- tre funktioner som bara gör just detta:
--   d2d_felanmalan_skapa      skapar ett ärende (källa Door to door) på adressen, ev. en lägenhet.
--                             Ansvarig = leveransansvarig på adressens leverans, annars reservansvarig
--                             (case_felanmalan_installningar); bevakare = standardbevakarna (Lukas).
--   d2d_felanmalningar        öppna felanmälningar på adressen + säljarens egna avslutade (30 dagar).
--   d2d_felanmalan_kommentar  "samma fel här också": intern kommentar på ett befintligt ärende.
-- Kräver läsrätt till adressen (d2d_fastighet). Inga kunduppgifter lämnas ut.

create or replace function public.d2d_felanmalan_skapa(p_fastighet uuid, p_lagenhet uuid, p_underkategori text, p_kommentar text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_t uuid := my_tenant_id(); f records; l records; v_sub case_categories; v_kat case_categories;
  v_lev uuid; v_ansv uuid; v_proj uuid; v_prop uuid; v_inst case_felanmalan_installningar; v_case records;
  v_adr text; v_lgh text; v_namn text; v_komm text := nullif(trim(coalesce(p_kommentar, '')), ''); v_comm uuid;
begin
  if auth.uid() is null or v_t is null then raise exception 'Inte inloggad' using errcode = '42501'; end if;
  select * into f from records where id = p_fastighet and tenant_id = v_t and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found or not can_row('d2d_fastighet', 'read', f.owner_user_id) then
    raise exception 'Adressen finns inte' using errcode = 'P0002';
  end if;
  if p_lagenhet is not null then
    select x.* into l from records x
      join relationships r on r.from_record_id = x.id and r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = f.id
     where x.id = p_lagenhet and x.deleted_at is null;
    if not found then raise exception 'Lägenheten hör inte till adressen' using errcode = '22023'; end if;
  end if;
  select * into v_sub from case_categories
   where tenant_id = v_t and key = p_underkategori and felanmalan and is_active and parent_key is not null;
  if not found then raise exception 'Välj vad som är fel' using errcode = '22023'; end if;
  select * into v_kat from case_categories where tenant_id = v_t and key = v_sub.parent_key;
  if v_sub.key = 'fel_ovr_annat' and v_komm is null then
    raise exception 'Beskriv felet i kommentaren' using errcode = '22023';
  end if;

  -- Leveransen och dess leveransansvarig (aktiv användare), annars reservansvarig.
  select d.id, nullif(d.data->>'leveransansvarig', '')::uuid into v_lev, v_ansv
    from relationships r join records d on d.id = r.to_record_id and d.deleted_at is null
   where r.from_record_id = f.id and r.rel_type = 'd2d_fast_delivery'
   order by (nullif(d.data->>'leveransansvarig', '') is not null) desc, d.updated_at desc limit 1;
  if v_ansv is not null and not exists (select 1 from users where id = v_ansv and tenant_id = v_t and is_active) then
    v_ansv := null;
  end if;
  select * into v_inst from case_felanmalan_installningar where tenant_id = v_t;
  v_ansv := coalesce(v_ansv, v_inst.reserv_ansvarig);

  select r.to_record_id into v_proj from relationships r join records p on p.id = r.to_record_id and p.deleted_at is null
   where r.from_record_id = f.id and r.rel_type = 'd2d_fast_projekt' order by p.updated_at desc limit 1;
  select r.to_record_id into v_prop from relationships r
   where r.from_record_id = f.id and r.rel_type = 'd2d_fast_property' limit 1;

  v_adr := coalesce(nullif(trim(f.title), ''), 'Okänd adress');
  if l.id is not null then
    v_lgh := nullif(trim(concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer',
               case when coalesce(l.data->>'ingang', '') <> '' then 'ingång ' || (l.data->>'ingang') end,
               case when coalesce(l.title, '') <> '' then 'lgh ' || l.title end)), '');
  end if;
  select coalesce(full_name, email::text) into v_namn from users where id = auth.uid();

  insert into records (tenant_id, object_type, status, owner_user_id, created_by, data)
  values (v_t, 'case', 'new', null, auth.uid(), jsonb_strip_nulls(jsonb_build_object(
    'name', v_sub.label || ' – ' || coalesce(v_lgh, v_adr),
    'channel', 'd2d',
    'priority', coalesce(v_sub.default_priority, v_kat.default_priority, 'normal'),
    'category', v_kat.key, 'subcategory', v_sub.key, 'team', 'delivery',
    'ansvarig', v_ansv, 'anmald_av', auth.uid(),
    'bevakare', to_jsonb(coalesce(v_inst.bevakare, array[]::uuid[])),
    'beskrivning', v_komm,
    'fastighet_namn', v_adr, 'lagenhet_namn', v_lgh)))
  returning * into v_case;

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  select v_t, v_case.id, x.id, x.rel from (values
      (f.id, 'case_d2d_fastighet'), (l.id, 'case_lagenhet'), (v_lev, 'case_delivery'),
      (v_proj, 'case_d2d_projekt'), (v_prop, 'case_property')) as x(id, rel)
   where x.id is not null
  on conflict do nothing;

  insert into communications (tenant_id, channel, direction, provider, external_id, body_text,
                              occurred_at, author_user_id, processing_status)
  values (v_t, 'internal_note', 'internal', 'crm', 'note:' || gen_random_uuid(),
          'Felanmälan från ' || coalesce(v_namn, 'säljare') || ' (Door to door): ' || v_kat.label || ' – ' || v_sub.label
          || E'\n' || 'Plats: ' || coalesce(v_lgh, v_adr) || coalesce(E'\n\n' || v_komm, ''),
          now(), auth.uid(), 'done')
  returning id into v_comm;
  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, confirmed_at, confirmed_by)
  values (v_comm, v_case.id, v_t, 1, 'user', now(), auth.uid());

  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (v_t, v_case.id, 'record_created', 'Felanmälan från säljarvyn',
          jsonb_build_object('fastighet', f.id, 'lagenhet', l.id, 'leverans', v_lev), auth.uid(), 'user');

  return jsonb_build_object('id', v_case.id, 'caseNumber', v_case.data->>'case_number',
                            'ansvarig', (select coalesce(full_name, email::text) from users where id = v_ansv));
end $function$;
revoke all on function public.d2d_felanmalan_skapa(uuid, uuid, text, text) from public, anon;
grant execute on function public.d2d_felanmalan_skapa(uuid, uuid, text, text) to authenticated;

create or replace function public.d2d_felanmalningar(p_fastighet uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_t uuid := my_tenant_id(); f records;
begin
  select * into f from records where id = p_fastighet and tenant_id = v_t and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found or not can_row('d2d_fastighet', 'read', f.owner_user_id) then
    raise exception 'Adressen finns inte' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'caseNumber', c.data->>'case_number',
      'kategori', (select label from case_categories where tenant_id = v_t and key = c.data->>'category'),
      'underkategori', c.data->>'subcategory',
      'underkategoriLabel', (select label from case_categories where tenant_id = v_t and key = c.data->>'subcategory'),
      'lagenhetId', (select to_record_id from relationships where from_record_id = c.id and rel_type = 'case_lagenhet' limit 1),
      'lagenhet', c.data->>'lagenhet_namn',
      'status', c.status,
      'statusLabel', coalesce(case_status_label(v_t, c.status), c.status),
      'oppen', c.status not in ('resolved', 'closed'),
      'telia', c.data->>'telia_arendenr',
      'createdAt', c.created_at,
      'mine', c.data->>'anmald_av' = auth.uid()::text,
      'anmaldAv', (select coalesce(full_name, email::text) from users where id::text = c.data->>'anmald_av'),
      'antalKommentarer', (select count(*) from communication_links cl join communications cm on cm.id = cl.communication_id
                            where cl.record_id = c.id and cm.channel = 'internal_note'))
      order by (c.status in ('resolved', 'closed')), c.created_at desc)
    from relationships r join records c on c.id = r.from_record_id and c.deleted_at is null and c.object_type = 'case'
   where r.to_record_id = f.id and r.rel_type = 'case_d2d_fastighet'
     and (c.status not in ('resolved', 'closed')
          or (c.data->>'anmald_av' = auth.uid()::text and c.updated_at > now() - interval '30 days'))), '[]'::jsonb);
end $function$;
revoke all on function public.d2d_felanmalningar(uuid) from public, anon;
grant execute on function public.d2d_felanmalningar(uuid) to authenticated;

create or replace function public.d2d_felanmalan_kommentar(p_case uuid, p_text text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_t uuid := my_tenant_id(); c records; v_namn text; v_comm uuid; v_text text := nullif(trim(coalesce(p_text, '')), '');
begin
  if v_text is null then raise exception 'Skriv en kommentar' using errcode = '22023'; end if;
  select x.* into c from records x
   where x.id = p_case and x.tenant_id = v_t and x.object_type = 'case' and x.deleted_at is null and x.data->>'channel' = 'd2d'
     and exists (select 1 from relationships r join records f on f.id = r.to_record_id and f.deleted_at is null
                  where r.from_record_id = x.id and r.rel_type = 'case_d2d_fastighet'
                    and can_row('d2d_fastighet', 'read', f.owner_user_id));
  if not found then raise exception 'Felanmälan finns inte' using errcode = 'P0002'; end if;
  select coalesce(full_name, email::text) into v_namn from users where id = auth.uid();
  insert into communications (tenant_id, channel, direction, provider, external_id, body_text,
                              occurred_at, author_user_id, processing_status)
  values (v_t, 'internal_note', 'internal', 'crm', 'note:' || gen_random_uuid(),
          coalesce(v_namn, 'Säljare') || ' (Door to door): ' || v_text, now(), auth.uid(), 'done')
  returning id into v_comm;
  insert into communication_links (communication_id, record_id, tenant_id, confidence, linked_by, confirmed_at, confirmed_by)
  values (v_comm, c.id, v_t, 1, 'user', now(), auth.uid());
  update records set data = data || jsonb_build_object('last_activity_at', public.ce_iso(now())) where id = c.id;
end $function$;
revoke all on function public.d2d_felanmalan_kommentar(uuid, text) from public, anon;
grant execute on function public.d2d_felanmalan_kommentar(uuid, text) to authenticated;
