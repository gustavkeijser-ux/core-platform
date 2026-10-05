-- =====================================================================
--  0062 — Extraanvändare (mobil) syntes inte under Sålda kunder i Utfall.
--  Säljarna lägger ofta till extraanvändaren som en rad under
--  mobilnumren ("+ Lägg till extraanvändare") utan att också trycka på
--  valet "Extra användare". Utfall räknade bara valet.
--   • Utfall (d2d_utfall och d2d_utfall_kalla) räknar nu båda.
--   • Lägenheter som har en extraanvändare bland numren får valet
--     "Extra användare" i salt_mobil, så att avtalsförslag och Scrive
--     också tar med den. (D2D-vyn gör samma sak framöver.)
-- =====================================================================

do $$
declare
  f text; v text;
  gammal constant text := 'd2d_arr(d->''salt_mobil'') ? ''extra_anvandare''';
  ny constant text := '(d2d_arr(d->''salt_mobil'') ? ''extra_anvandare'' or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(d->''mobil_nummer''->''rows'') = ''array'' then d->''mobil_nummer''->''rows'' else ''[]''::jsonb end) x where x->>''typ'' = ''extra''))';
begin
  foreach f in array array['public.d2d_utfall(uuid, uuid, date, date)', 'public.d2d_utfall_kalla(text, uuid, uuid, date, date)'] loop
    v := pg_get_functiondef(f::regprocedure);
    if position(ny in v) > 0 then continue; end if;
    if position(gammal in v) = 0 then raise exception '%: hittar inte räkningen av extraanvändare', f; end if;
    execute replace(v, gammal, ny);
  end loop;
end $$;

update records r
   set data = jsonb_set(r.data, '{salt_mobil}', r.data->'salt_mobil' || '["extra_anvandare"]'::jsonb)
 where r.object_type = 'd2d_lagenhet' and r.deleted_at is null
   and jsonb_typeof(r.data->'salt_mobil') = 'array'
   and not (r.data->'salt_mobil' ? 'extra_anvandare')
   and jsonb_typeof(r.data->'mobil_nummer'->'rows') = 'array'
   and exists (select 1 from jsonb_array_elements(r.data->'mobil_nummer'->'rows') x where x->>'typ' = 'extra');
