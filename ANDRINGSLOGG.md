# Ändringslogg — ConnectEstates CRM

Systemets minne för alla agenter. Nyast först. En rad per avslutad ändring:
`- [Område] Vad och varför. Filer: … DB: … Väntar: …` — se `AGENTS.md`, avsnitt 4.
Områden: Master, Leverans, Ärenden, Säljprocess, D2D.

## Öppna punkter

- [D2D] Gustav: ta bort secret `SCRIVE_TEMPLATE_ID` i Supabase (mall-id ligger nu i databasen, migration 0057).
- [D2D] Gustav: lägg till kryssrutorna "TV Start" och "TV Mini" i Scrive-mallen.
- [D2D] Gustav: rotera Scrive-nycklarna (de har synts i en chatt).
- [D2D] Parkerat: kommentarerna i projektet "umeå 2".
- [Master] Flytta ut områdes-CSS ur `src/app.css` till `src/styles/<omrade>.css`.
- [Master] Övervägs: billigare modell (Haiku) för `ai-chat` om kostnaden blir hög — se `usage` i `ai_messages`.

## 2026-10-06

- [Master] Arbetssätt för flera agenter: `AGENTS.md` (regler, ägarskap, push och Supabase), denna logg och `verktyg/gh_push.py` (push via GitHubs webbeditor). Nya migrationer döps `AAAAMMDD_HHMM_<omrade>_<vad>.sql`. Instruktionstexter för projekten i `agenter/PROJEKTINSTRUKTIONER.md`.

## 2026-10-05

- [D2D] Utfall: "Antal avtal per kund" (1, 2, 3, 4, 5, 6+). Ett avtal = en tjänst: bredband, TV utöver Start/Bas, varje mobilabonnemang och extraanvändare, streaming film, sport, trygghet. Filer: `D2DUtfallPage.tsx`, `app.css` (`.utf__h3-mellan`). DB: `d2d_antal_avtal(d)`, `d2d_utfall_kalla` → `sald.antalAvtal` (0069).
- [Master] AI: verktyget `summarize_records` (summa/medel/min/max och `groupBy` över alla träffar, räknas i edge function). Tidigare kunde AI:n inte summera portar (svaret kapades). Filer: `supabase/functions/ai-chat/index.ts`. DB: `ai_agents.allowed_tools` och systemprompten (0068).
- [D2D] Utfall: TV Start (`tv_start`) och TV Bas (`tv_basic`) räknas inte som TV-försäljning; bara Mini (`tv_bas` — obs nyckeln!), Mellan, Mycket. Kund med bara Start/Bas = "enbart bredband" och analyseras av AI. Filer: `D2DUtfallPage.tsx` (etikett "TV (utöver Start/Bas)"). DB: `d2d_tv_raknas(d)`, `d2d_mer_an_bredband`, `d2d_utfall`, `d2d_utfall_kalla` (0067).
- [Master] AI-assistenten (`ai-chat`): bara CRM-verktyg, inga webbverktyg; prompt caching på systemprompt + verktyg; senaste 12 meddelandena; högst 6 verktygsrundor, `max_tokens` 1200; verktygssvar komprimeras (`kompakt()`); tokenförbrukning sparas per svar (`usage`). Ny kort systemprompt för `crm_ai` (0066).
- [D2D] Utfall "Varför bara bredband": AI läser säljarens kommentar på lägenheter som köpt/signerat enbart bredband och sparar skäl + sammanfattning i `data.ej_mer_ai`. Körs direkt vid Såld/Scrive/signerat (trigger → pg_net) och var 5:e minut (cron `d2d-ej-mer-analys`). Säljarens egna skäl går före. Edge: `d2d-ej-mer-analys` (verify_jwt false, x-cron-token). DB: `d2d_ej_mer_*`, `trg_d2d_ej_mer`, `trg_d2d_avtal_ej_mer` (0065).
- [D2D] Status "Övrigt" ersatt av "Kall kund" (54 lägenheter flyttade), ny status "Befintlig Telia-kund", `antal_knackningar` (stegräknare vid Inte hemma, +1 automatiskt), `tid_pa_adress` (minuter, `restricted` = bara admin, kolumn i Lägenheter). DB: `get_metadata` filtrerar `restricted` (0064).
- [Master] Listor: långa texter visas på upp till 3 rader (5 på mobil), hela texten vid hovring (`LangText` i `ObjectListPage.tsx`).
- [D2D] Extraanvändare räknas i Utfall (från chippet `extra_anvandare` eller raderna i `mobil_nummer` med `typ='extra'`), visas som antal; `MobilNummer` sätter chippet automatiskt (0062, 0063).
- [D2D] Utfall med flikarna Sålda, Scrive och Totalt: `d2d_utfall_kalla(p_kalla, …)` (0061). Avtal-sidan: flikarna Sålda och Totalt (0059).
- [Master] Designsystem Fas 3 i hela CRM:et (`tokens.css`, `app.css`), ny meny: Översikt, Mina uppgifter; MODULER (Ärenden som rullgardin med räknare, Säljprocess, Leveransprocess, Door to door); REGISTER; ADMINISTRATION. D2D: CRM-knappen till vänster.
- [Ärenden] Fas 3: ny ärendelista (`list_arenden` med filter och räknare), Skapa ärende i fyra steg (`arende_skapa`; `case_create` delegerar), ärendevy med statussteg, deadline och chattbubblor, liknande ärenden (`case_liknande`). Nya fält `kund_namn`, `beskrivning`, `planerad_atgard` (0060).

## 2026-10-03

- [D2D] Avtal-sidan (alla Scrive-avtal), status "Signera med Scrive", Scrive-integrationen (`scrive-sign`, `scrive-callback`, `scrive-mall`; mall-id i databasen), kunduppgifter och startdatum före signering, TV Start och TV Bas (0 kr, TV-box ingår), prislistan som egen sida (0055–0058).
- [Leverans] Fliken Lägenheter: Telias lägenheter kopplade till leverans, kund och bolag (0053, 0054).

## 2026-10-02

- [Säljprocess] Affärer, FMO-check (Telia svarar per fastighet, egen vy och inlogg), hyresförhandling, koncernmödrar delas ut till säljare, Excel-export (0046).
- [Leverans] Projektplanen importeras automatiskt varje timme (`projektplan-import`), bladen Avslutade och FLIT-SDU, snabbare koppling av leveranser till kund (0047, 0051, 0052).
- [D2D] Utfallssidan och bindningstider; projektbyggaren väljer fastigheter i leveranslistan; Telias adresslista som underlag (0048–0050).

## 2026-10-01

- [Master] Ny design och struktur (tokens, sidomeny, toppfält, global sök Ctrl/⌘K, post som egen sida, sidhuvuden och statuspiller).
- [Ärenden] Gemensam e-postsignatur (text och HTML, `mail-assets`), lugnare trådvy (0037, 0038).
- [Master] En AI-assistent för hela systemet som panel (`ai-chat`, 0039). Feedback-knapp på alla sidor → Teams (`feedback-send`) och lista med status (0040, 0041).
- [D2D] Säljare följer med, projektöversikt.

## 2026-09-30

- [D2D] Nummerbyten/porteringar (mobilnummerpanel i D2D och adminvy, 0029); välj projekt före fastigheter (0034); manuell tilldelning per adress (0035); översikt med topplista (0036).
- [Ärenden] Ärendemodell, e-post via Microsoft 365 (`mail-sync`, `mail-send`, cron), inkorg och ärendevy, Microsoft 365-status (0030–0033).
- [Master] CSV-export av filtrerade listor.

## 2026-09-28

- [Master] Listor som kort på mobil; "tillbaka till samma rad" och sparat listläge i hela systemet; menyn Säljprocess, Leveransprocess, Door to door.
- [Säljprocess] Affärer: ägarskap och uppföljningspanel (logga, nästa steg), snabbfilter, fördela säljare (0028). Uppstartsmöten, Onboarding, Appleverans (0024).
- [D2D] Sålda tjänster per kategori med Ja/Nej (0025–0027).

## 2026-09-23 – 2026-09-26

- [Master] Kodbasen flyttad från Lovable till GitHub + Loopia (deploy via GitHub Actions). Tvingat lösenordsbyte vid första inloggning (0018). Fältkonfigurator, dolda fält (0022). Hash-routing (sidan behålls vid omladdning). Datum sparas i UTC (0023). Användarnamn i stället för id.
- [D2D] Projektbyggare med karta (geokodning), ta bort projekt, säljarvyn (bara säljarvyn för dörrsäljare, 0021), anledning vid Inte intresserad (0020), autospara, adresslistan i boendeapp-stil, Lägenheter med säljare och kommentar (0015–0017, 0019).
