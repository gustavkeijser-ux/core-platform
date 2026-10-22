-- D2D: Router, TV-box, TV Start och TV Bas räknas inte någonstans i Utfall (Gustav 22 okt 2026).
--  * d2d_kategori_rader: kategorierna tv_alla (TV inkl. Start/Bas), router och tvbox tas bort
--    (attach rate, kategorier per säljare, Excel-rapporten). "tv" räknar redan bara TV utöver Start/Bas.
--  * d2d_tjanst_rader: sålda tjänster (Utfall per säljare, Excel-rapportens Sålda, Mina pinnar)
--    utan router, TV-box och TV Start/Bas.
--  * d2d_utfall_kalla: summeringen under Sålt utan tv_alla, router och tvbox.
-- Pinnar påverkas inte (de ger redan 0 pinnar).
do $$
declare
  f text; d text; n text; b jsonb; defs jsonb := '{}'::jsonb;
  byten jsonb := jsonb_build_array(
    jsonb_build_array('public.d2d_kategori_rader(jsonb)',
      E'  union all select ''tv_alla'' where nullif(d->>''salt_tv'', '''') is not null\n', ''),
    jsonb_build_array('public.d2d_kategori_rader(jsonb)',
      E'  union all select ''router'' where nullif(d->>''salt_router'', '''') is not null or d->''salt_svar''->>''salt_router'' = ''true''\n', ''),
    jsonb_build_array('public.d2d_kategori_rader(jsonb)',
      E'  union all select ''tvbox'' where d->>''salt_tvbox'' = ''true'' or d->''salt_svar''->>''salt_tvbox'' = ''true''\n', ''),
    jsonb_build_array('public.d2d_tjanst_rader(jsonb)',
      E'  union all select ''salt_tv:'' || (d->>''salt_tv'') where nullif(d->>''salt_tv'', '''') is not null\n',
      E'  union all select ''salt_tv:'' || (d->>''salt_tv'') where d2d_tv_raknas(d)\n'),
    jsonb_build_array('public.d2d_tjanst_rader(jsonb)',
      E'  union all select ''salt_router'' || coalesce('':'' || nullif(d->>''salt_router'', ''''), '''')\n   where nullif(d->>''salt_router'', '''') is not null or d->''salt_svar''->>''salt_router'' = ''true''\n', ''),
    jsonb_build_array('public.d2d_tjanst_rader(jsonb)',
      E'  union all select ''salt_tvbox'' where d->>''salt_tvbox'' = ''true'' or d->''salt_svar''->>''salt_tvbox'' = ''true''\n', ''),
    jsonb_build_array('public.d2d_utfall_kalla(text,uuid,uuid,date,date)',
      E'''trygghet'', (select count(*) from salda where d->>''salt_trygghet'' = ''true''),\n        ''tv_alla'', (select count(*) from salda where nullif(d->>''salt_tv'', '''') is not null),\n        ''router'', (select count(*) from salda where exists (select 1 from d2d_kategori_rader(d) k where k = ''router'')),\n        ''tvbox'', (select count(*) from salda where exists (select 1 from d2d_kategori_rader(d) k where k = ''tvbox''))),',
      E'''trygghet'', (select count(*) from salda where d->>''salt_trygghet'' = ''true'')),')
  );
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
