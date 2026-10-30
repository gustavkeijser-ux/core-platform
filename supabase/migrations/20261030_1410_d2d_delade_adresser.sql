-- =============================================================================
-- D2D: delade adresser — samma adress hos fler än en säljare (Gustav 30 okt).
--
-- I projektbyggaren → Tilldela finns knappen "Dela adresser": en lista med alla
-- adresser på fastigheten där admin bockar i vilka som ska synas hos fler än
-- en säljare, och vilka säljare som delar dem. Adressen har fortfarande en
-- ägare (owner_user_id, den vanliga tilldelningen); de säljare som står i
-- d2d_lagenhet_delning ser och bearbetar den också. Statusbyten görs på samma
-- post, så båda ser dem direkt. Säljer en av dem blir hen säljare/ägare (som
-- vanligt), den andra ser fortfarande adressen via delningen.
--
-- Läsning: d2d_kan_lasa (RLS på records, get_record_with_relations),
-- d2d_tilldelad (fastighet/projekt), d2d_saljar_urval, d2d_alla_lagenheter.
-- Skrivning: dörrsäljare har d2d_lagenhet:update = own, och update_record
-- (Master) kontrollerar can_row mot ägaren. d2d_uppdatera_lagenhet släpper
-- igenom en delad säljare genom att för just den transaktionen höja scopet
-- för d2d_lagenhet:update i behörighetscachen ce.my_scopes (samma cache som
-- my_scopes() läser) — bara efter kontroll att användaren står i delningen
-- och har rätt att ändra egna lägenheter. Säljarvyn sparar via den.
-- =============================================================================

-- 1. Tabell
create table if not exists public.d2d_lagenhet_delning (
  tenant_id   uuid not null references tenants(id),
  lagenhet_id uuid not null references records(id) on delete cascade,
  user_id     uuid not null,
  skapad      timestamptz not null default now(),
  skapad_av   uuid,
  -- Borttagen delning markeras aktiv = false (ingen delete; raden återanvänds).
  aktiv       boolean not null default true,
  primary key (lagenhet_id, user_id)
);
alter table public.d2d_lagenhet_delning add column if not exists aktiv boolean not null default true;
create index if not exists d2d_lagenhet_delning_user_idx on public.d2d_lagenhet_delning (user_id, lagenhet_id);
alter table public.d2d_lagenhet_delning enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'd2d_lagenhet_delning' and policyname = 'd2d_lagenhet_delning_read') then
    create policy d2d_lagenhet_delning_read on public.d2d_lagenhet_delning
      for select using (tenant_id = my_tenant_id());
  end if;
end $$;
grant select on public.d2d_lagenhet_delning to authenticated;

-- 2. Är den inloggade en delad säljare på lägenheten?
create or replace function public.d2d_delad_med(p_lagenhet_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from d2d_lagenhet_delning d where d.lagenhet_id = p_lagenhet_id and d.user_id = auth.uid() and d.aktiv)
$$;
grant execute on function public.d2d_delad_med(uuid) to authenticated;

-- 3. Läsning
create or replace function public.d2d_kan_lasa(p_id uuid, p_type text, p_owner uuid)
returns boolean language sql stable set search_path = public as $$
  select public.can_row(p_type, 'read', p_owner)
      or (public.my_scope(p_type, 'read') = 'tilldelad' and public.d2d_tilldelad(p_id, p_type))
      or (p_type = 'd2d_lagenhet' and public.d2d_delad_med(p_id))
$$;

create or replace function public.d2d_tilldelad(p_id uuid, p_type text)
returns boolean language sql stable security definer set search_path = public as $$
  select case p_type
    when 'd2d_fastighet' then
      exists (select 1 from records f where f.id = p_id and f.owner_user_id = auth.uid())
      or exists (select 1 from relationships rl
                   join records l on l.id = rl.from_record_id and l.deleted_at is null
                  where rl.to_record_id = p_id and rl.rel_type = 'd2d_lag_fastighet'
                    and (l.owner_user_id = auth.uid()
                         or exists (select 1 from d2d_lagenhet_delning d where d.lagenhet_id = l.id and d.user_id = auth.uid() and d.aktiv)))
    when 'd2d_projekt' then
      exists (select 1 from records p where p.id = p_id and p.owner_user_id = auth.uid())
      or exists (select 1 from relationships rp
                   join records f on f.id = rp.from_record_id and f.deleted_at is null
                  where rp.to_record_id = p_id and rp.rel_type = 'd2d_fast_projekt'
                    and (f.owner_user_id = auth.uid()
                         or exists (select 1 from relationships rl
                                      join records l on l.id = rl.from_record_id and l.deleted_at is null
                                     where rl.to_record_id = f.id and rl.rel_type = 'd2d_lag_fastighet'
                                       and (l.owner_user_id = auth.uid()
                                            or exists (select 1 from d2d_lagenhet_delning d where d.lagenhet_id = l.id and d.user_id = auth.uid() and d.aktiv)))))
    else false
  end
$$;

-- d2d_saljar_urval: delade lägenheter räknas till säljarens fastigheter.
do $$
declare v_src text; v_ny text;
begin
  select pg_get_functiondef('public.d2d_saljar_urval()'::regprocedure) into v_src;
  if position('d.user_id = auth.uid() and d.aktiv' in v_src) > 0 then return; end if;
  if position('d2d_lagenhet_delning' in v_src) > 0 then
    -- Första versionen (utan aktiv-kolumnen) kördes i testgrenen.
    v_ny := replace(v_src, 'd.user_id = auth.uid())', 'd.user_id = auth.uid() and d.aktiv)');
  else
    if position('where can_do(''d2d_fastighet'', ''read'') and in_scope(t.lag_scope, l.owner_user_id)' in v_src) = 0 then
      raise exception 'd2d_saljar_urval: oväntad text';
    end if;
    v_ny := replace(v_src,
      'where can_do(''d2d_fastighet'', ''read'') and in_scope(t.lag_scope, l.owner_user_id)',
      'where can_do(''d2d_fastighet'', ''read'') and (in_scope(t.lag_scope, l.owner_user_id) or exists (select 1 from d2d_lagenhet_delning d where d.lagenhet_id = l.id and d.user_id = auth.uid() and d.aktiv))');
  end if;
  execute v_ny;
end $$;

-- d2d_alla_lagenheter: en delad säljare får ändra (kan_andra) och ser kundnamn/telefon.
do $$
declare v_src text; v_ny text;
begin
  select pg_get_functiondef('public.d2d_alla_lagenheter()'::regprocedure) into v_src;
  if position('d.user_id = t.me and d.aktiv' in v_src) > 0 then return; end if;
  if position('d2d_lagenhet_delning' in v_src) > 0 then
    v_ny := replace(v_src, 'd.user_id = t.me)', 'd.user_id = t.me and d.aktiv)');
  else
    if position('(t.admin or t.kt or can_row(''d2d_lagenhet'', ''update'', l.owner_user_id)) as egen' in v_src) = 0 then
      raise exception 'd2d_alla_lagenheter: oväntad text';
    end if;
    v_ny := replace(v_src,
      '(t.admin or t.kt or can_row(''d2d_lagenhet'', ''update'', l.owner_user_id)) as egen',
      '(t.admin or t.kt or can_row(''d2d_lagenhet'', ''update'', l.owner_user_id) or exists (select 1 from d2d_lagenhet_delning d where d.lagenhet_id = l.id and d.user_id = t.me and d.aktiv)) as egen');
  end if;
  execute v_ny;
end $$;

-- 4. Skrivning för delade säljare
create or replace function public.d2d_uppdatera_lagenhet(p_id uuid, p_data jsonb default null, p_status text default null, p_utkast boolean default false)
returns records language plpgsql security definer set search_path = public as $$
declare
  v record;
  v_uid uuid := auth.uid();
begin
  select id, object_type, owner_user_id into v from records
   where id = p_id and tenant_id = my_tenant_id() and deleted_at is null;
  if not found then raise exception 'Ingen post med id %', p_id using errcode = 'P0002'; end if;
  if v.object_type = 'd2d_lagenhet' and not can_row('d2d_lagenhet', 'update', v.owner_user_id) then
    -- Delad säljare: får ändra lägenheter som delats med hen, om hen alls får
    -- ändra lägenheter (scope own). Höj scopet för den här transaktionen så
    -- att update_record släpper igenom; ingen ägare sätts.
    if v_uid is null or not d2d_delad_med(p_id) or coalesce(my_scope('d2d_lagenhet', 'update'), '') = '' then
      raise exception 'Saknar behörighet att ändra posten' using errcode = '42501';
    end if;
    perform set_config('ce.my_scopes',
      v_uid::text || '|' || (my_scopes() || jsonb_build_object('d2d_lagenhet:update', 'tenant'))::text, true);
  end if;
  if p_utkast then perform set_config('d2d.utkast', '1', true); end if;
  return update_record(p_id, p_data, p_status);
end $$;
grant execute on function public.d2d_uppdatera_lagenhet(uuid, jsonb, text, boolean) to authenticated;

create or replace function public.d2d_spara_utkast(p_id uuid, p_data jsonb default null, p_status text default null)
returns records language plpgsql security definer set search_path = public as $$
begin
  return d2d_uppdatera_lagenhet(p_id, p_data, p_status, true);
end $$;

-- 5. Projektbyggaren: läsa och sätta delningen för en fastighet
create or replace function public.d2d_delade_adresser(p_fastighet_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(x.lagenhet_id, x.users), '{}'::jsonb)
    from (select d.lagenhet_id, jsonb_agg(d.user_id order by d.skapad) as users
            from d2d_lagenhet_delning d
            join relationships rl on rl.from_record_id = d.lagenhet_id and rl.rel_type = 'd2d_lag_fastighet'
                                 and rl.to_record_id = p_fastighet_id
            join records l on l.id = d.lagenhet_id and l.deleted_at is null
            join records f on f.id = p_fastighet_id and f.deleted_at is null
           where d.tenant_id = my_tenant_id() and d.aktiv
             and (is_admin() or can_row('d2d_fastighet', 'update', f.owner_user_id))
           group by d.lagenhet_id) x
$$;
grant execute on function public.d2d_delade_adresser(uuid) to authenticated;

/** Ersätter hela delningen för fastigheten: p_delning = { lägenhets-id: [säljar-id, …] }.
 *  Lägenheter som inte finns med (eller har färre än två säljare) blir odelade. */
create or replace function public.d2d_satt_delade_adresser(p_fastighet_id uuid, p_delning jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := my_tenant_id();
  v_owner uuid;
  v_uid uuid := auth.uid();
  v_ny jsonb := '{}'::jsonb;
  v_rad record;
  v_andrade int := 0;
  v_delade int;
  v_namn text;
begin
  select owner_user_id into v_owner from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then raise exception 'Fastigheten finns inte' using errcode = 'P0002'; end if;
  if not can_row('d2d_fastighet', 'update', v_owner) then
    raise exception 'Saknar behörighet att dela adresser' using errcode = '42501';
  end if;
  if p_delning is null or jsonb_typeof(p_delning) <> 'object' then
    raise exception 'Ogiltig delning' using errcode = '22023';
  end if;

  -- Bara lägenheter i fastigheten, bara aktiva användare, minst två per adress.
  select coalesce(jsonb_object_agg(e.key, u.users), '{}'::jsonb) into v_ny
    from jsonb_each(p_delning) e
    join lateral (select jsonb_agg(distinct v) as users, count(distinct v) as n
                    from jsonb_array_elements_text(case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) v) u on true
   where u.n >= 2;
  if exists (select 1 from jsonb_object_keys(v_ny) k
              where not exists (select 1 from relationships rl join records l on l.id = rl.from_record_id
                                 where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = p_fastighet_id
                                   and l.id::text = k and l.deleted_at is null)) then
    raise exception 'Delningen innehåller adresser som inte hör till fastigheten' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(v_ny) e, jsonb_array_elements_text(e.value) v
              where not exists (select 1 from users u where u.id::text = v and u.tenant_id = v_tenant and u.is_active)) then
    raise exception 'Okänd säljare i delningen' using errcode = '22023';
  end if;

  -- Jämför per lägenhet i fastigheten och skriv om där det skiljer.
  for v_rad in
    select l.id,
           coalesce((select jsonb_agg(d.user_id::text order by d.user_id) from d2d_lagenhet_delning d where d.lagenhet_id = l.id and d.aktiv), '[]'::jsonb) as nu,
           coalesce((select jsonb_agg(v order by v) from jsonb_array_elements_text(coalesce(v_ny -> l.id::text, '[]'::jsonb)) v), '[]'::jsonb) as ny
      from relationships rl join records l on l.id = rl.from_record_id
     where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = p_fastighet_id and l.deleted_at is null
  loop
    if v_rad.nu = v_rad.ny then continue; end if;
    update d2d_lagenhet_delning set aktiv = false where lagenhet_id = v_rad.id and aktiv
       and not (user_id::text in (select v from jsonb_array_elements_text(v_rad.ny) v));
    insert into d2d_lagenhet_delning (tenant_id, lagenhet_id, user_id, skapad_av)
    select v_tenant, v_rad.id, v::uuid, v_uid from jsonb_array_elements_text(v_rad.ny) v
    on conflict (lagenhet_id, user_id) do update set aktiv = true, skapad = now(), skapad_av = excluded.skapad_av;
    select string_agg(coalesce(nullif(u.full_name, ''), u.email::text), ' och ' order by u.full_name) into v_namn
      from jsonb_array_elements_text(v_rad.ny) v join users u on u.id::text = v;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (v_tenant, v_rad.id, 'field_change',
            case when v_rad.ny = '[]'::jsonb then 'Delningen togs bort — bara den tilldelade säljaren ser adressen'
                 else 'Delad adress — ses och bearbetas av ' || v_namn end,
            jsonb_build_object('field', 'delning', 'from', v_rad.nu, 'to', v_rad.ny), v_uid, 'user');
    v_andrade := v_andrade + 1;
  end loop;

  select count(*) into v_delade from (select 1 from jsonb_object_keys(v_ny)) k;
  update records set data = data || jsonb_build_object('delade_adresser', v_delade) where id = p_fastighet_id
     and (data->>'delade_adresser') is distinct from v_delade::text;
  return jsonb_build_object('ok', true, 'delade', v_delade, 'andrade', v_andrade);
end $$;
grant execute on function public.d2d_satt_delade_adresser(uuid, jsonb) to authenticated;
