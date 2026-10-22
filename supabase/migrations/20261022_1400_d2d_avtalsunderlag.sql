-- =============================================================================
-- D2D: Utfall, pinnar, statistik och lön räknas på avtalsförslaget — och först
-- när säljaren lämnar lägenheten (Gustav 22 okt 2026).
--
--  * Underlaget = det avtalsförslaget visar: tjänsterna under "Vad såldes?",
--    utan kategorier där säljaren svarat Nej (även om val ligger kvar i
--    fälten). d2d_underlag_tjanster(data).
--  * Lägenheterna får data.avtal_underlag = { status, tjanster, satt, utkast }
--    — den bekräftade statusen och tjänsterna som all räkning läser
--    (d2d_ust = status, d2d_u = data med underlagets tjänster).
--  * Säljarens kundkort sparar som utkast (d2d_spara_utkast): underlaget står
--    kvar och "utkast" markerar att något ändrats. När säljaren går ut ur
--    lägenheten bekräftas utkastet (d2d_bekrafta_lagenhet) och först då ändras
--    Utfall, pinnar, topplista och lön. Allt annat (import, Scrive, VT,
--    statusknappar i listor, admin-RPC:er) bekräftas direkt.
--  * Ett utkast som lämnats öppet i mer än 2 timmar (appen stängd utan att gå
--    ut ur lägenheten) räknas som bekräftat.
--  * "Säljet flyttas när säljaren ändrar tjänster" (22 okt) sker nu vid
--    bekräftelsen, när underlagets tjänster på en redan såld adress ändras.
-- Inga fält i lägenheterna ändras utom att avtal_underlag läggs till.
-- =============================================================================

-- Tjänsterna enligt avtalsförslaget (samma regel som beraknaAvtal i appen).
-- Hjälpfunktionerna saknar avsiktligt SET search_path: då kan de bakas in i
-- frågorna (inlining) — med SET blev lönen ~25 ggr långsammare.
create or replace function public.d2d_underlag_tjanster(d jsonb) returns jsonb
language sql immutable as $$
  with k as (
    select e.key, e.value
      from jsonb_each(d2d_tjanster_del(d)) e
     where not (e.key like 'salt\_%' and e.key <> 'salt_svar'
                and jsonb_typeof(e.value) <> 'boolean'
                and d->'salt_svar'->>e.key = 'false')
  ),
  mob as (select exists (select 1 from k where k.key = 'salt_mobil' and jsonb_array_length(d2d_arr(k.value)) > 0) har)
  select coalesce((select jsonb_object_agg(k.key, k.value) from k, mob
                    where mob.har or k.key not in ('mobil_antal', 'mobil_extra_antal')), '{}'::jsonb)
      || case when (select har from mob) then jsonb_build_object('mobil_nummer', jsonb_build_object('rows',
              coalesce((select jsonb_agg(jsonb_build_object('typ', r->>'typ'))
                          from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array'
                                                         then d->'mobil_nummer'->'rows' else '[]'::jsonb end) r), '[]'::jsonb)))
              else '{}'::jsonb end
$$;

-- Gäller underlaget? (finns, och inget utkast äldre än 2 timmar)
create or replace function public.d2d_underlag_giltigt(d jsonb) returns boolean
language sql stable as $$
  select jsonb_typeof(d->'avtal_underlag') = 'object'
     and coalesce(nullif(d->'avtal_underlag'->>'utkast', '')::timestamptz > now() - interval '2 hours', true)
$$;

-- Data att räkna på: lägenhetens data med tjänsterna från underlaget.
create or replace function public.d2d_u(d jsonb) returns jsonb
language sql stable as $$
  select (d - coalesce((select array_agg(k) from jsonb_object_keys(d) k
                         where k like 'salt\_%' or k in ('mobil_antal', 'mobil_extra_antal', 'mobil_nummer')), '{}'::text[]))
      || case when d2d_underlag_giltigt(d) then coalesce(d->'avtal_underlag'->'tjanster', '{}'::jsonb)
              else d2d_underlag_tjanster(d) end
$$;

-- Bara tjänsterna (billigare när resten av data inte behövs).
create or replace function public.d2d_ut(d jsonb) returns jsonb
language sql stable as $$
  select case when d2d_underlag_giltigt(d) then coalesce(d->'avtal_underlag'->'tjanster', '{}'::jsonb)
              else d2d_underlag_tjanster(d) end
$$;

-- Status att räkna på.
create or replace function public.d2d_ust(p_status text, d jsonb) returns text
language sql stable as $$
  select case when d2d_underlag_giltigt(d) then d->'avtal_underlag'->>'status' else p_status end
$$;

-- Trigger: underlaget följer posten, utom när kundkortet sparar ett utkast.
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
  elsif tg_op = 'UPDATE' and jsonb_typeof(old.data->'avtal_underlag') = 'object'
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

-- Körs efter de övriga D2D-triggrarna som sätter status/säljare (bokstavsordning)
-- men före trg_d2d_sald_datum_tjanster, som läser underlaget.
create or replace trigger trg_d2d_raknat_underlag before insert or update on public.records
  for each row execute function public.d2d_underlag_trg();

-- Kundkortet: spara som utkast.
create or replace function public.d2d_spara_utkast(p_id uuid, p_data jsonb default null, p_status text default null)
returns records language plpgsql set search_path = public as $$
begin
  perform set_config('d2d.utkast', '1', true);
  return update_record(p_id, p_data, p_status);
end $$;

-- Säljaren går ut ur lägenheten: bekräfta utkastet.
create or replace function public.d2d_bekrafta_lagenhet(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v records%rowtype;
begin
  select * into v from records where id = p_id and tenant_id = my_tenant_id() and object_type = 'd2d_lagenhet' and deleted_at is null;
  if not found then return; end if;
  if not can_row(v.object_type, 'update', v.owner_user_id) then
    raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
  end if;
  if jsonb_typeof(v.data->'avtal_underlag') = 'object' and not (v.data->'avtal_underlag' ? 'utkast') then return; end if;
  perform set_config('d2d.utkast', '0', true);
  update records set data = data where id = p_id;
end $$;

revoke all on function public.d2d_spara_utkast(uuid, jsonb, text) from public, anon;
revoke all on function public.d2d_bekrafta_lagenhet(uuid) from public, anon;
grant execute on function public.d2d_spara_utkast(uuid, jsonb, text) to authenticated;
grant execute on function public.d2d_bekrafta_lagenhet(uuid) to authenticated;

-- Befintliga lägenheter får inget underlag i förväg (inga 19 700 poster skrivs om):
-- utan underlag räknas lägenhetens egna fält enligt avtalsförslaget, och
-- underlaget skapas första gången lägenheten sparas.

-- Räkningen läser underlaget.
do $$
declare
  f text; d text; n text;
  byten jsonb := jsonb_build_array(
    jsonb_build_array('public.d2d_lon_affarer(uuid,timestamptz,timestamptz)',
      E'      from records l\n     where l.tenant_id = p_tenant and l.object_type = ''d2d_lagenhet'' and l.deleted_at is null\n',
      E'      from (select r.id, r.owner_user_id, d2d_ust(r.status, r.data) status, r.data\n              from records r\n             where r.tenant_id = p_tenant and r.object_type = ''d2d_lagenhet'' and r.deleted_at is null\n               and (r.status in (''sald'', ''scrive'', ''anger'') or r.data->''avtal_underlag''->>''status'' in (''sald'', ''scrive'', ''anger''))\n            offset 0) l\n     where true\n'),
    -- Tjänsterna (d2d_u) räknas bara för affärerna i perioden.
    jsonb_build_array('public.d2d_lon_affarer(uuid,timestamptz,timestamptz)',
      'select id, u, t, kalla, data from x',
      'select id, u, t, kalla, d2d_u(data) from x'),
    jsonb_build_array('public.d2d_lon_affarer(uuid,timestamptz,timestamptz)',
      'select id, u, t, kalla, data from sen_anger',
      'select id, u, t, kalla, d2d_u(data) from sen_anger'),
    jsonb_build_array('public.d2d_lon_affarer(uuid,timestamptz,timestamptz)',
      E'select id, u, ta, ''anger'', data from sen_anger',
      E'select id, u, ta, ''anger'', d2d_u(data) from sen_anger'),
    jsonb_build_array('public.d2d_utfall_kalla(text,uuid,uuid,date,date)',
      'select distinct on (l.id) l.id, l.status, l.data d, l.title,',
      E'select distinct on (l.id) l.id, d2d_ust(l.status, l.data) status,\n           case when d2d_ust(l.status, l.data) in (''sald'', ''scrive'', ''anger'') then d2d_u(l.data) else l.data end d, l.title,'),
    jsonb_build_array('public.d2d_utfall_kalla(text,uuid,uuid,date,date)',
      E'and coalesce(l.status, ''ej_knackad'') <> ''ej_knackad''',
      E'and coalesce(d2d_ust(l.status, l.data), ''ej_knackad'') <> ''ej_knackad'''),
    jsonb_build_array('public.d2d_utfall_kalla(text,uuid,uuid,date,date)',
      E'and not (l.status = ''sald'' and',
      E'and not (d2d_ust(l.status, l.data) = ''sald'' and'),
    jsonb_build_array('public.d2d_utfall_kalla(text,uuid,uuid,date,date)',
      E'and not (l.status = ''scrive'' and',
      E'and not (d2d_ust(l.status, l.data) = ''scrive'' and'),
    jsonb_build_array('public.d2d_utfall_rapport(date,date,uuid,uuid)',
      '  l0 as (',
      '  l0 as materialized ('),
    jsonb_build_array('public.d2d_utfall_rapport(date,date,uuid,uuid)',
      'select distinct on (l.id) l.id, l.status, l.data d, l.owner_user_id,',
      'select distinct on (l.id) l.id, d2d_ust(l.status, l.data) status, d2d_u(l.data) d, l.owner_user_id,'),
    jsonb_build_array('public.d2d_utfall_rapport(date,date,uuid,uuid)',
      E'case when l.status in (''sald'', ''anger'') then d2d_sald_tid(l.id, l.data) end sald_tid',
      E'case when d2d_ust(l.status, l.data) in (''sald'', ''anger'') then d2d_sald_tid(l.id, l.data) end sald_tid'),
    jsonb_build_array('public.d2d_utfall_rapport(date,date,uuid,uuid)',
      E'and (l.status in (''sald'', ''anger'') or exists',
      E'and (d2d_ust(l.status, l.data) in (''sald'', ''anger'') or exists'),
    jsonb_build_array('public.d2d_saljstatistik()',
      E'and l.deleted_at is null and l.status = ''sald'' and',
      E'and l.deleted_at is null and d2d_ust(l.status, l.data) = ''sald'' and'),
    jsonb_build_array('public.d2d_saljstatistik()',
      E'and l.deleted_at is null and l.status = ''scrive'' and',
      E'and l.deleted_at is null and d2d_ust(l.status, l.data) = ''scrive'' and'),
    jsonb_build_array('public.d2d_salda_lista(date,date)',
      'jsonb_each(u.ld) e(k, v)',
      'jsonb_each(d2d_ut(u.ld)) e(k, v)'),
    jsonb_build_array('public.d2d_salda_lista(date,date)',
      E'and l.deleted_at is null and l.status = ''sald'' and',
      E'and l.deleted_at is null and d2d_ust(l.status, l.data) = ''sald'' and'),
    jsonb_build_array('public.d2d_anger_statistik(date,date)',
      'select l.id, l.status, l.data, l.title,',
      'select l.id, d2d_ust(l.status, l.data) status, l.data, l.title,'),
    jsonb_build_array('public.d2d_anger_statistik(date,date)',
      E'and l.status in (''sald'', ''scrive'', ''anger'') and',
      E'and d2d_ust(l.status, l.data) in (''sald'', ''scrive'', ''anger'') and'),
    jsonb_build_array('public.d2d_kundtjanst_salj()',
      'round(d2d_pinnar(l.d, (select m from m)), 1)',
      'round(d2d_pinnar(d2d_u(l.d), (select m from m)), 1)'),
    jsonb_build_array('public.d2d_kundtjanst_info()',
      'round(d2d_pinnar(l.data, d2d_lonemodell_for(l.tenant_id)), 1)',
      'round(d2d_pinnar(d2d_u(l.data), d2d_lonemodell_for(l.tenant_id)), 1)'),
    jsonb_build_array('public.d2d_sald_datum_tjanster()',
      E'if new.object_type <> ''d2d_lagenhet'' or new.status <> ''sald'' then return new; end if;',
      E'if new.object_type <> ''d2d_lagenhet'' or coalesce(new.data->''avtal_underlag''->>''status'', '''') <> ''sald''\n     or coalesce(old.data->''avtal_underlag''->>''status'', '''') <> ''sald'' then return new; end if;'),
    jsonb_build_array('public.d2d_sald_datum_tjanster()',
      'if public.d2d_tjanster_del(new.data) = public.d2d_tjanster_del(old.data) then return new; end if;',
      E'-- Bara när underlaget bekräftas (säljaren går ut ur lägenheten) med andra tjänster.\n  if (new.data->''avtal_underlag''->''tjanster'') is not distinct from (old.data->''avtal_underlag''->''tjanster'') then return new; end if;')
  );
  b jsonb;
  defs jsonb := '{}'::jsonb;
begin
  for b in select * from jsonb_array_elements(byten) loop
    f := b->>0;
    d := coalesce(defs->>f, pg_get_functiondef(f::regprocedure));
    n := replace(d, b->>1, b->>2);
    if n = d then raise exception 'Hittar inte texten att byta i %: %', f, left(b->>1, 80); end if;
    defs := defs || jsonb_build_object(f, n);
  end loop;
  for f in select jsonb_object_keys(defs) loop
    execute defs->>f;
  end loop;
end $$;
