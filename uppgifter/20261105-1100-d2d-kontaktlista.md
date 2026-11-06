---
titel: Kontaktlista i Door to door
omrade: D2D
bestallare: Gustav
testlank: https://test.crm.connectestate.se/#/d2dkontakter
---
Ny sida Door to door → Kontaktlista: alla D2D-lägenheter där vi fått in telefon och/eller e-post (ca 4 350) med namn, telefon, e-post, adress, lägenhetsnummer, status och datum då uppgifterna kom in (enligt ändringsloggen; äldre importerade = importdatum). Sök, "Visa fler" (100 åt gången) och CSV-export. Säkerhet: bara personer i d2d_kontakt_behorighet (Gustav, Lukas, Anton) ser menyvalet och får data — allt kontrolleras i databasen; varje visning, sökning och export loggas (d2d_kontakt_logg, visas under "Visa logg"); personnummer ingår inte. Menyvalet krävde en liten ändring i App.tsx och Sidebar.tsx (samma mönster som Löner). Filer: D2DKontaktlista.tsx, d2d.css, App.tsx, Sidebar.tsx. DB: 20261105_1100_d2d_kontaktlista.sql (d2d_kontakt_behorighet, d2d_kontakt_logg, d2d_kontaktlista, d2d_kontaktlista_export, d2d_kontakt_logglista).
