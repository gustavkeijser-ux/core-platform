-- =============================================================================
-- D2D: Alla lägenheter visar "Väntar på signering" (Gustav 19 okt). Per
-- lägenhet skickas scrive_vantar = status Signera med Scrive och ett
-- Scrive-avtal som väntar på kundens signatur (d2d_avtal.status vantar/skapas).
-- Körd 19 okt 2026.
-- =============================================================================
do $$
declare d text := pg_get_functiondef('public.d2d_alla_lagenheter'::regproc);
  a text := '''kan_andra'', egen))';
begin
  if position('scrive_vantar' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'd2d_alla_lagenheter: oväntad text'; end if;
  execute replace(d, a, '''kan_andra'', egen,
        ''scrive_vantar'', status = ''scrive'' and exists (select 1 from d2d_avtal av where av.lagenhet_id = lag.id and av.status in (''vantar'', ''skapas''))))');
end $$;
