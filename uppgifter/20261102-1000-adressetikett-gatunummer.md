---
titel: Adressetikett i projektbyggaren tappade gatunummer (Kalleberga 5:41)
omrade: D2D
bestallare: Gustav
testlank: https://test.crm.connectestate.se/#/d2dbuilder
---
I projektbyggaren → Tilldela (manuell fördelning och Dela adresser) saknades gatunummer och ingång på vissa adresser, t.ex. Kalleberga 5:41 där raderna blev "Södra Smålandsgatan 1101" i stället för "Södra Smålandsgatan 1 A · lgh 1101" (Gustav 2 nov). Orsak: radhusgenvägen (lägenhetsnumret är husnumret, t.ex. 60A) slog till så fort lägenhetsnumret började på gatunumret — gatunummer 1 och lgh 1101. Nu bara när lägenhetsnumret är själva husnumret (60, 60A). Adressdatan i databasen var hel hela tiden; bara etiketten påverkades. Prova: öppna projektet med Kalleberga 5:41 → Tilldela → Dela adresser. Filer: `D2DProjectBuilder.tsx` (lagLabel).
