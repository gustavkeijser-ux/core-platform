---
titel: Orderbekräftelse via Scrive på Avtal
omrade: D2D
bestallare: Gustav
testlank: https://test.crm.connectestate.se/#/d2davtal
---
[D2D] Door to door → Avtal: administratörer kan skicka orderbekräftelse via Scrive på sålda lägenheter (fliken Sålda) och signerade Scrive-avtal (ny kolumn Orderbekräftelse). CRM:et bygger en PDF med kunduppgifter, sålda tjänster med kampanj- och ordinariepris, engångskostnader, bindningstid (lägenhetens bindningstid_manader, annars prislistan; för signerade avtal det som stod i avtalet), kampanjperiod och startdatum, och laddar upp den i Scrive. Admin signerar med ett klick (utan BankID, Scrive kräver en signerande part) och Scrive skickar den slutliga PDF:en till kundens e-post (och sms). Status (väntar på signatur / skickad) och PDF visas i listan. Förhandsgranskningen fungerar i testmiljön; själva utskicket kräver Scrive-nycklarna i riktiga CRM:et. Filer: D2DOrderbekraftelse.tsx, D2DAvtalPage.tsx, d2d.css, scrive-sign, scrive-callback, _shared/scrive.ts, _shared/orderbekraftelse.ts. DB: d2d_orderbekraftelse, d2d_orderbekraftelse_lista (20261105_1553). Väntar: deploy av scrive-sign och scrive-callback till riktiga projektet efter publicering.
