-- =====================================================================
--  0056 — D2D: ny status "Signera med Scrive".
--  Som "Såld" (samma "Vad ska kunden signera?"-panel och avtalsförslag),
--  men det är inget bindande avtal och registreras inte som ett sälj:
--  statistiken räknar bara status "sald" som sålt. Scrive-signeringen
--  finns bara i den här statusen.
-- =====================================================================

do $$
declare t record; v_obj uuid;
begin
  for t in select id from tenants loop
    select id into v_obj from object_definitions where tenant_id = t.id and key = 'd2d_lagenhet';
    if v_obj is null then continue; end if;
    if not exists (select 1 from status_definitions where object_id = v_obj and key = 'scrive') then
      insert into status_definitions (object_id, tenant_id, key, label, color, is_initial, is_terminal, sort_order)
      values (v_obj, t.id, 'scrive', 'Signera med Scrive', 'violet', false, false, 65);
    end if;
  end loop;
end $$;
