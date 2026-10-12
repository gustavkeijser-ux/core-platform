-- =====================================================================
--  D2D: klicka på en säljare i Utfall och i Blitz → Översikt (Pinnar) och
--  se hur många av varje tjänst som sålts (bredband per hastighet, TV,
--  streaming, sport, trygghet, mobil, extraanvändare, router, TV-box).
--
--  - d2d_tjanst_rader(d): en rad per såld tjänst i en lägenhets data
--    (samma regler som pinnarna, men bredband per hastighet och även
--    router/TV-box som inte ger pinnar).
--  - d2d_tjanst_etikett(tenant, nyckel): etikett ur field_definitions.
--  - d2d_utfall_kalla: perSaljare får 'tjanster' (nyckel, etikett, antal).
--  - d2d_pinnar_oversikt: per säljare 'produkter' (pinnunderlaget, med
--    etikett) och 'tjanster' (antal + antalScrive). Rättar samtidigt att
--    den liggande versionen var den gamla: lönebeloppen (provision, lon …)
--    skickades till alla i Blitz och minLon saknades (migration
--    20261006_2217 hade skrivits över av 20261006_1900).
-- =====================================================================

create or replace function public.d2d_tjanst_rader(d jsonb)
returns setof text language sql immutable as $$
  with mob as (select d2d_arr(d->'salt_mobil') a)
  select 'salt_bredband' || coalesce(':' || nullif(d->>'salt_bredband', ''), '')
   where nullif(d->>'salt_bredband', '') is not null or d->'salt_svar'->>'salt_bredband' = 'true'
      or not (d ? 'salt_svar' or d ? 'salt_bredband' or d ? 'salt_mobil' or d ? 'salt_tv')
  union all select 'salt_trygghet' where d->>'salt_trygghet' = 'true'
  union all select 'salt_tv:' || (d->>'salt_tv') where nullif(d->>'salt_tv', '') is not null
  union all select 'salt_streaming_film:' || (d->>'salt_streaming_film') where nullif(d->>'salt_streaming_film', '') is not null
  union all select 'salt_streaming_sport:' || (d->>'salt_streaming_sport') where nullif(d->>'salt_streaming_sport', '') is not null
  union all select 'salt_router' || coalesce(':' || nullif(d->>'salt_router', ''), '')
   where nullif(d->>'salt_router', '') is not null or d->'salt_svar'->>'salt_router' = 'true'
  union all select 'salt_tvbox' where d->>'salt_tvbox' = 'true' or d->'salt_svar'->>'salt_tvbox' = 'true'
  union all select 'salt_mobil:' || x from mob, jsonb_array_elements_text(mob.a) x where x <> 'extra_anvandare'
  union all select 'salt_mobil:extra_anvandare'
    from generate_series(1, greatest(
           (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array'
                                                           then d->'mobil_nummer'->'rows' else '[]'::jsonb end) x
             where x->>'typ' = 'extra'),
           case when (select a from mob) ? 'extra_anvandare' then d2d_extra_antal(d) else 0 end)::int)
$$;

/** "salt_tv:tv_bas" → "TV – TV Mini" ur fältdefinitionerna; "salt_bredband" utan hastighet → "Bredband (hastighet ej angiven)". */
create or replace function public.d2d_tjanst_etikett(p_tenant uuid, p_nyckel text)
returns text language sql stable as $$
  select case when f.key is null then p_nyckel
              when split_part(p_nyckel, ':', 2) = '' then
                   case when f.key = 'salt_bredband' then 'Bredband (hastighet ej angiven)' else f.label end
              else f.label || ' – ' || coalesce(
                     (select c->>'label' from jsonb_array_elements(coalesce(f.options->'choices', '[]'::jsonb)) c
                       where c->>'key' = split_part(p_nyckel, ':', 2)), split_part(p_nyckel, ':', 2)) end
    from (select 1) x
    left join (field_definitions f join object_definitions od on od.id = f.object_id and od.key = 'd2d_lagenhet')
           on f.tenant_id = p_tenant and f.key = split_part(p_nyckel, ':', 1)
$$;

/** Blitz → Översikt: pinnar, nivåer, produkter och tjänster per säljare; lön bara för en själv. */
create or replace function public.d2d_pinnar_oversikt(p_manad date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_m date := coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date);
        v_t uuid := my_tenant_id(); v jsonb; v_mod jsonb; v_fran timestamptz; v_till timestamptz;
begin
  if not can_do('d2d_lagenhet', 'read') then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v_mod := d2d_lonemodell_for(v_t);
  select (p.fran_d::timestamp at time zone 'Europe/Stockholm'), (p.till_d::timestamp at time zone 'Europe/Stockholm')
    into v_fran, v_till from d2d_lon_period(v_mod, v_m) p;
  v := d2d_lon_manad(v_t, v_m, true);
  return (v - 'krPerPinne') || jsonb_build_object(
    'saljare', (select coalesce(jsonb_agg(
        (s - 'provision' - 'provisionInklVantar' - 'justeringar' - 'lon' - 'lonInklVantar' - 'lonPotentiell' - 'justeringarRader')
        || jsonb_build_object(
             'produkter', (select coalesce(jsonb_agg(p || jsonb_build_object('etikett', case when p->>'nyckel' = 'salt_bredband' then 'Bredband (alla hastigheter)'
                                                                                      else d2d_tjanst_etikett(v_t, p->>'nyckel') end) order by o), '[]'::jsonb)
                             from jsonb_array_elements(coalesce(s->'produkter', '[]'::jsonb)) with ordinality q(p, o)),
             'tjanster', (select coalesce(jsonb_agg(jsonb_build_object('nyckel', k, 'etikett', d2d_tjanst_etikett(v_t, k), 'antal', n, 'antalScrive', ns)
                                                    order by n + ns desc, k), '[]'::jsonb)
                            from (select tj.nyckel k, count(*) filter (where a.kalla = 'sald') n, count(*) filter (where a.kalla = 'signerat') ns
                                    from d2d_lon_affarer(v_t, v_fran, v_till) a, d2d_tjanst_rader(a.d) tj(nyckel)
                                   where v_fran < v_till and a.saljare = (s->>'id')::uuid and a.kalla in ('sald', 'signerat')
                                   group by 1) z))
        order by o), '[]'::jsonb)
        from jsonb_array_elements(v->'saljare') with ordinality r(s, o)),
    -- Den inloggades egen lön (andras lön visas aldrig i Blitz).
    'minLon', (select jsonb_build_object('provision', s->'provision', 'bonus', s->'bonus', 'justeringar', s->'justeringar',
                                         'lon', s->'lon', 'lonInklVantar', s->'lonInklVantar', 'krPerPinne', v->'krPerPinne')
                 from jsonb_array_elements(v->'saljare') s where s->>'id' = auth.uid()::text),
    'trappa', v_mod->'trappa', 'jag', auth.uid());
end $$;
grant execute on function public.d2d_pinnar_oversikt(date) to authenticated;

-- Utfall: perSaljare får 'tjanster' (ändras på plats i d2d_utfall_kalla).
do $$
declare v text; v_gammal text; v_ny text;
begin
  v := pg_get_functiondef('public.d2d_utfall_kalla(text, uuid, uuid, date, date)'::regprocedure);
  if position('d2d_tjanst_rader' in v) > 0 then
    raise notice 'd2d_utfall_kalla har redan tjanster'; return;
  end if;
  v_gammal := '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal)';
  v_ny := '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal,' || E'\n'
       || '          ''tjanster'', (select coalesce(jsonb_agg(jsonb_build_object(''nyckel'', k, ''etikett'', d2d_tjanst_etikett(my_tenant_id(), k), ''antal'', n) order by n desc, k), ''[]''::jsonb)' || E'\n'
       || '                          from (select tj.nyckel k, count(*) n from urval u2, d2d_tjanst_rader(u2.d) tj(nyckel)' || E'\n'
       || '                                 where u2.ar_sald and u2.saljare = s.saljare group by 1) z))';
  if position(v_gammal in v) = 0 then
    raise exception 'd2d_utfall_kalla: hittar inte perSaljare-raden att ändra';
  end if;
  v := replace(v, v_gammal, v_ny);
  execute v;
end $$;
