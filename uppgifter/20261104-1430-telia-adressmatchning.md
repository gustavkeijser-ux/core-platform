---
titel: Lägenheter från Telia hittas även när Telia saknar fastighetsbeteckning
omrade: D2D
bestallare: Gustav
testlank: https://test.crm.connectestate.se/#/d2d
---
D2D: "Hämta lägenheter från Telia" matchade bara på fastighetsbeteckning, så Telia-rader utan beteckning kom aldrig med (Myntet 21 fick 0 av 21 lgh, Sankt Jakob 4 bara 1 av 7). Nu tas även rader utan beteckning med när gata, gatunummer och postnummer stämmer med fastighetens adress, dess befintliga lägenheter eller Telia-rader med rätt beteckning. Rader som har en annan beteckning rörs inte. Prova: öppna fastigheten i projektbyggaren och klicka Hämta lägenheter från Telia. DB: d2d_telia_adressnyckel (ny), d2d_telia_rader. Väntar: Betlehem 17 och Biet 33 finns inte i Telias lista alls; Biet 3 (Halmstad) saknar leverans i projektplanen (Leverans).
