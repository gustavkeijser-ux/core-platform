-- Löner i Blitz: provision per pinne + bonustrappa + manuella justeringar.
--
-- Lön per säljare och månad = pinnar × krPerPinne (250 kr) + trappans bonus
-- när ett steg nåtts + justeringar (tillägg/avdrag med kommentar, läggs in
-- av lönebehöriga på sidan Door to door → Löner). Ingen grundlön.
-- Blitz → Översikt får bara pinnar/nivåer, inga lönebelopp för andra.

create table if not exists public.d2d_lon_justering (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,   -- säljaren
  manad      date not null,                                                 -- första dagen i månaden
  belopp     numeric(12,2) not null,                                        -- + tillägg / − avdrag
  kommentar  text not null,
  skapad_av  uuid references public.users(id) on delete set null,
  skapad_at  timestamptz not null default now()
);
create index if not exists d2d_lon_justering_idx on public.d2d_lon_justering (tenant_id, manad, user_id);
alter table public.d2d_lon_justering enable row level security;

/** Lägg till en justering (bara lönebehöriga). Returnerar raden. */
create or replace function public.d2d_lon_justering_lagg_till(p_user uuid, p_manad date, p_belopp numeric, p_kommentar text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.d2d_lon_justering;
begin
  if not d2d_lon_behorig() then raise exception 'Saknar behörighet till löner' using errcode = '42501'; end if;
  if p_belopp is null or p_belopp = 0 then raise exception 'Ange ett belopp' using errcode = '22023'; end if;
  if coalesce(trim(p_kommentar), '') = '' then raise exception 'Skriv vad justeringen gäller' using errcode = '22023'; end if;
  if not exists (select 1 from users where id = p_user and tenant_id = my_tenant_id()) then
    raise exception 'Okänd säljare' using errcode = 'P0002';
  end if;
  insert into d2d_lon_justering (tenant_id, user_id, manad, belopp, kommentar, skapad_av)
  values (my_tenant_id(), p_user, date_trunc('month', p_manad)::date, p_belopp, left(trim(p_kommentar), 300), auth.uid())
  returning * into v;
  return to_jsonb(v);
end $$;
grant execute on function public.d2d_lon_justering_lagg_till(uuid, date, numeric, text) to authenticated;

/** Ta bort en justering (bara lönebehöriga). */
create or replace function public.d2d_lon_justering_ta_bort(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not d2d_lon_behorig() then raise exception 'Saknar behörighet till löner' using errcode = '42501'; end if;
  delete from d2d_lon_justering where id = p_id and tenant_id = my_tenant_id();
  if not found then raise exception 'Justeringen finns inte' using errcode = 'P0002'; end if;
end $$;
grant execute on function public.d2d_lon_justering_ta_bort(uuid) to authenticated;

/** En månads pinnar och lön per säljare. Nytt: provision (pinnar × kr/pinne),
 *  justeringar och lon = provision + bonus + justeringar. */
create or replace function public.d2d_lon_manad(p_tenant uuid, p_manad date, p_detalj boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select d2d_lonemodell_for(p_tenant) m, coalesce((d2d_lonemodell_for(p_tenant)->>'krPerPinne')::numeric, 0) kr),
  grans as (select (date_trunc('month', p_manad)::timestamp at time zone 'Europe/Stockholm') fran,
                   ((date_trunc('month', p_manad) + interval '1 month')::timestamp at time zone 'Europe/Stockholm') till),
  a as (select af.*, d2d_pinnar(af.d, m.m) p from grans, m, d2d_lon_affarer(p_tenant, grans.fran, grans.till) af),
  j as (select user_id, sum(belopp) s,
               jsonb_agg(jsonb_build_object('id', id, 'belopp', belopp, 'kommentar', kommentar, 'skapadAt', skapad_at,
                 'skapadAv', (select coalesce(nullif(full_name, ''), email::text) from users where id = skapad_av)) order by skapad_at) rader
          from d2d_lon_justering where tenant_id = p_tenant and manad = date_trunc('month', p_manad)::date group by 1),
  saljare as (
    select u.id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) namn
      from users u
     where u.tenant_id = p_tenant and u.deleted_at is null
       and (u.id in (select saljare from a) or u.id in (select user_id from j)
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
  ),
  rad as (
    select per.*, j.s just, j.rader justr,
           round(per.pinnar * m.kr) provision,
           round((per.pinnar + per.vantar) * m.kr) provision_inkl,
           (d2d_bonus_niva(per.pinnar, m.m)->>'bonus')::numeric bonus,
           (d2d_bonus_niva(per.pinnar + per.vantar, m.m)->>'bonus')::numeric bonus_inkl
      from per cross join m
      left join j on j.user_id = per.id
  )
  select jsonb_build_object(
    'manad', to_char(p_manad, 'YYYY-MM'),
    'utbetalning', to_char(date_trunc('month', p_manad) + make_interval(months => coalesce((m.m->>'utbetalningManaderEfter')::int, 1)), 'YYYY-MM'),
    'krPerPinne', m.kr,
    'saljare', coalesce((select jsonb_agg(
        jsonb_build_object('id', rad.id, 'namn', rad.namn, 'pinnar', round(rad.pinnar, 1), 'vantar', round(rad.vantar, 1),
                           'affarer', rad.affarer, 'affarerVantar', rad.affarer_vantar)
        || d2d_bonus_niva(rad.pinnar, m.m)
        || jsonb_build_object('bonusInklVantar', rad.bonus_inkl,
                              'provision', rad.provision, 'provisionInklVantar', rad.provision_inkl,
                              'justeringar', coalesce(rad.just, 0),
                              'lon', rad.provision + rad.bonus + coalesce(rad.just, 0),
                              'lonInklVantar', rad.provision_inkl + rad.bonus_inkl + coalesce(rad.just, 0))
        || case when p_detalj then jsonb_build_object(
             'justeringarRader', coalesce(rad.justr, '[]'::jsonb),
             'produkter', coalesce((
             select jsonb_agg(jsonb_build_object('nyckel', k, 'antal', n, 'pinnar', round(s, 1)) order by s desc)
               from (select r->>'nyckel' k, count(*) n, sum((r->>'pinnar')::numeric) s
                       from a, jsonb_array_elements(d2d_pinnar_rader(a.d, m.m)) r
                      where a.saljare = rad.id and a.kalla <> 'vantar' group by 1) z), '[]'::jsonb)) else '{}'::jsonb end
        order by rad.pinnar desc, rad.namn) from rad), '[]'::jsonb)
  ) from m
$$;

/** Blitz → Översikt: pinnar och nivåer för alla, men inga lönebelopp. */
create or replace function public.d2d_pinnar_oversikt(p_manad date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_m date := coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date);
        v jsonb;
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v := d2d_lon_manad(my_tenant_id(), v_m, false);
  return (v - 'krPerPinne') || jsonb_build_object(
    'saljare', (select coalesce(jsonb_agg(s - 'provision' - 'provisionInklVantar' - 'justeringar' - 'lon' - 'lonInklVantar'), '[]'::jsonb)
                  from jsonb_array_elements(v->'saljare') s),
    'trappa', d2d_lonemodell_for(my_tenant_id())->'trappa', 'jag', auth.uid());
end $$;
grant execute on function public.d2d_pinnar_oversikt(date) to authenticated;
