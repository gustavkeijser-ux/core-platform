-- Byte av säljare på en såld/signerad adress (Gustav 28 okt): den nya säljaren ska
-- få adressen (se den, följa upp), men säljet står kvar på den som sålde/signerade.
-- 23 okt bytte en fördelning säljare på 18 sålda/signerade adresser från Sebastian till
-- Olle, så säljen (pinnar, lön, "Signerad av") flyttade med.
--
-- Nu: byts säljaren på en adress med status Såld, Signera med Scrive eller Ånger
-- (fördelning, projektgodkännande, säljarfältet i CRM) ändras bara tilldelningen
-- (owner_user_id). data.saljare — den som sålde — ligger kvar. Vill admin rätta vem som
-- faktiskt sålde används d2d_byt_saljare_pa_salj(id, säljare).

-- 1. Låset i d2d_lag_las_saljare
do $do$
declare d text := pg_get_functiondef('public.d2d_lag_las_saljare()'::regprocedure);
  a text := $a$  -- Låset: en såld/signerad adress behåller sin säljare. Bara admin får byta.
  if v_sald_forr and v_sald_ny and v_old_s is not null and v_new_s is distinct from v_old_s and not v_admin then
    raise exception 'Adressen är såld och låst till säljaren som sålde den. Kontakta admin.'
      using errcode = '42501';
  end if;$a$;
  b text := $b$  -- Låset: en såld/signerad adress behåller sin säljare (den som sålde/signerade).
  -- Admin (fördelning m.m.) som byter säljare tilldelar adressen den nya säljaren i
  -- stället: owner_user_id byts, säljet ligger kvar (Gustav 28 okt). Rätta vem som
  -- sålde: d2d_byt_saljare_pa_salj.
  if (old.status in ('sald', 'scrive', 'anger')) and (new.status in ('sald', 'scrive', 'anger'))
     and v_old_s is not null and v_new_s is distinct from v_old_s
     and coalesce(current_setting('d2d.byt_saljare_pa_salj', true), '') <> '1' then
    if not v_admin then
      raise exception 'Adressen är såld och låst till säljaren som sålde den. Kontakta admin.'
        using errcode = '42501';
    end if;
    new.data := new.data || jsonb_build_object('saljare', v_old_s);
    if v_new_s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and new.owner_user_id is distinct from v_new_s::uuid then
      new.owner_user_id := v_new_s::uuid;
      insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
      values (new.tenant_id, new.id, 'field_change',
              'Tilldelad ' || coalesce((select coalesce(nullif(full_name, ''), email::text) from users where id = v_new_s::uuid), 'ny säljare')
                || ' — säljet står kvar på ' || coalesce((select coalesce(nullif(full_name, ''), email::text) from users where id::text = v_old_s), 'säljaren'),
              jsonb_build_object('field', 'owner_user_id', 'from', old.owner_user_id, 'to', v_new_s, 'saljare', v_old_s),
              v_uid, 'user');
    end if;
    v_new_s := v_old_s;
  end if;$b$;
begin
  if position('d2d.byt_saljare_pa_salj' in d) > 0 then raise notice 'redan gjort'; return; end if;
  if position(a in d) = 0 then raise exception 'hittar inte texten'; end if;
  execute replace(d, a, b);
end $do$;

-- 2. Rätta vem som sålde (bara admin)
create or replace function public.d2d_byt_saljare_pa_salj(p_id uuid, p_saljare uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Bara admin kan byta säljare på ett sälj' using errcode = '42501'; end if;
  if not exists (select 1 from users where id = p_saljare and tenant_id = my_tenant_id()) then
    raise exception 'Okänd säljare' using errcode = '22023';
  end if;
  perform set_config('d2d.byt_saljare_pa_salj', '1', true);
  update records set data = data || jsonb_build_object('saljare', p_saljare::text)
   where id = p_id and tenant_id = my_tenant_id() and object_type = 'd2d_lagenhet';
  perform set_config('d2d.byt_saljare_pa_salj', '', true);
end $$;
revoke all on function public.d2d_byt_saljare_pa_salj(uuid, uuid) from public, anon;
grant execute on function public.d2d_byt_saljare_pa_salj(uuid, uuid) to authenticated;

-- 3. Återställ fördelningen 23 okt: säljet tillbaka till den som sålde/signerade,
--    adressen ligger kvar hos den den tilldelades.
do $do$
declare r record; v_n int := 0;
begin
  perform set_config('d2d.byt_saljare_pa_salj', '1', true);
  for r in
    with forst as (
      select l.id, l.owner_user_id agare, l.data->>'saljare' s_nu,
             (select min(a.occurred_at) from activities a where a.record_id = l.id and a.activity_type = 'status_change'
                and a.metadata->>'to' in ('sald', 'scrive')) forst_sald
        from records l
       where l.object_type = 'd2d_lagenhet' and l.deleted_at is null and l.status in ('sald', 'scrive', 'anger'))
    select f.id, f.agare, a.metadata->>'from' fran
      from forst f
      join activities a on a.record_id = f.id and a.activity_type = 'field_change' and a.metadata->>'field' = 'saljare'
     where a.occurred_at >= '2026-10-23' and a.occurred_at < '2026-10-24' and f.forst_sald < a.occurred_at
       and a.metadata->>'from' is not null and a.metadata->>'to' = f.s_nu
  loop
    update records set data = data || jsonb_build_object('saljare', r.fran) where id = r.id;
    update records set owner_user_id = r.agare where id = r.id;
    -- Fastighetens manuella fördelning ska fortsatt peka på den adressen tilldelades.
    update records f set data = jsonb_set(f.data, array['manuell_tilldelning', r.id::text], to_jsonb(r.agare::text))
      from relationships rl
     where rl.from_record_id = r.id and rl.rel_type = 'd2d_lag_fastighet' and f.id = rl.to_record_id
       and jsonb_typeof(f.data->'manuell_tilldelning') = 'object' and f.data->'manuell_tilldelning' ? r.id::text;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_kind)
    select tenant_id, id, 'field_change', 'Säljet tillbaka till den som sålde/signerade (fördelningen 23 okt flyttade bara adressen)',
           jsonb_build_object('field', 'saljare', 'to', r.fran, 'agare', r.agare), 'system'
      from records where id = r.id;
    v_n := v_n + 1;
  end loop;
  perform set_config('d2d.byt_saljare_pa_salj', '', true);
  raise notice 'Återställda: %', v_n;
end $do$;
