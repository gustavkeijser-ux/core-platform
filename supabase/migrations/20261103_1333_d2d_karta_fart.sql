-- D2D: Karta — snabbare d2d_karta(). Kopplingen D2D-fastighet → hus gjordes med en
-- korrelerad delfråga som anropade d2d_bet_nyckel ~750 000 gånger och slog i
-- statement timeout. Nu räknas nyckeln en gång per fastighet och kopplas med
-- vanliga likhetsjoinar (först via länken till leveransen, annars beteckning + ort).
-- Ändras på plats (pg_get_functiondef + replace).

do $$
declare
  v_def text := pg_get_functiondef('public.d2d_karta()'::regprocedure);
  v_gammal text := $g$  ), fast as (    -- D2D-fastighet → hus: först via länken till leveransen, annars beteckning + ort
    select f.id fast_id, f.created_at,
           coalesce(
             (select h.id from relationships rd join hus h on h.lev_id = rd.to_record_id
               where rd.from_record_id = f.id and rd.rel_type = 'd2d_fast_delivery' limit 1),
             (select h.id from hus h
               where h.bet = d2d_bet_nyckel(f.data->>'fastighetsbeteckning', f.data->>'kommun', f.data->>'ort')
                 and d2d_samma_ort(h.kommun, h.ort, f.data->>'kommun', f.data->>'ort') limit 1)) hus_id
      from records f
     where f.tenant_id = v_t and f.object_type = 'd2d_fastighet' and f.deleted_at is null
  ), senaste as ($g$;
  v_ny text := $n$  ), fk as (
    select f.id fast_id, f.created_at, f.data->>'kommun' kommun, f.data->>'ort' ort,
           d2d_bet_nyckel(f.data->>'fastighetsbeteckning', f.data->>'kommun', f.data->>'ort') bet
      from records f
     where f.tenant_id = v_t and f.object_type = 'd2d_fastighet' and f.deleted_at is null
  ), fast0 as (   -- D2D-fastighet → hus: först via länken till leveransen, annars beteckning + ort
    select fk.fast_id, fk.created_at, h.id hus_id, 1 prio
      from fk join relationships rd on rd.from_record_id = fk.fast_id and rd.rel_type = 'd2d_fast_delivery'
              join hus h on h.lev_id = rd.to_record_id
    union all
    select fk.fast_id, fk.created_at, h.id, 2
      from fk join hus h on h.bet = fk.bet
     where d2d_samma_ort(h.kommun, h.ort, fk.kommun, fk.ort)
  ), fast as (
    select distinct on (fast_id) fast_id, created_at, hus_id from fast0 order by fast_id, prio
  ), senaste as ($n$;
begin
  if position('fast0 as (' in v_def) > 0 then return; end if;  -- redan gjort
  if position(v_gammal in v_def) = 0 then raise exception 'd2d_karta: hittade inte fast-blocket'; end if;
  execute replace(v_def, v_gammal, v_ny);
end $$;
