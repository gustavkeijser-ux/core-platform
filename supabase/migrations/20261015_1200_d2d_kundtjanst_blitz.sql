-- =====================================================================
--  D2D: kundtjänst ser sina pinnar i Blitz → Översikt (Gustav 2026-10-15)
--  d2d_pinnar_oversikt returnerar 'kundtjanst' = den inloggades egen kundtjänstrad
--  ur d2d_lon_manad (egen kr/pinne, trappa, fast lön, semesterersättning). Har
--  kundtjänst (ej admin) inga affärer i perioden: nollrad med fast lön och trappan.
-- =====================================================================
do $$
declare d text := pg_get_functiondef('public.d2d_pinnar_oversikt'::regproc);
        a text := '    ''trappa'', v_mod->''trappa'', ''jag'', auth.uid());';
begin
  if position('''kundtjanst''' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'd2d_pinnar_oversikt: oväntad text'; end if;
  execute replace(d, a,
'    ''trappa'', v_mod->''trappa'', ''jag'', auth.uid(),
    -- Kundtjänst: den inloggades egen kundtjänstrad (egen modell: kr/pinne, trappa, fast lön).
    -- Har kundtjänst inga affärer i perioden visas en nollrad med fast lön och trappan.
    ''kundtjanst'', coalesce(
      (select (s - ''justeringarRader'' - ''lonPotentiell'')
                || jsonb_build_object(''produkter'', (select coalesce(jsonb_agg(p || jsonb_build_object(''etikett'',
                       case when p->>''nyckel'' = ''salt_bredband'' then ''Bredband (alla hastigheter)'' else d2d_tjanst_etikett(v_t, p->>''nyckel'') end)), ''[]''::jsonb)
                     from jsonb_array_elements(coalesce(s->''produkter'', ''[]''::jsonb)) p))
         from jsonb_array_elements(v->''saljare'') s
        where s->>''id'' = auth.uid()::text and s->>''roll'' = ''kundtjanst''),
      (select jsonb_build_object(''id'', auth.uid(), ''roll'', ''kundtjanst'',
                ''namn'', (select coalesce(nullif(full_name, ''''), split_part(email::text, ''@'', 1)) from users where id = auth.uid()),
                ''pinnar'', 0, ''vantar'', 0, ''affarer'', 0, ''affarerVantar'', 0, ''anger'', 0, ''angerPinnar'', 0,
                ''provision'', 0, ''provisionInklVantar'', 0, ''justeringar'', 0, ''produkter'', ''[]''::jsonb,
                ''krPerPinne'', (k.m->>''krPerPinne'')::numeric, ''trappa'', k.m->''trappa'',
                ''fastLon'', coalesce((v_mod->''kundtjanst''->>''fastLon'')::numeric, 0),
                ''lon'', coalesce((v_mod->''kundtjanst''->>''fastLon'')::numeric, 0),
                ''lonInklVantar'', coalesce((v_mod->''kundtjanst''->>''fastLon'')::numeric, 0),
                ''semesterersattning'', 0, ''semesterersattningInklVantar'', 0, ''bonusInklVantar'', 0) || d2d_bonus_niva(0, k.m)
         from (select d2d_lon_kundtjanst_modell(v_mod) m) k
        where d2d_ar_kundtjanst() and not is_admin())));');
end $$;
