# AGENTS.md — så arbetar AI-agenterna i ConnectEstates CRM

Gäller alla agenter: Master, Leverans, Ärenden, Säljprocess och Door to door.
Läs hela filen och de senaste 30 raderna i `ANDRINGSLOGG.md` innan du börjar.

## 1. Fasta regler (från Gustav)

- **Svara alltid på svenska.** Commit-meddelanden är korta och på svenska ("Utfall: antal avtal per kund").
- **Aldrig lösenord eller hemligheter i chatten.** Gustav lägger själv in secrets i Supabase (Edge Functions → Secrets). Be honom göra det, skriv aldrig ut nycklar.
- **Ta aldrig tokens från webbläsarens lagring**, och logga aldrig in åt användaren.
- **Säkerhetsinställningar** (Auth, RLS-policyer i dashboarden, API-nycklar, domäner) ändrar Gustav själv. Du förbereder och förklarar.
- **Allt ska fungera på både webb och mobil.** Kontrollera båda bredderna (1280 och 390 px) innan du pushar UI.
- **Designsystemet "Fas 3"** gäller överallt: använd variablerna i `src/tokens.css` (färger, `--ink-*`, `--r-*`, `--sp-*`). Inga hårdkodade färger.
- Administratörer: Gustav, Lukas och Anton. Fält med `visibility = 'restricted'` syns bara för dem (`get_metadata` filtrerar).

## 2. Vem äger vad

Varje agent ändrar bara i sitt område. Behöver du ändra något som ägs av någon annan, eller något gemensamt: beskriv ändringen och be Gustav ta den i **Master** (eller gör den bara om Gustav uttryckligen ber dig).

| Område | Frontend | Databas / edge functions |
|---|---|---|
| **Leverans** | `TeliaLagenheterTab`, `ChecklistTab`, leveransvyerna i `ObjectListPage`/`RecordDetailPage` (objekttyp `delivery`, `flit_sdu`) | `projektplan-import`, migrationer om projektplan, leveranser, Telia-adresser, FLIT/SDU |
| **Ärenden** | `CasesPage`, `SkapaArende`, `CaseView`, `MailSignature`, `M365StatusPage`, `src/lib/cases.ts` | `list_arenden`, `arende_*`, `case_*`, `mail_*`; `mail-sync`, `mail-send`, `mail-assets` |
| **Säljprocess** | `CreateDealDialog`, `DealFollowUp`, `LyftAffarTab`, `FmoPage`, `FmoTab`, `KanbanBoard` (affärer), `src/lib/fmo.ts` | säljprocess-, affärs- och FMO-funktioner |
| **Door to door** | alla `D2D*`, `MobilNummer`, `NummerbytenPage`, `src/lib/d2dPris.ts` | allt `d2d_*`, Scrive; `scrive-sign`, `scrive-callback`, `scrive-mall`, `d2d-ej-mer-analys` |
| **Master** (gemensamt) | `App.tsx`, `Sidebar.tsx`, `PageChrome`, `ObjectListPage`, `RecordDetailPage`, `RecordDrawer`, `fields.tsx`, `route.ts`, `tokens.css`, `app.css`, `AiAssistant`, `SettingsPage` (Inställningar: profil, utseende, användare, Microsoft 365, D2D-priser, import), `ImportPage`, `FeedbackPage`, inloggning | `get_metadata`, `list_records_filtered`, `create_record`, `update_record`, `validate_record_data`, roller/behörigheter, `ai_agents`, `ai-chat`, `feedback-send` |

**CSS:** `src/app.css` är gemensam (Master). Områdesagenter lägger ny CSS i en egen fil, `src/styles/<omrade>.css` (`leverans`, `arenden`, `salj`, `d2d`), som importeras högst upp i områdets komponent (`import "@/styles/d2d.css";`). Befintlig CSS i `app.css` får ligga kvar; Master flyttar ut den vid tillfälle.

## 3. Arbetsflöde

1. **Kodförrådet:** `https://github.com/gustavkeijser-ux/core-platform` (gren `main`). Klona till t.ex. `~/work/core-platform`, kör `npm ci`. Hämta alltid färskt före en ändring: `git fetch -q && git reset -q --hard origin/main`.
2. **Ändra lokalt**, kontrollera:
   - Frontend: `node_modules/.bin/tsc --noEmit -p tsconfig.json`
   - Edge function: kopiera filen, byt `jsr:` mot `npm:` i importerna, kör `deno check`.
   - UI: skärmdump i Playwright (Chromium finns i `/opt/pw-browsers/chromium`) i 1280 och 390 px.
3. **Pusha** (det finns ingen git-push härifrån — vi går via GitHubs webbeditor i Claude-appens inbyggda webbläsare, där Gustav är inloggad):
   - `python3 verktyg/gh_push.py e <sökväg> "<meddelande>" /tmp/p1.js` (ändrad fil) eller `n` (ny fil).
   - Öppna `https://github.com/gustavkeijser-ux/core-platform/edit/main/<sökväg>` (ändrad) eller `.../new/main/<katalog>` (ny) och kör innehållet i `/tmp/p1.js` med webbläsarens JavaScript-verktyg. Svaret ska vara `ok <längd>`.
   - Felet `len …` betyder att filen ändrats på GitHub sedan du hämtade (en annan agent hann före). Hämta om, gör om ändringen, generera nytt skript. Skriv aldrig över.
   - Verifiera: `git fetch -q && git show origin/main:<sökväg> | cmp -s - <sökväg> && echo OK`.
   - Kontrollera bygget på `https://github.com/gustavkeijser-ux/core-platform/actions` (raderna `.Box-row`, aria-label "completed successfully"). Varje push till `main` byggs och deployas till Loopia automatiskt.
4. **Supabase** (projekt `gpxwfboyjwcaqeinxxwr`, via Supabase-verktygen):
   - **Migrationsfiler döps efter tid**, inte löpnummer: `supabase/migrations/AAAAMMDD_HHMM_<omrade>_<vad>.sql` (t.ex. `20261006_1405_leverans_portar.sql`). Då krockar två agenter aldrig. Filerna `0001–0069` är historik.
   - Kör SQL med `execute_sql`. `apply_migration` och långa skript kan hänga (särskilt `DROP`): använd `create or replace` (även `create or replace trigger`), dela upp i mindre delar, och undvik `DROP`. Hänger en `UPDATE` med långa texter: skicka texten base64-kodad, `convert_from(decode('…','base64'),'UTF8')`.
   - Ändra befintliga funktioner på plats med `pg_get_functiondef` + `replace()` + `execute` i ett `do`-block, och kontrollera först att texten du byter finns (`raise exception` annars) och att ändringen inte redan är gjord.
   - Nya fält i `data` måste finnas i `field_definitions`, annars stoppar `validate_record_data` sparningen.
   - Testa som administratör (rullas tillbaka):
     ```sql
     begin; set local request.jwt.claims = '{"sub":"e6704634-f66c-4725-8a89-13fd3debe2a1","role":"authenticated","app_metadata":{"tenant_id":"cb257a7f-5245-4a00-80d2-6a394c2c2ee1"}}'; set local role authenticated;
     select ...; rollback;
     ```
   - Edge functions: `deploy_edge_function` med hela filens innehåll. `verify_jwt` = true för funktioner som anropas av inloggade användare, false för cron/webhooks (de kontrollerar `x-cron-token` mot vault-hemligheten `mail_sync_cron_token` via `mail_check_cron_token`). Kontrollera nuvarande värde med `list_edge_functions` innan du deployar.
   - AI: secret `ANTHROPIC_API_KEY`, modell `claude-sonnet-4-6`. CRM-assistenten (`ai-chat`) har bara CRM-verktyg, aldrig webbverktyg.
5. **Skriv i `ANDRINGSLOGG.md`** (se nästa avsnitt) och pusha den sist.
6. **Svara Gustav kort:** vad som ändrats, vad det gav (siffror om det finns), och om något väntar på honom.

## 4. Ändringsloggen

`ANDRINGSLOGG.md` är systemets minne. Ingen agent minns andra chattar — det som inte står i loggen har inte hänt.

- Lägg till **en rad per avslutad ändring, överst** under dagens datum (nyast först).
- Format: `- [Område] Vad som ändrats och varför. Filer: … DB: … Väntar: …` (utelämna delar som inte finns).
- Pusha loggen med `gh_push.py e ANDRINGSLOGG.md`. Får du `len …`: hämta om, lägg till din rad igen, försök igen.
- Lägg även till under **Öppna punkter** sådant som väntar på Gustav eller en annan agent, och stryk det som blivit klart.
