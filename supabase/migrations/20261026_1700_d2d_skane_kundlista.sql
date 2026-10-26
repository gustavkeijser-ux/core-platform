-- =============================================================================
-- D2D: projektet Skåne kompletterat med Telias "Kundlista fiber – alla
-- fastigheter" (Gustav 26 okt). Engångskörning via execute_sql, 26 okt 2026.
--
-- Listan: 161 rader på 11 fastighetsbeteckningar i Växjö (projektet Skåne
-- innehåller Växjö-fastigheter). 137 bostäder, 24 lokaler/fastighetsstyrning
-- (lgh-nummer 10FS*, 10X*, 09X*) som inte lades in — dörrsäljarna knackar inte
-- på dem.
--
-- Avstämning per fastighet (gata + gatunummer + lgh-nummer, ingång när båda
-- har den): 123 bostäder fanns redan i projektet och rördes inte. 14 nya:
--  * Laken 8 (Bergövägen 28–42, 8 lägenheter med egen ingång, "LGH"). Fastigheten
--    fanns redan (skapad i projektbyggaren samma dag från leveransen, men utan
--    projektkoppling och med leveransens adress "Centrumvägen 27, 561 60 Tenhult").
--    Adressen rättad till "Bergövägen 28, 352 44 Växjö" och fastigheten kopplad
--    till Skåne (d2d_fast_projekt).
--  * Växjö 10:16 (Norra Järnvägsgatan 24 A/B/D, 6 lägenheter) — fastigheten
--    hade 0 lägenheter. Namnet rättat ("Järnvägsgatam" → "Järnvägsgatan").
-- Nya lägenheter: status ej_knackad, ägare = fastighetens ägare, klass MDU,
-- alias = kundens eget lgh-nummer ur listan.
--
-- Arbetstabell d2d_import_skane_adresser (ingen åtkomst för inloggade) har
-- kolumnerna lagenhet_id/fastighet_id/resultat ('ny') för spårbarhet.
-- =============================================================================

create table if not exists public.d2d_import_skane_adresser (
  rad serial, pnr text, ort text, gata text, nr text, ing text, lgh text, alias text, bet text,
  lagenhet_id uuid, fastighet_id uuid, resultat text);
revoke all on public.d2d_import_skane_adresser from public, anon, authenticated;

-- Körningen (raderna lästes in ur Excel-filen med regexp_split_to_table):
--  1. fastighet_id: fastighet i projektet Skåne med samma beteckning (utan "VÄXJÖ ").
--  2. lagenhet_id: befintlig lägenhet på fastigheten med samma gata, nr, lgh (+ ingång).
--  3. Laken 8: update records (name/adress/postnummer) + insert d2d_fast_projekt.
--  4. insert d2d_lagenhet + d2d_lag_fastighet för rader utan lagenhet_id som inte
--     är lokal (lgh !~ '^(10F|10X|09X)'); resultat = 'ny'.
