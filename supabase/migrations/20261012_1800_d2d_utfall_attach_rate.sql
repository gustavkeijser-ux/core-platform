-- =====================================================================
--  D2D: attach rate i Utfall — hur stor andel av de tecknade bredbanden
--  som också fick TV, streaming, sport, trygghet, mobil, extraanvändare,
--  router och TV-box (per tjänst, hela urvalet och per säljare).
--
--  - d2d_kategori_rader(d): en rad per tjänstekategori i en lägenhets data
--    (samma regler som 'kategorier' i d2d_utfall_kalla; extraanvändare en
--    rad per styck). Nya kategorier: tv_alla (även TV Start/Bas), router,
--    tvbox.
--  - d2d_utfall_kalla: sald.kategorier får tv_alla, router, tvbox;
--    perSaljare får 'kategorier' (samma nycklar, räknat på säljarens
--    sålda/signerade kunder). Andelarna räknas i frontend:
--    kategori / bredband.
-- =====================================================================

create or replace function public.d2d_kategori_rader(d jsonb)
returns setof text language sql immutable as $$
  select 'bredband'
   where nullif(d->>'salt_bredband', '') is not null or d->'salt_svar'->>'salt_bredband' = 'true'
      or not (d ? 'salt_svar' or d ? 'salt_bredband' or d ? 'salt_mobil' or d ? 'salt_tv')
  union all select 'bredbandUtanUppgift' where not (d ? 'salt_svar' or d ? 'salt_bredband' or d ? 'salt_mobil' or d ? 'salt_tv')
  union all select 'tv' where d2d_tv_raknas(d)
  union all select 'tv_alla' where nullif(d->>'salt_tv', '') is not null
  union all select 'mobil_huvud' where exists (select 1 from jsonb_array_elements_text(d2d_arr(d->'salt_mobil')) x where x <> 'extra_anvandare')
  union all select 'mobil_extra'
    from generate_series(1, greatest(
           (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->'mobil_nummer'->'rows') = 'array'
                                                           then d->'mobil_nummer'->'rows' else '[]'::jsonb end) x
             where x->>'typ' = 'extra'),
           case when d2d_arr(d->'salt_mobil') ? 'extra_anvandare' then d2d_extra_antal(d) else 0 end)::int)
  union all select 'streaming_film' where nullif(d->>'salt_streaming_film', '') is not null
  union all select 'streaming_sport' where nullif(d->>'salt_streaming_sport', '') is not null
  union all select 'trygghet' where d->>'salt_trygghet' = 'true'
  union all select 'router' where nullif(d->>'salt_router', '') is not null or d->'salt_svar'->>'salt_router' = 'true'
  union all select 'tvbox' where d->>'salt_tvbox' = 'true' or d->'salt_svar'->>'salt_tvbox' = 'true'
$$;

do $$
declare v text; v_gammal text; v_ny text;
begin
  v := pg_get_functiondef('public.d2d_utfall_kalla(text, uuid, uuid, date, date)'::regprocedure);
  if position('d2d_kategori_rader' in v) > 0 then
    raise notice 'd2d_utfall_kalla har redan attach rate'; return;
  end if;

  -- 1) Hela urvalet: tv_alla, router, tvbox i sald.kategorier.
  v_gammal := '''trygghet'', (select count(*) from salda where d->>''salt_trygghet'' = ''true'')),';
  v_ny := '''trygghet'', (select count(*) from salda where d->>''salt_trygghet'' = ''true''),' || E'\n'
       || '        ''tv_alla'', (select count(*) from salda where nullif(d->>''salt_tv'', '''') is not null),' || E'\n'
       || '        ''router'', (select count(*) from salda where exists (select 1 from d2d_kategori_rader(d) k where k = ''router'')),' || E'\n'
       || '        ''tvbox'', (select count(*) from salda where exists (select 1 from d2d_kategori_rader(d) k where k = ''tvbox''))),';
  if position(v_gammal in v) = 0 then
    raise exception 'd2d_utfall_kalla: hittar inte kategorier-raden (trygghet) att ändra';
  end if;
  v := replace(v, v_gammal, v_ny);

  -- 2) Per säljare: 'tjanster' (från 20261012_1600 — hade skrivits över i den
  --    liggande funktionen 12 okt, läggs tillbaka om den saknas) och
  --    'kategorier' (antal per kategori hos säljarens sålda/signerade kunder).
  v_gammal := '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal';
  if position(v_gammal || ')' in v) > 0 then
    v := replace(v, v_gammal || ')', v_gammal || ',' || E'\n'
       || '          ''tjanster'', (select coalesce(jsonb_agg(jsonb_build_object(''nyckel'', k, ''etikett'', d2d_tjanst_etikett(my_tenant_id(), k), ''antal'', n) order by n desc, k), ''[]''::jsonb)' || E'\n'
       || '                          from (select tj.nyckel k, count(*) n from urval u2, d2d_tjanst_rader(u2.d) tj(nyckel)' || E'\n'
       || '                                 where u2.ar_sald and u2.saljare = s.saljare group by 1) z))');
  end if;
  v_gammal := v_gammal || ',';
  v_ny := v_gammal || E'\n'
       || '          ''kategorier'', (select coalesce(jsonb_object_agg(k, n), ''{}''::jsonb)' || E'\n'
       || '                            from (select kr.k, count(*) n from urval u3, d2d_kategori_rader(u3.d) kr(k)' || E'\n'
       || '                                   where u3.ar_sald and u3.saljare = s.saljare group by 1) z),';
  if position(v_gammal in v) = 0 then
    raise exception 'd2d_utfall_kalla: hittar inte perSaljare-raden att ändra';
  end if;
  v := replace(v, v_gammal, v_ny);
  execute v;
end $$;
