-- D2D: Karta — Telias penetration per hus. d2d_karta() tar med leveransens fält pen_*
-- (skrivs av Master-importen av "ConnectEstate penetration ÅÅMMDD.xlsx", värden i procent)
-- som 'pen' per hus, så att kartan kan färga och summera efter penetration.
-- Ändras på plats (pg_get_functiondef + replace).

do $$
declare
  v_def text := pg_get_functiondef('public.d2d_karta()'::regprocedure);
  v_gammal text := $g$'effektiva', round(q.saljbara * (q.kv->>'faktor')::numeric))), '[]'::jsonb))$g$;
  v_ny text := $n$'effektiva', round(q.saljbara * (q.kv->>'faktor')::numeric),
      'pen', (select case when r.data ? 'pen_datum' then jsonb_build_object(
                'hc', r.data->'pen_hc', 'bbTelia', r.data->'pen_bb_telia', 'bbTot', r.data->'pen_bb_tot',
                'tvTelia', r.data->'pen_iptv_telia', 'tvTot', r.data->'pen_iptv_tot', 'datum', r.data->'pen_datum') end
                from records r where r.id = q.lev_id))), '[]'::jsonb))$n$;
begin
  if position($p$'pen', (select$p$ in v_def) > 0 then return; end if;  -- redan gjort
  if position(v_gammal in v_def) = 0 then raise exception 'd2d_karta: hittade inte slutet av husobjektet'; end if;
  execute replace(v_def, v_gammal, v_ny);
end $$;
