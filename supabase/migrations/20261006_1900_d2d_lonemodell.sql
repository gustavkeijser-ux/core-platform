-- Lönemodell för dörrsäljarna (Blitz). Dokumenterar det som redan ligger i
-- databasen (skapat 2026-10-06); hela filen är idempotent (create or replace).
--
-- Varje såld tjänst ger "pinnar" (bredband 1,0, TV Mini 0,1 …). Pinnarna per
-- månad ger bonus enligt en trappa (80 → 5 000 kr … 400 → 53 000 kr) som
-- betalas ut månaden efter. Modellen ligger i egen tabell (d2d_lonemodell),
-- inte i prislistan, så prisredigeringen kan aldrig skriva över den.
--
-- Vem får se löner: tabellen d2d_lon_behorighet (Lukas, Jonas, Gustav).
-- Frontend: D2DLon.tsx (LonemodellEditor, BlitzPinnar, D2DLonerPage).

create table if not exists public.d2d_lonemodell (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.d2d_lonemodell enable row level security;

create table if not exists public.d2d_lon_behorighet (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid not null references public.users(id) on delete cascade,
  primary key (tenant_id, user_id)
);
alter table public.d2d_lon_behorighet enable row level security;
insert into public.d2d_lon_behorighet (tenant_id, user_id)
  select u.tenant_id, u.id from public.users u
   where u.email in ('lukas@connectestate.se', 'jonas@connectestate.se', 'gustav@connectestate.se')
  on conflict do nothing;

/** Standardmodellen (Gustavs tabell). Sparade värden i d2d_lonemodell går före. */
create or replace function public.d2d_lonemodell_standard()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'pinnar', jsonb_build_object(
      'salt_bredband', 1.0,
      'salt_trygghet', 0.1,
      'salt_tv:tv_bas', 0.1,            -- TV Mini (obs nyckeln). TV Start/TV Bas ger 0.
      'salt_tv:tv_mellan', 0.3,
      'salt_tv:tv_mycket', 0.3,
      'salt_streaming_film:streaming_mer', 0.3,
      'salt_streaming_film:streaming_maxad', 0.3,
      'salt_streaming_film:streaming_mest', 0.3,
      'salt_streaming_sport:lilla_sportpaketet', 0.6,
      'salt_streaming_sport:stora_sportpaketet', 0.8,
      'salt_streaming_sport:storsta_sportpaketet', 0.9,
      'salt_mobil:10_gb', 0.7,
      'salt_mobil:20_gb', 0.9,
      'salt_mobil:obegransad', 1.0,
      'salt_mobil:obegransad_plus', 1.0,
      'salt_mobil:obegransad_plus_1_streaming', 1.0,
      'salt_mobil:obegransad_plus_3_streaming', 1.0,
      'salt_mobil:extra_anvandare', 0.5),
    'trappa', '[{"pinnar":80,"bonus":5000},{"pinnar":100,"bonus":8000},{"pinnar":120,"bonus":12500},
                {"pinnar":160,"bonus":18000},{"pinnar":200,"bonus":26000},{"pinnar":240,"bonus":31000},
                {"pinnar":280,"bonus":37000},{"pinnar":320,"bonus":42000},{"pinnar":360,"bonus":48000},
                {"pinnar":400,"bonus":53000}]'::jsonb,
    'krPerPinne', 250,
    'utbetalningManaderEfter', 1,
    'raknaPreliminara', false)
$$;

create or replace function public.d2d_lonemodell_for(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select d2d_lonemodell_standard() || coalesce((select data from d2d_lonemodell where tenant_id = p_tenant), '{}'::jsonb)
$$;

/** Modellen för den inloggades organisation (alla inloggade). */
create or replace function public.get_d2d_lonemodell()
returns jsonb language sql stable security definer set search_path = public as $$
  select d2d_lonemodell_for(my_tenant_id())
         || jsonb_build_object('updatedAt', (select updated_at from d2d_lonemodell where tenant_id = my_tenant_id()))
$$;
grant execute on function public.get_d2d_lonemodell() to authenticated;

/** Spara modellen (bara admin). */
create or replace function public.set_d2d_lonemodell(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Bara administratörer kan ändra lönemodellen' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object'
     or jsonb_typeof(p_data->'pinnar') is distinct from 'object'
     or jsonb_typeof(p_data->'trappa') is distinct from 'array' then
    raise exception 'Ogiltig lönemodell' using errcode = '22023';
  end if;
  insert into d2d_lonemodell (tenant_id, data, updated_at, updated_by)
  values (my_tenant_id(), p_data - 'updatedAt', now(), auth.uid())
  on conflict (tenant_id) do update
    set data = excluded.data, updated_at = now(), updated_by = auth.uid();
  return get_d2d_lonemodell();
end $$;
grant execute on function public.set_d2d_lonemodell(jsonb) to authenticated;

/** Pinnar per tjänst i en lägenhets data (bredband samlat, övriga per variant). */
create or replace function public.d2d_pinnar_rader(d jsonb, m jsonb)
returns jsonb language sql immutable as $$
  with mob as (
    select case jsonb_typeof(d->'salt_mobil') when 'array' then d->'salt_mobil'
                when 'string' then jsonb_build_array(d->'salt_mobil') else '[]'::jsonb end a),
  r(kat, val) as (
    select 'salt_bredband', coalesce(nullif(d->>'salt_bredband', ''), '')
     where nullif(d->>'salt_bredband', '') is not null or d->'salt_svar'->>'salt_bredband' = 'true'
        or not (d ? 'salt_svar' or d ? 'salt_bredband' or d ? 'salt_mobil' or d ? 'salt_tv')
    union all select 'salt_trygghet', '' where d->>'salt_trygghet' = 'true'
    union all select 'salt_tv', d->>'salt_tv' where nullif(d->>'salt_tv', '') is not null
    union all select 'salt_streaming_film', d->>'salt_streaming_film' where nullif(d->>'salt_streaming_film', '') is not null
    union all select 'salt_streaming_sport', d->>'salt_streaming_sport' where nullif(d->>'salt_streaming_sport', '') is not null
    union all select 'salt_mobil', x from mob, jsonb_array_elements_text(mob.a) x where x <> 'extra_anvandare'
    union all select 'salt_mobil', 'extra_anvandare'
      from generate_series(1, (select greatest(
              (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array'
                                                              then d->'mobil_nummer'->'rows' else '[]'::jsonb end) x
                where x->>'typ' = 'extra'),
              case when (select a from mob) ? 'extra_anvandare' then 1 else 0 end))::int)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'nyckel', case when kat = 'salt_bredband' or val = '' then kat else kat || ':' || val end,
           'pinnar', coalesce((m->'pinnar'->>(kat || ':' || val))::numeric, (m->'pinnar'->>kat)::numeric, 0))), '[]'::jsonb)
    from r
$$;

create or replace function public.d2d_pinnar(d jsonb, m jsonb)
returns numeric language sql immutable as $$
  select coalesce(sum((x->>'pinnar')::numeric), 0) from jsonb_array_elements(d2d_pinnar_rader(d, m)) x
$$;

/** Nådd nivå, bonus, nästa nivå och hur många pinnar som är kvar dit. */
create or replace function public.d2d_bonus_niva(p numeric, m jsonb)
returns jsonb language sql immutable as $$
  with t as (select (x->>'pinnar')::numeric pn, (x->>'bonus')::numeric bn
               from jsonb_array_elements(case when jsonb_typeof(m->'trappa') = 'array' then m->'trappa' else '[]'::jsonb end) x),
  nadd  as (select * from t where pn <= p order by pn desc limit 1),
  nasta as (select * from t where pn > p order by pn asc limit 1)
  select jsonb_build_object(
    'niva', (select pn from nadd), 'bonus', coalesce((select bn from nadd), 0),
    'nastaNiva', (select pn from nasta), 'nastaBonus', (select bn from nasta),
    'kvar', (select pn - p from nasta))
$$;

/** Affärer som ger pinnar i ett intervall: sålda adresser (tidpunkt = när status
 *  blev Såld) och signerade Scrive-avtal (tidpunkt = signering). Skickade men
 *  inte signerade avtal kommer med som 'vantar'. Tillfälliga adresser räknas inte. */
create or replace function public.d2d_lon_affarer(p_tenant uuid, p_fran timestamptz, p_till timestamptz)
returns table(lagenhet_id uuid, saljare uuid, t timestamptz, kalla text, d jsonb)
language sql stable security definer set search_path = public as $$
  with l as (
    select l.id, l.status, l.data, l.owner_user_id,
           case when l.data->>'saljare' ~* '^[0-9a-f-]{36}$' then (l.data->>'saljare')::uuid end ds
      from records l
     where l.tenant_id = p_tenant and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
       and l.status in ('sald', 'scrive') and coalesce(l.data->>'tillfallig', '') <> 'true'
  ),
  x as (
    select l.id, coalesce(l.ds, l.owner_user_id) u, l.data,
           case when l.status = 'sald' then 'sald'
                when sig.t is not null then 'signerat'
                else 'vantar' end kalla,
           case when l.status = 'sald' then coalesce(
                  (select a.occurred_at from activities a where a.record_id = l.id and a.activity_type = 'status_change'
                      and a.metadata->>'to' = 'sald' order by a.occurred_at desc limit 1),
                  (l.data->>'senast_kontakt')::timestamptz)
                when sig.t is not null then sig.t
                else coalesce((l.data->>'senast_kontakt')::timestamptz,
                              (select max(da.skapad) from d2d_avtal da where da.lagenhet_id = l.id)) end t
      from l
      left join lateral (select coalesce(da.signerad, da.uppdaterad) t from d2d_avtal da
                          where da.lagenhet_id = l.id and da.status = 'signerat'
                          order by 1 desc limit 1) sig on true
     where l.status = 'sald' or sig.t is not null
        or exists (select 1 from d2d_avtal da where da.lagenhet_id = l.id and da.status in ('skapas', 'vantar'))
  )
  select id, u, t, kalla, data from x
   where u is not null and t >= p_fran and t < p_till
$$;

/** En månads pinnar och bonus per säljare (intern, anropas av funktionerna nedan). */
create or replace function public.d2d_lon_manad(p_tenant uuid, p_manad date, p_detalj boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select d2d_lonemodell_for(p_tenant) m),
  grans as (select (date_trunc('month', p_manad)::timestamp at time zone 'Europe/Stockholm') fran,
                   ((date_trunc('month', p_manad) + interval '1 month')::timestamp at time zone 'Europe/Stockholm') till),
  a as (select af.*, d2d_pinnar(af.d, m.m) p from grans, m, d2d_lon_affarer(p_tenant, grans.fran, grans.till) af),
  saljare as (
    select u.id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) namn
      from users u
     where u.tenant_id = p_tenant and u.deleted_at is null
       and (u.id in (select saljare from a)
            or (u.is_active and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                         where ur.user_id = u.id and r.key = 'dorrsaljare')))
  ),
  per as (
    select s.id, s.namn,
           coalesce(sum(a.p) filter (where a.kalla <> 'vantar'), 0) pinnar,
           coalesce(sum(a.p) filter (where a.kalla = 'vantar'), 0) vantar,
           count(a.lagenhet_id) filter (where a.kalla <> 'vantar') affarer,
           count(a.lagenhet_id) filter (where a.kalla = 'vantar') affarer_vantar
      from saljare s left join a on a.saljare = s.id
     group by 1, 2
  )
  select jsonb_build_object(
    'manad', to_char(p_manad, 'YYYY-MM'),
    'utbetalning', to_char(date_trunc('month', p_manad) + make_interval(months => coalesce((m.m->>'utbetalningManaderEfter')::int, 1)), 'YYYY-MM'),
    'saljare', coalesce((select jsonb_agg(
        jsonb_build_object('id', per.id, 'namn', per.namn, 'pinnar', round(per.pinnar, 1), 'vantar', round(per.vantar, 1),
                           'affarer', per.affarer, 'affarerVantar', per.affarer_vantar)
        || d2d_bonus_niva(per.pinnar, m.m)
        || jsonb_build_object('bonusInklVantar', (d2d_bonus_niva(per.pinnar + per.vantar, m.m)->>'bonus')::numeric)
        || case when p_detalj then jsonb_build_object('produkter', coalesce((
             select jsonb_agg(jsonb_build_object('nyckel', k, 'antal', n, 'pinnar', round(s, 1)) order by s desc)
               from (select r->>'nyckel' k, count(*) n, sum((r->>'pinnar')::numeric) s
                       from a, jsonb_array_elements(d2d_pinnar_rader(a.d, m.m)) r
                      where a.saljare = per.id and a.kalla <> 'vantar' group by 1) z), '[]'::jsonb)) else '{}'::jsonb end
        order by per.pinnar desc, per.namn) from per), '[]'::jsonb)
  ) from m
$$;

/** Har den inloggade lönebehörighet? */
create or replace function public.d2d_lon_behorig()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from d2d_lon_behorighet where tenant_id = my_tenant_id() and user_id = auth.uid())
$$;
grant execute on function public.d2d_lon_behorig() to authenticated;

/** Blitz → Översikt: innevarande månads pinnar per säljare + trappan (alla som får läsa lägenheter). */
create or replace function public.d2d_pinnar_oversikt(p_manad date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_m date := coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date);
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return d2d_lon_manad(my_tenant_id(), v_m, false)
         || jsonb_build_object('trappa', d2d_lonemodell_for(my_tenant_id())->'trappa', 'jag', auth.uid());
end $$;
grant execute on function public.d2d_pinnar_oversikt(date) to authenticated;

/** Löner: innevarande månad och p_antal-1 månader bakåt med produktdetalj (bara lönebehöriga). */
create or replace function public.d2d_lon_prognos(p_manad date default null, p_antal integer default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_m date := date_trunc('month', coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date))::date;
begin
  if not d2d_lon_behorig() then
    raise exception 'Saknar behörighet till löner' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'modell', d2d_lonemodell_for(my_tenant_id()),
    'manader', (select jsonb_agg(d2d_lon_manad(my_tenant_id(), (v_m - make_interval(months => i))::date, true) order by i)
                  from generate_series(0, greatest(1, least(coalesce(p_antal, 3), 12)) - 1) i));
end $$;
grant execute on function public.d2d_lon_prognos(date, integer) to authenticated;
