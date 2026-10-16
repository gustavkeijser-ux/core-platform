-- =============================================================================
-- D2D-sälj → Alla lägenheter: säljarna ser samtliga lägenheter (Gustav 16 okt).
--
-- Förut filtrerade d2d_alla_lagenheter på läsbehörigheten (säljare har "own"
-- på d2d_lagenhet), så en säljare såg bara sina egna (Leo 228, Jacob 1 019 av
-- 11 903). Nu får alla som får läsa lägenheter hela tenantens lista.
-- Körd 16 okt 2026 (texten nedan). Leo ser nu 11 496, Jacob 11 615, admin
-- 11 903 (skillnaden = andras återkopplingar); ~0,7 s.
--
--  * Ny kolumn kan_andra per lägenhet = can_row(update) (admin/kundtjänst
--    alltid). Appen visar andras lägenheter som skrivskyddade — update_record
--    stoppar ändringar ändå.
--  * Personuppgifter: kundens namn och telefon skickas bara för lägenheter
--    man får ändra. Adress, status, säljare, knackningar och kommentar syns
--    för alla.
--  * Återkopplingar som tillhör en annan säljare döljs som förut.
--  * RLS (records_read) är oförändrad: att öppna en annan säljares lägenhet
--    styrs som tidigare av behörigheten.
-- =============================================================================
do $$
declare d text := pg_get_functiondef('public.d2d_alla_lagenheter'::regproc);
  a1 text := '     where t.kan and (t.scope = ''tenant'' or in_scope(t.scope, l.owner_user_id))';
  a2 text := 'select l.id, l.status, l.owner_user_id, l.title, l.updated_at, l.data as d, rl.to_record_id as fid';
  a3 text := 'select r.id, r.status, r.owner_user_id, r.title, r.updated_at, r.fid,';
  a4 text := '''kund_namn'', d->''kund_namn'', ''kund_telefon'', d->''kund_telefon'',';
  a5 text := '''title'', title, ''updated_at'', updated_at, ''data'', data, ''fastighet_id'', fid))';
begin
  if position('kan_andra' in d) > 0 then return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0
     or position(a4 in d) = 0 or position(a5 in d) = 0 then
    raise exception 'd2d_alla_lagenheter: oväntad text';
  end if;
  d := replace(d, a1, '     where t.kan');
  d := replace(d, a2, a2 || ',
           (t.admin or t.kt or can_row(''d2d_lagenhet'', ''update'', l.owner_user_id)) as egen');
  d := replace(d, a3, a3 || ' r.egen,');
  d := replace(d, a4, '''kund_namn'', case when r.egen then d->''kund_namn'' end,
             ''kund_telefon'', case when r.egen then d->''kund_telefon'' end,');
  d := replace(d, a5, '''title'', title, ''updated_at'', updated_at, ''data'', data, ''fastighet_id'', fid,
        ''kan_andra'', egen))');
  execute d;
end $$;
