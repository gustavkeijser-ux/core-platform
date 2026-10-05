-- =====================================================================
--  0063 — Utfall: "Mobil – extra användare" visar antalet
--  extraanvändare, inte antalet kunder med extraanvändare.
--  Per kund räknas raderna med typ "extra" under mobilnumren; har kunden
--  bara valet "Extra användare" (inga rader) räknas det som en.
-- =====================================================================

do $$
declare
  f text; v text;
  gammal constant text := '''mobil_extra'', (select count(*) from salda where (d2d_arr(d->''salt_mobil'') ? ''extra_anvandare'' or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(d->''mobil_nummer''->''rows'') = ''array'' then d->''mobil_nummer''->''rows'' else ''[]''::jsonb end) x where x->>''typ'' = ''extra'')))';
  ny constant text := '''mobil_extra'', (select coalesce(sum(greatest(
            (select count(*) from jsonb_array_elements(case when jsonb_typeof(d->''mobil_nummer''->''rows'') = ''array'' then d->''mobil_nummer''->''rows'' else ''[]''::jsonb end) x where x->>''typ'' = ''extra''),
            case when d2d_arr(d->''salt_mobil'') ? ''extra_anvandare'' then 1 else 0 end)), 0) from salda)';
begin
  foreach f in array array['public.d2d_utfall(uuid, uuid, date, date)', 'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'] loop
    v := pg_get_functiondef(f::regprocedure);
    if position(ny in v) > 0 then continue; end if;
    if position(gammal in v) = 0 then raise exception '%: hittar inte räkningen av extraanvändare', f; end if;
    execute replace(v, gammal, ny);
  end loop;
end $$;
