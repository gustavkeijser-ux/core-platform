-- =============================================================================
-- Säljarna såg inga lägenheter inne i projekten (14 okt 2026).
--
-- Orsak: dörrsäljarrollen läser d2d_fastighet med scope 'tilldelad'.
-- Tabellens RLS (records_read) förstår det via d2d_kan_lasa(), men
-- get_record_with_relations kontrollerade med can_row(), som bara känner
-- till tenant/own/department. För 'tilldelad' gav can_row false, så
-- funktionen returnerade null för fastigheten — D2D-sälj visade inga
-- lägenheter (getRecord → "Fastigheten hittades inte"/tom lista).
--
-- Rättning: get_record_with_relations använder samma kontroll som RLS,
-- d2d_kan_lasa(id, typ, ägare) (= can_row eller tilldelad), för både posten
-- och de relaterade posterna. För andra objekttyper är resultatet oförändrat.
-- Verifierat: alla 6 dörrsäljare läser alla sina fastigheter (0 ej läsbara).
-- =============================================================================
do $$
declare v_src text; v_ny text;
begin
  select pg_get_functiondef('public.get_record_with_relations'::regproc) into v_src;
  if position('d2d_kan_lasa' in v_src) > 0 then return; end if;
  v_ny := replace(v_src, 'and can_row(o.object_type, ''read'', o.owner_user_id)', 'and d2d_kan_lasa(o.id, o.object_type, o.owner_user_id)');
  v_ny := replace(v_ny, 'and can_row(r.object_type, ''read'', r.owner_user_id)', 'and d2d_kan_lasa(r.id, r.object_type, r.owner_user_id)');
  if position('can_row(' in v_ny) > 0 then raise exception 'get_record_with_relations: oväntad text'; end if;
  execute v_ny;
end $$;
