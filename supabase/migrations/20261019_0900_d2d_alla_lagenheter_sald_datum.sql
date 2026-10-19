-- =============================================================================
-- D2D: kolumnen "Såld" i lägenhetslistorna (Gustav 19 okt). Alla lägenheter
-- hämtar nu även sald_datum. Körd 19 okt 2026.
-- =============================================================================
do $$
declare d text := pg_get_functiondef('public.d2d_alla_lagenheter'::regproc);
  a text := '''tillfallig'', d->''tillfallig'', ''kundtjanst'', d->''kundtjanst'')';
begin
  if position('sald_datum' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'd2d_alla_lagenheter: oväntad text'; end if;
  execute replace(d, a, '''tillfallig'', d->''tillfallig'', ''kundtjanst'', d->''kundtjanst'', ''sald_datum'', d->''sald_datum'')');
end $$;
