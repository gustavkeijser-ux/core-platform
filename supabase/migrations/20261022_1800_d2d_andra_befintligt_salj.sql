-- D2D: "Ändra befintligt sälj" (Gustav 22 okt 2026). En säljare som missat att fylla i något på ett
-- befintligt sälj ska kunna komplettera utan att det räknas som ett nytt sälj (ny hyresgäst).
--  * d2d_andra_befintligt_salj(id): kundkortet markerar lägenheten (data.behall_saljdatum) och
--    loggar det. Markeringen gäller tills säljaren går ut ur lägenheten (underlaget bekräftas).
--  * d2d_sald_datum_tjanster: flyttar inte säljet (datum/säljare) när lägenheten var markerad.
--  * d2d_underlag_trg: markeringen tas bort när underlaget bekräftas (eller vid annan direkt ändring).
create or replace function public.d2d_andra_befintligt_salj(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v records%rowtype;
begin
  select * into v from records where id = p_id and tenant_id = my_tenant_id() and object_type = 'd2d_lagenhet' and deleted_at is null;
  if not found then return; end if;
  if not can_row(v.object_type, 'update', v.owner_user_id) then
    raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
  end if;
  if coalesce(v.data->>'behall_saljdatum', '') = 'true' then return; end if;
  perform set_config('d2d.utkast', '1', true);   -- ett utkast: underlaget och säljet rörs inte
  update records set data = data || '{"behall_saljdatum": true}'::jsonb where id = p_id;
  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
  values (v.tenant_id, v.id, 'field_change', 'Ändrar befintligt sälj — säljdatum och säljare behålls',
          jsonb_build_object('field', 'behall_saljdatum', 'sald_datum', v.data->>'sald_datum', 'saljare', v.data->>'saljare'),
          auth.uid(), 'user');
end $$;
revoke all on function public.d2d_andra_befintligt_salj(uuid) from public, anon;
grant execute on function public.d2d_andra_befintligt_salj(uuid) to authenticated;

do $$ declare d text; n text; begin
  d := pg_get_functiondef('public.d2d_sald_datum_tjanster'::regproc);
  if position('behall_saljdatum' in d) = 0 then
    n := replace(d, '  if v_uid is null then return new; end if;',
      E'  if v_uid is null then return new; end if;\n  -- "Ändra befintligt sälj": säljaren kompletterar ett befintligt sälj — inget flyttas.\n  if coalesce(old.data->>''behall_saljdatum'', '''') = ''true'' then return new; end if;');
    if n = d then raise exception 'saknas tjanster'; end if;
    execute n;
  end if;
end $$;

-- Underlagstriggern (från 20261022_1400) med borttagning av markeringen vid bekräftelse.
create or replace function public.d2d_underlag_trg() returns trigger
language plpgsql set search_path = public as $$
declare v_tj jsonb; v_snap jsonb;
begin
  if new.object_type <> 'd2d_lagenhet' then return new; end if;
  v_tj := d2d_underlag_tjanster(new.data);
  if tg_op = 'UPDATE' and coalesce(current_setting('d2d.utkast', true), '') = '1' then
    v_snap := case when jsonb_typeof(old.data->'avtal_underlag') = 'object' then old.data->'avtal_underlag'
                   else jsonb_build_object('status', old.status, 'tjanster', d2d_underlag_tjanster(old.data), 'satt', now()) end;
    if (v_snap->>'status') is not distinct from new.status and (v_snap->'tjanster') = v_tj then
      v_snap := v_snap - 'utkast';
    else
      v_snap := v_snap || jsonb_build_object('utkast', coalesce(v_snap->'utkast', to_jsonb(now())));
    end if;
    new.data := new.data || jsonb_build_object('avtal_underlag', v_snap);
    return new;
  end if;
  -- Bekräftelse: markeringen "Ändra befintligt sälj" gäller inte längre.
  new.data := new.data - 'behall_saljdatum';
  if tg_op = 'UPDATE' and jsonb_typeof(old.data->'avtal_underlag') = 'object'
     and not (old.data->'avtal_underlag' ? 'utkast')
     and (old.data->'avtal_underlag'->>'status') is not distinct from new.status
     and (old.data->'avtal_underlag'->'tjanster') = v_tj then
    new.data := new.data || jsonb_build_object('avtal_underlag', old.data->'avtal_underlag');
  else
    new.data := new.data || jsonb_build_object('avtal_underlag',
                  jsonb_build_object('status', new.status, 'tjanster', v_tj, 'satt', now()));
  end if;
  return new;
end $$;

-- Bekräfta även när bara markeringen finns (så att den inte blir kvar till nästa sälj).
create or replace function public.d2d_bekrafta_lagenhet(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v records%rowtype;
begin
  select * into v from records where id = p_id and tenant_id = my_tenant_id() and object_type = 'd2d_lagenhet' and deleted_at is null;
  if not found then return; end if;
  if not can_row(v.object_type, 'update', v.owner_user_id) then
    raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
  end if;
  if jsonb_typeof(v.data->'avtal_underlag') = 'object' and not (v.data->'avtal_underlag' ? 'utkast')
     and coalesce(v.data->>'behall_saljdatum', '') <> 'true' then return; end if;
  perform set_config('d2d.utkast', '0', true);
  update records set data = data where id = p_id;
end $$;
