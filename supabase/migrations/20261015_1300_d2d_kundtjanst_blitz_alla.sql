-- =====================================================================
--  D2D: kundtjänstens pinnar syns för alla i Blitz → Översikt (Gustav 2026-10-15)
--  d2d_pinnar_oversikt: listan 'saljare' tar med kundtjänstrader (roll 'kundtjanst',
--  egen trappa och kr/pinne); tjänsterna för en kundtjänstrad räknas på affärer där
--  personen är kundtjänst. Fast lön och semesterersättning tas bort ur listan (bara
--  personen själv ser sin lön, via 'kundtjanst'/'minLon').
-- =====================================================================
do $$
declare d text := pg_get_functiondef('public.d2d_pinnar_oversikt'::regproc);
        a text := 'from jsonb_array_elements(v->''saljare'') with ordinality r(s, o) where coalesce(s->>''roll'', ''saljare'') = ''saljare''),';
        b text := 'and a.saljare = (s->>''id'')::uuid and a.kalla in';
        c text := '''lonPotentiell'' - ''justeringarRader'')
        || jsonb_build_object(';
begin
  if position('a.d->>''kundtjanst'' = s->>''id''' in d) > 0 then return; end if;
  if position(a in d) = 0 or position(b in d) = 0 or position(c in d) = 0 then raise exception 'd2d_pinnar_oversikt: oväntad text'; end if;
  d := replace(d, a, 'from jsonb_array_elements(v->''saljare'') with ordinality r(s, o)),');
  d := replace(d, b, 'and (case when s->>''roll'' = ''kundtjanst'' then a.d->>''kundtjanst'' = s->>''id'' else a.saljare = (s->>''id'')::uuid end) and a.kalla in');
  d := replace(d, c, '''lonPotentiell'' - ''justeringarRader'' - ''fastLon'' - ''semesterersattning'' - ''semesterersattningInklVantar'')
        || jsonb_build_object(');
  execute d;
end $$;
