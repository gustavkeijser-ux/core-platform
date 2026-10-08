-- =====================================================================
--  D2D Löner: första löneperioden är 26 september–31 oktober 2026 och
--  betalas ut i november (Gustav 2026-10-07). Därefter kalendermånader.
--
--  Lönemodellen får forstaPeriodTill (standard 2026-10-31). Löneperioden
--  för en månad M (d2d_lon_period):
--    - M före första periodens månad  -> tom period (ingen lön)
--    - M = första periodens månad     -> startdatum .. sista dagen i M
--    - M efter                        -> hela kalendermånaden
--  Utan forstaPeriodTill: från startdatum, kalendermånader (som förut).
--  Justeringar för första perioden ligger på månaden 2026-10.
-- =====================================================================

/** Löneperioden [fran_d, till_d) för kalendermånaden p_manad enligt modellen. */
create or replace function public.d2d_lon_period(p_modell jsonb, p_manad date)
returns table (fran_d date, till_d date) language sql immutable as $$
  with x as (
    select date_trunc('month', p_manad)::date mstart,
           (date_trunc('month', p_manad) + interval '1 month')::date mslut,
           coalesce(nullif(p_modell->>'startdatum', '')::date, '2000-01-01'::date) start,
           date_trunc('month', nullif(p_modell->>'forstaPeriodTill', '')::date)::date forsta)
  select case when forsta is null then greatest(mstart, start)
              when mstart < forsta then mslut          -- före första perioden: tom
              when mstart = forsta then least(start, mstart)
              else mstart end,
         mslut
    from x
$$;

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
      'salt_streaming_sport:tv4_sport_hockey', 0.6,
      'salt_streaming_sport:tv4_sport_total', 0.6,
      'salt_streaming_sport:viaplay_all_sport', 0.6,
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
    'startdatum', '2026-09-26',
    'forstaPeriodTill', '2026-10-31')
$$;

create or replace function public.d2d_lon_manad(p_tenant uuid, p_manad date, p_detalj boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  with m as (select d2d_lonemodell_for(p_tenant) m, coalesce((d2d_lonemodell_for(p_tenant)->>'krPerPinne')::numeric, 0) kr),
  g0 as (select p.fran_d, p.till_d from m, d2d_lon_period(m.m, p_manad) p),
  grans as (select fran_d, till_d,
                   (fran_d::timestamp at time zone 'Europe/Stockholm') fran,
                   (till_d::timestamp at time zone 'Europe/Stockholm') till from g0),
  -- sald = riktig lön; signerat = Scrive (potentiell). Ej signerade räknas inte.
  a as (select af.*, d2d_pinnar(af.d, m.m) p from grans, m, d2d_lon_affarer(p_tenant, grans.fran, grans.till) af
         where grans.fran < grans.till and af.kalla in ('sald', 'signerat')),
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
           coalesce(sum(a.p) filter (where a.kalla = 'sald'), 0) pinnar,
           coalesce(sum(a.p) filter (where a.kalla = 'signerat'), 0) vantar,
           count(a.lagenhet_id) filter (where a.kalla = 'sald') affarer,
           count(a.lagenhet_id) filter (where a.kalla = 'signerat') affarer_vantar
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
    'periodFran', (select fran_d from grans),
    'periodTill', (select till_d - 1 from grans),
    'utbetalning', to_char(date_trunc('month', p_manad) + make_interval(months => coalesce((m.m->>'utbetalningManaderEfter')::int, 1)), 'YYYY-MM'),
    'krPerPinne', m.kr,
    'saljare', coalesce((select jsonb_agg(
        jsonb_build_object('id', rad.id, 'namn', rad.namn, 'pinnar', round(rad.pinnar, 1), 'vantar', round(rad.vantar, 1),
                           'affarer', rad.affarer, 'affarerVantar', rad.affarer_vantar,
                           'scrive', round(rad.vantar, 1), 'affarerScrive', rad.affarer_vantar)
        || d2d_bonus_niva(rad.pinnar, m.m)
        || jsonb_build_object('bonusInklVantar', rad.bonus_inkl,
                              'provision', rad.provision, 'provisionInklVantar', rad.provision_inkl,
                              'justeringar', coalesce(rad.just, 0),
                              'lon', rad.provision + rad.bonus + coalesce(rad.just, 0),
                              'lonInklVantar', rad.provision_inkl + rad.bonus_inkl + coalesce(rad.just, 0),
                              'lonPotentiell', rad.provision_inkl + rad.bonus_inkl + coalesce(rad.just, 0))
        || case when p_detalj then jsonb_build_object(
             'justeringarRader', coalesce(rad.justr, '[]'::jsonb),
             'produkter', coalesce((
             select jsonb_agg(jsonb_build_object('nyckel', k, 'antal', n, 'pinnar', round(s, 1),
                                                 'antalScrive', ns, 'pinnarScrive', round(ss, 1)) order by s + ss desc)
               from (select r->>'nyckel' k,
                            count(*) filter (where a.kalla = 'sald') n,
                            coalesce(sum((r->>'pinnar')::numeric) filter (where a.kalla = 'sald'), 0) s,
                            count(*) filter (where a.kalla = 'signerat') ns,
                            coalesce(sum((r->>'pinnar')::numeric) filter (where a.kalla = 'signerat'), 0) ss
                       from a, jsonb_array_elements(d2d_pinnar_rader(a.d, m.m)) r
                      where a.saljare = rad.id group by 1) z), '[]'::jsonb)) else '{}'::jsonb end
        order by rad.pinnar desc, rad.vantar desc, rad.namn) from rad), '[]'::jsonb)
  ) from m
$$;

/** Löner: innevarande period och bakåt, aldrig före lönemodellens startdatum. */
create or replace function public.d2d_lon_prognos(p_manad date default null, p_antal integer default 3)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_m date := date_trunc('month', coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date))::date;
  v_mod jsonb;
  v_start date;
begin
  if not d2d_lon_behorig() then
    raise exception 'Saknar behörighet till löner' using errcode = '42501';
  end if;
  v_mod := d2d_lonemodell_for(my_tenant_id());
  -- Första löneperiodens månad (den månad första perioden slutar i)
  v_start := date_trunc('month', coalesce(nullif(v_mod->>'forstaPeriodTill', '')::date,
                                          nullif(v_mod->>'startdatum', '')::date, '2000-01-01'::date))::date;
  return jsonb_build_object(
    'modell', v_mod,
    'manader', coalesce((select jsonb_agg(d2d_lon_manad(my_tenant_id(), mm, true) order by mm desc)
                  from (select (v_m - make_interval(months => i))::date mm
                          from generate_series(0, greatest(1, least(coalesce(p_antal, 3), 12)) - 1) i) x
                 where mm >= v_start), '[]'::jsonb));
end $$;
grant execute on function public.d2d_lon_prognos(date, integer) to authenticated;
