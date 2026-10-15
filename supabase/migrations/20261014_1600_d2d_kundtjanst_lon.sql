-- =====================================================================
--  D2D: kundtjänst-affärer och kundtjänstens lönemodell (Gustav 2026-10-14)
--
--  Kundtjänst tar emot en klar affär i telefon, registrerar den på adressen
--  i D2D-sälj och lämnar den till en säljare (d2d_kundtjanst_lamna). Säljaren
--  validerar och signerar (Såld eller Scrive). Adressen får
--    data.kundtjanst        = kundtjänstpersonen (låst, bara admin ändrar)
--    data.kundtjanst_lamnad = när den lämnades
--    data.saljare / ägare   = säljaren, status Återkoppling.
--
--  Lön (lönemodellens nyckel "kundtjanst", ändras under Inställningar → Priser):
--    andel        0.8   kundtjänst: alla pinnar, kr/pinne och trappa × andel
--    saljarAndel  0.2   säljaren: pinnar × saljarAndel (räknas mot provision OCH bonus)
--    fastLon      17000 kundtjänstens fasta månadslön (ingår i lön)
--    semesterersattning 0.12 på provision + bonus (visas, sparas till semestern)
--  Säljarens del betalas utöver kundtjänstens och dras inte från den.
-- =====================================================================

-- 1. Fält på lägenheten (validate_record_data kräver definitioner).
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, is_unique, options, visibility, sort_order)
select fd.object_id, fd.tenant_id, v.key, v.label, v.typ, false, false, v.opt::jsonb, v.vis, v.so
  from field_definitions fd
  cross join (values
    ('kundtjanst', 'Kundtjänst', 'user', '{"section":"forsaljning","readonly":true}', 'all', 596),
    ('kundtjanst_lamnad', 'Kundtjänst – lämnad till säljare', 'datetime', '{"section":"forsaljning","readonly":true}', 'hidden', 597)
  ) v(key, label, typ, opt, vis, so)
 where fd.key = 'anger_status_fore'
   and not exists (select 1 from field_definitions x where x.object_id = fd.object_id and x.key = v.key);

-- 2. Standardvärden i lönemodellen.
do $$
declare d text := pg_get_functiondef('public.d2d_lonemodell_standard'::regproc);
begin
  if position('''kundtjanst''' in d) > 0 then return; end if;
  if position('''forstaPeriodTill'', ''2026-10-31'')' in d) = 0 then raise exception 'd2d_lonemodell_standard: oväntad text'; end if;
  execute replace(d, '''forstaPeriodTill'', ''2026-10-31'')',
    '''forstaPeriodTill'', ''2026-10-31'',
    ''kundtjanst'', jsonb_build_object(''andel'', 0.8, ''saljarAndel'', 0.2, ''fastLon'', 17000, ''semesterersattning'', 0.12))');
end $$;

-- 3. Kundtjänstens modell härledd ur säljarnas: kr/pinne och trappa × andel.
create or replace function public.d2d_lon_kundtjanst_modell(p_m jsonb)
 returns jsonb language sql immutable set search_path to 'public' as $$
  select p_m || jsonb_build_object(
    'krPerPinne', round(coalesce((p_m->>'krPerPinne')::numeric, 0) * x.a, 2),
    'trappa', coalesce((select jsonb_agg(jsonb_build_object('pinnar', (s->>'pinnar')::numeric,
                                                            'bonus', round((s->>'bonus')::numeric * x.a))
                                         order by (s->>'pinnar')::numeric)
                          from jsonb_array_elements(coalesce(p_m->'trappa', '[]'::jsonb)) s), '[]'::jsonb))
    from (select coalesce((p_m->'kundtjanst'->>'andel')::numeric, 0.8) a) x
$$;
revoke execute on function public.d2d_lon_kundtjanst_modell(jsonb) from public, anon;
grant execute on function public.d2d_lon_kundtjanst_modell(jsonb) to authenticated, service_role;

-- 4. Lön per person och roll. Varje affär med kundtjänst ger två rader:
--    säljaren (pinnar × saljarAndel) och kundtjänst (alla pinnar, egen modell).
create or replace function public.d2d_lon_manad(p_tenant uuid, p_manad date, p_detalj boolean)
 returns jsonb language sql stable security definer set search_path to 'public' as $function$
  with m as (
    select x.m, coalesce((x.m->>'krPerPinne')::numeric, 0) kr, d2d_lon_kundtjanst_modell(x.m) mkt,
           coalesce((x.m->'kundtjanst'->>'saljarAndel')::numeric, 0.2) kt_salj,
           coalesce((x.m->'kundtjanst'->>'fastLon')::numeric, 0) kt_fast,
           coalesce((x.m->'kundtjanst'->>'semesterersattning')::numeric, 0) kt_sem
      from (select d2d_lonemodell_for(p_tenant) m) x),
  g0 as (select p.fran_d, p.till_d from m, d2d_lon_period(m.m, p_manad) p),
  grans as (select fran_d, till_d,
                   (fran_d::timestamp at time zone 'Europe/Stockholm') fran,
                   (till_d::timestamp at time zone 'Europe/Stockholm') till from g0),
  -- sald = riktig lön; signerat = Scrive (potentiell). Ej signerade räknas inte.
  a0 as (select af.*, d2d_pinnar(af.d, m.m) p,
                case when af.d->>'kundtjanst' ~* '^[0-9a-f-]{36}$' and af.d->>'kundtjanst' <> af.saljare::text
                     then (af.d->>'kundtjanst')::uuid end kt
           from grans, m, d2d_lon_affarer(p_tenant, grans.fran, grans.till) af
          where grans.fran < grans.till and af.kalla in ('sald', 'signerat', 'anger')),
  a as (select a0.lagenhet_id, a0.saljare uid, 'saljare'::text roll, a0.kalla, a0.d,
               case when a0.kt is null then 1::numeric else m.kt_salj end f,
               a0.p * case when a0.kt is null then 1::numeric else m.kt_salj end p,
               a0.kt is not null via_kt
          from a0, m
        union all
        select a0.lagenhet_id, a0.kt, 'kundtjanst', a0.kalla, a0.d, 1::numeric, a0.p, true
          from a0 where a0.kt is not null),
  j0 as (select user_id, sum(belopp) s,
                jsonb_agg(jsonb_build_object('id', id, 'belopp', belopp, 'kommentar', kommentar, 'skapadAt', skapad_at,
                  'skapadAv', (select coalesce(nullif(full_name, ''), email::text) from users where id = skapad_av)) order by skapad_at) rader
           from d2d_lon_justering where tenant_id = p_tenant and manad = date_trunc('month', p_manad)::date group by 1),
  -- Justeringar hamnar på kundtjänstraden om personen har kundtjänstaffärer i perioden.
  j as (select j0.*, case when exists (select 1 from a where a.uid = j0.user_id and a.roll = 'kundtjanst')
                          then 'kundtjanst' else 'saljare' end roll from j0),
  pers as (
    select uid id, roll from a
    union select user_id, roll from j
    union select u.id, 'saljare' from users u
     where u.tenant_id = p_tenant and u.deleted_at is null and u.is_active
       and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.key = 'dorrsaljare')
  ),
  saljare as (
    select p.id, p.roll, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) namn
      from pers p join users u on u.id = p.id and u.tenant_id = p_tenant and u.deleted_at is null
  ),
  per as (
    select s.id, s.roll, s.namn,
           coalesce(sum(a.p) filter (where a.kalla = 'sald'), 0) - coalesce(sum(a.p) filter (where a.kalla = 'anger'), 0) pinnar,
           coalesce(sum(a.p) filter (where a.kalla = 'anger'), 0) anger_pinnar,
           count(a.lagenhet_id) filter (where a.kalla = 'anger') anger,
           coalesce(sum(a.p) filter (where a.kalla = 'signerat'), 0) vantar,
           count(a.lagenhet_id) filter (where a.kalla = 'sald') affarer,
           count(a.lagenhet_id) filter (where a.kalla = 'signerat') affarer_vantar,
           count(a.lagenhet_id) filter (where a.kalla = 'sald' and a.via_kt) affarer_kt,
           count(a.lagenhet_id) filter (where a.kalla = 'signerat' and a.via_kt) affarer_kt_vantar
      from saljare s left join a on a.uid = s.id and a.roll = s.roll
     group by 1, 2, 3
  ),
  rad0 as (
    select per.*, j.s just, j.rader justr,
           case when per.roll = 'kundtjanst' then m.mkt else m.m end mm,
           case when per.roll = 'kundtjanst' then m.kt_fast else 0 end fast,
           case when per.roll = 'kundtjanst' then m.kt_sem else 0 end sem
      from per cross join m
      left join j on j.user_id = per.id and j.roll = per.roll
  ),
  rad as (
    select rad0.*, (mm->>'krPerPinne')::numeric k,
           round(pinnar * (mm->>'krPerPinne')::numeric) provision,
           round((pinnar + vantar) * (mm->>'krPerPinne')::numeric) provision_inkl,
           (d2d_bonus_niva(pinnar, mm)->>'bonus')::numeric bonus,
           (d2d_bonus_niva(pinnar + vantar, mm)->>'bonus')::numeric bonus_inkl
      from rad0
  )
  select jsonb_build_object(
    'manad', to_char(p_manad, 'YYYY-MM'),
    'periodFran', (select fran_d from grans),
    'periodTill', (select till_d - 1 from grans),
    'utbetalning', to_char(date_trunc('month', p_manad) + make_interval(months => coalesce((m.m->>'utbetalningManaderEfter')::int, 1)), 'YYYY-MM'),
    'krPerPinne', m.kr,
    'saljare', coalesce((select jsonb_agg(
        jsonb_build_object('id', rad.id, 'roll', rad.roll, 'namn', rad.namn, 'pinnar', round(rad.pinnar, 1), 'vantar', round(rad.vantar, 1),
                           'affarer', rad.affarer, 'affarerVantar', rad.affarer_vantar,
                           'affarerKundtjanst', rad.affarer_kt, 'affarerKundtjanstVantar', rad.affarer_kt_vantar,
                           'scrive', round(rad.vantar, 1), 'affarerScrive', rad.affarer_vantar, 'anger', rad.anger, 'angerPinnar', round(rad.anger_pinnar, 1))
        || d2d_bonus_niva(rad.pinnar, rad.mm)
        || jsonb_build_object('bonusInklVantar', rad.bonus_inkl,
                              'provision', rad.provision, 'provisionInklVantar', rad.provision_inkl,
                              'justeringar', coalesce(rad.just, 0),
                              'lon', rad.fast + rad.provision + rad.bonus + coalesce(rad.just, 0),
                              'lonInklVantar', rad.fast + rad.provision_inkl + rad.bonus_inkl + coalesce(rad.just, 0),
                              'lonPotentiell', rad.fast + rad.provision_inkl + rad.bonus_inkl + coalesce(rad.just, 0))
        || case when rad.roll = 'kundtjanst' then jsonb_build_object(
             'krPerPinne', rad.k, 'trappa', rad.mm->'trappa', 'fastLon', rad.fast,
             'semesterersattning', round((rad.provision + rad.bonus) * rad.sem),
             'semesterersattningInklVantar', round((rad.provision_inkl + rad.bonus_inkl) * rad.sem)) else '{}'::jsonb end
        || case when p_detalj then jsonb_build_object(
             'justeringarRader', coalesce(rad.justr, '[]'::jsonb),
             'produkter', coalesce((
             select jsonb_agg(jsonb_build_object('nyckel', k, 'antal', n, 'pinnar', round(s, 1),
                                                 'antalScrive', ns, 'pinnarScrive', round(ss, 1)) order by s + ss desc)
               from (select r->>'nyckel' k,
                            count(*) filter (where a.kalla = 'sald') n,
                            coalesce(sum((r->>'pinnar')::numeric * a.f) filter (where a.kalla = 'sald'), 0) s,
                            count(*) filter (where a.kalla = 'signerat') ns,
                            coalesce(sum((r->>'pinnar')::numeric * a.f) filter (where a.kalla = 'signerat'), 0) ss
                       from a, jsonb_array_elements(d2d_pinnar_rader(a.d, m.m)) r
                      where a.uid = rad.id and a.roll = rad.roll group by 1) z), '[]'::jsonb)) else '{}'::jsonb end
        order by rad.roll desc, rad.pinnar desc, rad.vantar desc, rad.namn) from rad), '[]'::jsonb)
  ) from m
$function$;

-- 5. Blitz visar bara säljarrader (kundtjänstens rader har egen modell).
do $$
declare d text := pg_get_functiondef('public.d2d_pinnar_oversikt'::regproc);
        a text := 'from jsonb_array_elements(v->''saljare'') with ordinality r(s, o)),';
        b text := 'from jsonb_array_elements(v->''saljare'') s where s->>''id'' = auth.uid()::text)';
begin
  if position('coalesce(s->>''roll''' in d) > 0 then return; end if;
  if position(a in d) = 0 or position(b in d) = 0 then raise exception 'd2d_pinnar_oversikt: oväntad text'; end if;
  d := replace(d, a, 'from jsonb_array_elements(v->''saljare'') with ordinality r(s, o) where coalesce(s->>''roll'', ''saljare'') = ''saljare''),');
  d := replace(d, b, 'from jsonb_array_elements(v->''saljare'') s where s->>''id'' = auth.uid()::text and coalesce(s->>''roll'', ''saljare'') = ''saljare'')');
  execute d;
end $$;

-- 6. Låset: kundtjänstfältet ändras bara av admin; kundtjänst signerar inte sin egen överlämning.
create or replace function public.d2d_lag_las_saljare()
 returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  v_uid uuid := auth.uid();
  v_old_s text := nullif(btrim(coalesce(old.data->>'saljare', '')), '');
  v_new_s text := nullif(btrim(coalesce(new.data->>'saljare', '')), '');
  v_old_kt text := nullif(btrim(coalesce(old.data->>'kundtjanst', '')), '');
  v_new_kt text := nullif(btrim(coalesce(new.data->>'kundtjanst', '')), '');
  v_sald_forr boolean := old.status in ('sald', 'scrive');
  v_sald_ny boolean := new.status in ('sald', 'scrive');
  v_admin boolean := v_uid is not null and public.is_admin();
begin
  -- Importen (adresslista ur fil) sätter status och säljare själv.
  if current_setting('d2d.import', true) = '1' then return new; end if;

  -- Kundtjänstfältet sätts bara av d2d_kundtjanst_lamna (eller admin). Ett
  -- formulär som sparar gammal data får inte radera eller byta det.
  if v_new_kt is distinct from v_old_kt and not v_admin and current_setting('d2d.kundtjanst', true) is distinct from '1' then
    new.data := case when v_old_kt is null then new.data - 'kundtjanst' - 'kundtjanst_lamnad'
                     else new.data || jsonb_build_object('kundtjanst', v_old_kt, 'kundtjanst_lamnad', old.data->'kundtjanst_lamnad') end;
    v_new_kt := v_old_kt;
  end if;

  -- Låset: en såld/signerad adress behåller sin säljare. Bara admin får byta.
  if v_sald_forr and v_sald_ny and v_old_s is not null and v_new_s is distinct from v_old_s and not v_admin then
    raise exception 'Adressen är såld och låst till säljaren som sålde den. Kontakta admin.'
      using errcode = '42501';
  end if;

  -- Kundtjänst som lämnat affären signerar den inte själv — säljaren gör det.
  if v_sald_ny and not v_sald_forr and not v_admin and v_new_kt is not null and v_new_kt = v_uid::text then
    raise exception 'Affären är lämnad till en säljare. Säljaren validerar och signerar (Såld eller Scrive).'
      using errcode = '42501';
  end if;

  -- Vid Såld / Signera med Scrive: den som klickar blir säljare (om inte
  -- anropet redan sätter säljaren uttryckligen). En admin som sätter
  -- statusen på en adress som redan har en säljare tar inte över affären.
  if v_sald_ny and not v_sald_forr and v_uid is not null
     and v_new_s is not distinct from v_old_s
     and (v_old_s is null or not v_admin)
     and exists (select 1 from users u where u.id = v_uid and u.tenant_id = new.tenant_id) then
    new.data := new.data || jsonb_build_object('saljare', v_uid::text);
  end if;
  return new;
end $function$;

-- 7. Kundtjänst: behörighet, säljare att välja och egna affärer.
create or replace function public.d2d_ar_kundtjanst()
 returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                  where ur.user_id = auth.uid() and r.tenant_id = my_tenant_id()
                    and r.key in ('kundtjanst', 'kundtjanst_leverans'))
$$;

create or replace function public.d2d_kundtjanst_info()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'arKundtjanst', d2d_ar_kundtjanst() or is_admin(),
    'saljare', coalesce((select jsonb_agg(jsonb_build_object('id', u.id,
                                 'namn', coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1))) order by u.full_name)
                          from users u
                         where u.tenant_id = my_tenant_id() and u.deleted_at is null and u.is_active and u.id <> auth.uid()
                           and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                        where ur.user_id = u.id and r.key = 'dorrsaljare')), '[]'::jsonb),
    -- Mina överlämnade affärer (senaste 60 dagarna): kundtjänst ser dem här även när adressen nu ägs av säljaren.
    'mina', coalesce((select jsonb_agg(jsonb_build_object(
                'id', l.id, 'lgh', l.title, 'status', l.status,
                'adress', concat_ws(' ', l.data->>'gatunamn', l.data->>'gatunummer'),
                'kund', l.data->>'kund_namn', 'lamnad', l.data->>'kundtjanst_lamnad',
                'saljare', (select coalesce(nullif(full_name, ''), split_part(email::text, '@', 1)) from users where id::text = l.data->>'saljare'),
                'pinnar', round(d2d_pinnar(l.data, d2d_lonemodell_for(l.tenant_id)), 1))
              order by l.data->>'kundtjanst_lamnad' desc)
              from records l
             where l.tenant_id = my_tenant_id() and l.object_type = 'd2d_lagenhet' and l.deleted_at is null
               and l.data->>'kundtjanst' = auth.uid()::text
               and coalesce(nullif(l.data->>'kundtjanst_lamnad', '')::timestamptz, l.updated_at) > now() - interval '60 days'), '[]'::jsonb))
$$;

create or replace function public.d2d_kundtjanst_lamna(p_lagenhet uuid, p_saljare uuid, p_kommentar text default null)
 returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_uid uuid := auth.uid();
  v_t uuid := my_tenant_id();
  r records%rowtype;
  v_namn text;
  v_komm text;
begin
  if not (d2d_ar_kundtjanst() or is_admin()) then
    raise exception 'Bara kundtjänst kan lämna en affär till en säljare' using errcode = '42501';
  end if;
  select * into r from records where id = p_lagenhet and tenant_id = v_t and object_type = 'd2d_lagenhet' and deleted_at is null for update;
  if not found then raise exception 'Adressen finns inte' using errcode = 'P0002'; end if;
  if not (is_admin() or d2d_kan_lasa(r.id, r.object_type, r.owner_user_id)) then
    raise exception 'Du har inte tillgång till adressen' using errcode = '42501';
  end if;
  if r.status in ('sald', 'scrive', 'anger') then
    raise exception 'Adressen är redan såld eller signerad' using errcode = '22023';
  end if;
  if p_saljare = v_uid then
    raise exception 'Välj en annan säljare än dig själv' using errcode = '22023';
  end if;
  select coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) into v_namn
    from users u
   where u.id = p_saljare and u.tenant_id = v_t and u.deleted_at is null and u.is_active
     and exists (select 1 from user_roles ur join roles ro on ro.id = ur.role_id where ur.user_id = u.id and ro.key = 'dorrsaljare');
  if v_namn is null then raise exception 'Säljaren finns inte eller är inte dörrsäljare' using errcode = '22023'; end if;

  v_komm := concat_ws(E'\n', nullif(btrim(r.data->>'kommentar'), ''),
             'Kundtjänst (' || coalesce((select coalesce(nullif(full_name, ''), email::text) from users where id = v_uid), '') || ', '
             || to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD HH24:MI') || '): lämnad till ' || v_namn
             || coalesce(' – ' || nullif(btrim(p_kommentar), ''), ''));

  perform set_config('d2d.kundtjanst', '1', true);
  update records
     set data = data || jsonb_build_object('kundtjanst', v_uid::text, 'kundtjanst_lamnad', now(),
                                           'saljare', p_saljare::text, 'kommentar', v_komm,
                                           'aterkoppling_datum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')),
         status = 'aterkoppling', owner_user_id = p_saljare, updated_at = now()
   where id = r.id;
  perform set_config('d2d.kundtjanst', '', true);

  insert into activities (tenant_id, record_id, activity_type, occurred_at, actor_user_id, body, metadata)
  values (v_t, r.id, 'status_change', now(), v_uid, 'Kundtjänst lämnade affären till ' || v_namn,
          jsonb_build_object('from', r.status, 'to', 'aterkoppling', 'kundtjanst', v_uid, 'saljare', p_saljare));

  return jsonb_build_object('ok', true, 'saljare', v_namn);
end $$;

revoke execute on function public.d2d_ar_kundtjanst(), public.d2d_kundtjanst_info(), public.d2d_kundtjanst_lamna(uuid, uuid, text) from public, anon;
grant execute on function public.d2d_ar_kundtjanst(), public.d2d_kundtjanst_info(), public.d2d_kundtjanst_lamna(uuid, uuid, text) to authenticated, service_role;

-- 8. Lönemodellen: rimliga värden för kundtjänst.
do $$
declare d text := pg_get_functiondef('public.set_d2d_lonemodell'::regproc);
        a text := '  insert into d2d_lonemodell';
begin
  if position('kundtjanst' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'set_d2d_lonemodell: oväntad text'; end if;
  execute replace(d, a, '  if p_data ? ''kundtjanst'' and (
       jsonb_typeof(p_data->''kundtjanst'') is distinct from ''object''
       or coalesce((p_data->''kundtjanst''->>''andel'')::numeric, 0.8) not between 0 and 1
       or coalesce((p_data->''kundtjanst''->>''saljarAndel'')::numeric, 0.2) not between 0 and 1
       or coalesce((p_data->''kundtjanst''->>''semesterersattning'')::numeric, 0) not between 0 and 1
       or coalesce((p_data->''kundtjanst''->>''fastLon'')::numeric, 0) < 0) then
    raise exception ''Kundtjänst: andelar och semesterersättning anges som 0–1, fast lön som kronor'' using errcode = ''22023'';
  end if;
' || a);
end $$;

-- 9. Kundtjänst ser och arbetar på alla adresser (Gustav 2026-10-14): läsa och
--    ändra alla D2D-lägenheter, läsa alla fastigheter, och se även återkopplingar
--    som är kopplade till en säljare i Alla lägenheter.
insert into role_permissions (role_id, tenant_id, object_type, action, scope)
select r.id, r.tenant_id, v.ot, v.ac, 'tenant'
  from roles r cross join (values ('d2d_lagenhet','read'), ('d2d_lagenhet','update'), ('d2d_fastighet','read')) v(ot, ac)
 where r.key = 'kundtjanst'
   and not exists (select 1 from role_permissions x where x.role_id = r.id and x.object_type = v.ot and x.action = v.ac);
update role_permissions rp set scope = 'tenant' from roles r
 where r.id = rp.role_id and r.key = 'kundtjanst' and (rp.object_type, rp.action) in (('d2d_lagenhet','read'), ('d2d_lagenhet','update'), ('d2d_fastighet','read'));

do $$
declare d text := pg_get_functiondef('public.d2d_alla_lagenheter'::regproc);
        a text := 'auth.uid() as me, is_admin() as admin,';
        b text := '     where t.admin
';
begin
  if position('d2d_ar_kundtjanst()' in d) > 0 then return; end if;
  if position(a in d) = 0 or position(b in d) = 0 then raise exception 'd2d_alla_lagenheter: oväntad text'; end if;
  d := replace(d, a, 'auth.uid() as me, is_admin() as admin, d2d_ar_kundtjanst() as kt,');
  d := replace(d, b, '     where t.admin or t.kt
');
  d := replace(d, '''aterkoppling_datum'', d->''aterkoppling_datum'', ''tillfallig'', d->''tillfallig''',
                  '''aterkoppling_datum'', d->''aterkoppling_datum'', ''tillfallig'', d->''tillfallig'', ''kundtjanst'', d->''kundtjanst''');
  execute d;
end $$;

-- 10. Sidan "Sälj från kundtjänst" (D2D-sälj → under Alla lägenheter): alla
--     kundtjänstaffärer. Säljaren ser sina; admin och kundtjänst ser alla.
--     "Ny" = status Återkoppling (väntar på säljaren). Antal nya per säljare.
create or replace function public.d2d_kundtjanst_salj()
 returns jsonb language sql stable security definer set search_path to 'public' as $$
  with t as (select auth.uid() me, my_tenant_id() tid, (is_admin() or d2d_ar_kundtjanst()) alla),
  m as (select d2d_lonemodell_for((select tid from t)) m),
  l as (
    select r.id, r.status, r.title lgh, r.data d,
           nullif(r.data->>'saljare', '') saljare, nullif(r.data->>'kundtjanst', '') kt,
           coalesce(nullif(r.data->>'kundtjanst_lamnad', '')::timestamptz, r.updated_at) lamnad,
           r.status = 'aterkoppling' ny
      from records r, t
     where r.tenant_id = t.tid and r.object_type = 'd2d_lagenhet' and r.deleted_at is null
       and nullif(r.data->>'kundtjanst', '') is not null
       and (t.alla or r.data->>'saljare' = t.me::text)
  ),
  namn as (select u.id::text id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) n
             from users u where u.tenant_id = (select tid from t))
  select jsonb_build_object(
    'alla', (select alla from t),
    'minaNya', (select count(*) from l, t where l.ny and l.saljare = t.me::text),
    'saljare', coalesce((select jsonb_agg(jsonb_build_object('id', s.saljare, 'namn', coalesce(nm.n, '—'), 'nya', s.nya, 'totalt', s.tot)
                                 order by s.nya desc, nm.n)
                          from (select saljare, count(*) filter (where ny) nya, count(*) tot from l group by 1) s
                          left join namn nm on nm.id = s.saljare), '[]'::jsonb),
    'affarer', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', l.id, 'status', l.status, 'ny', l.ny, 'lgh', l.lgh,
                 'adress', concat_ws(' ', l.d->>'gatunamn', l.d->>'gatunummer'),
                 'kund', l.d->>'kund_namn', 'telefon', l.d->>'kund_telefon',
                 'saljareId', l.saljare, 'saljare', (select n from namn where id = l.saljare),
                 'kundtjanst', (select n from namn where id = l.kt),
                 'lamnad', l.lamnad, 'pinnar', round(d2d_pinnar(l.d, (select m from m)), 1))
               order by l.ny desc, l.lamnad desc) from l), '[]'::jsonb)
  )
$$;
revoke execute on function public.d2d_kundtjanst_salj() from public, anon;
grant execute on function public.d2d_kundtjanst_salj() to authenticated, service_role;
