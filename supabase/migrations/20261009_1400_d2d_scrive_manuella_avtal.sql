-- D2D: avtal som säljarna skapat manuellt i Scrive (utanför CRM:et) kan
-- hämtas och kopplas till en lägenhet (scrive-sign, åtgärderna "okopplade"
-- och "koppla"). Sådana avtal får leverans = 'manuell'.
-- Kört 2026-10-09 via execute_sql.

alter table public.d2d_avtal
  drop constraint d2d_avtal_leverans_check,
  add constraint d2d_avtal_leverans_check
    check (leverans = any (array['plats'::text, 'skickat'::text, 'manuell'::text]));
