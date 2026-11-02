---
titel: Utfall-rapporten tog för lång tid (statement timeout i månadsrapporten)
omrade: D2D
bestallare: Gustav
testlank: https://test.crm.connectestate.se/#/d2dutfall
---
Månadsrapporten gav "canceling statement due to statement timeout" (Gustav 2 nov) när den hämtar två månader parallellt. Orsak: `d2d_utfall_rapport` slog upp VT-beställningen med `vb.id::text = data->>'vt_bestallning_id'`, vilket inte kan använda primärnyckelindexet — alla ~49 000 poster lästes en gång per rad (280 rader × 32 ms ≈ 9 s, totalt 10 s per anrop). Nu jämförs som uuid (ogiltig text ger ingen träff) och uppslaget blir ett indexslag: 1,5 s per månad i testgrenen, VT-kolumnen oförändrad (69 rader med VT-status i oktober). Funktionen ändras på plats, ingen kodändring. Prova: Utfall → Excel-rapport → oktober 2026 → Hämta månadsrapport (och den vanliga Hämta Excel). DB: `d2d_utfall_rapport` — `supabase/migrations/20261102_1420_d2d_utfall_rapport_vt_index.sql`, körd i testgrenen.
