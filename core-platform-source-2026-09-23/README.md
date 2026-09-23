# Core Platform

Fristående version — Lovable är helt borta ur bilden. Detta är den riktiga
kodbasen: React + Vite + TypeScript mot ett vanligt Supabase-projekt.

## 1. Skapa Supabase-projektet

Antingen via dashboarden (supabase.com/dashboard → New project) eller via
Supabase CLI. Notera project URL och anon key från Project Settings → API.

## 2. Kör migrationerna, i ordning

I SQL Editor i Supabase-dashboarden, eller via `supabase db push` om du kör
CLI:t lokalt mot projektet:

```
supabase/migrations/0001_core_schema.sql
supabase/migrations/0002_security.sql
supabase/migrations/0003_write_path.sql
supabase/migrations/0004_template_loader.sql
```

SQL:en är validerad mot Postgres egen parser men aldrig körd mot en riktig
databas — räkna med att något litet kan behöva justeras vid första körningen
(typiskt en saknad extension som `citext` eller `pg_trgm`; installera med
`create extension if not exists citext;` respektive `pg_trgm` om Postgres
klagar).

De två arkitekturfixarna vi kom fram till är redan inbakade i
`0003_write_path.sql`:
- `add_relation` deduplicerar nu även på `to_record_id` för `one_to_many`,
  inte bara `from_record_id` för `many_to_one`/`one_to_one`. Relevant direkt
  om delivery_property blir en-till-många.
- `create_record`/`update_record` kräver tenant-scope för att sätta
  `owner_user_id` till någon annan än den inloggade användaren.

## 3. Ladda ConnectEstate-mallen

Kör i SQL Editor **med service-nyckeln** (inte som inloggad användare):

```sql
select load_tenant_template('<klistra in innehållet i templates/connectestate.template.json>'::jsonb);
```

Detta skapar tenant, departments, roles, role_permissions, object/field/
relationship-definitioner och AI-agent-rader. Idempotent — kör om vid behov.

## 4. Skapa en inloggning

Skapa en användare i Authentication → Users, sätt sedan `app_metadata` på
den användaren (bara service-nyckeln kan göra detta):

```sql
update auth.users set raw_app_meta_data =
  raw_app_meta_data || jsonb_build_object('tenant_id', '<tenant-id från steg 3>')
where email = 'din@epost.se';
```

Lägg också till en rad i `public.users` med samma id, och koppla den till
minst en roll via `user_roles` (annars är `my_scopes()` tom och användaren
ser ingenting — det är avsiktligt, inte en bugg).

## 5. Konfigurera och kör frontend

```bash
cp .env.example .env
# fyll i VITE_SUPABASE_URL och VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

## Vad som är byggt i den här omgången

- Generisk sidopanel, listvy och detaljvy — drivna helt av `get_metadata()`,
  ingen objekttyp hårdkodad.
- Skapa/redigera via drawer, byggd på fältregistret i `src/lib/fields.tsx`.
- **Tidslinje** i detaljvyn — tidigare bara skriven till databasen, syntes
  inte i UI:t.
- **Relationsväljare** — sök och koppla/koppla loss poster, grupperat per
  relationstyp, i båda riktningarna.
- **Användarnamn i stället för rått UUID** — `src/lib/users.tsx` slår upp
  och cachar `full_name`/`email` för alla user-id som dyker upp (ägare,
  aktörer i tidslinjen, `user`-fält).

## Kända kvarvarande luckor

`activities`-tabellen har fortfarande bara den generiska tenant-läspolicyn
(som `tasks` hade innan den fixades) — en direkt fråga mot tabellen utanför
`get_record_with_relations` skulle inte respektera radnivå-scope. Inget i
nuvarande kod (UI eller AI-chatten) läser tabellen direkt; allt går via
`get_record_with_relations`, som är rättad. Värt att strama åt på samma sätt
som `tasks`/`ai_threads` fick, om något nytt någonsin läser den direkt.

## Vad som fortfarande saknas (från OVERLAMNING.md, olöst)

- `is_column`-flagg för listkolumner — just nu en heuristik (de tre första
  icke-långa fälten).
- Fältvis validering — `validate_record_data` returnerar en samlad
  felsträng, inte fält för fält, så formuläret kan inte markera enskilda
  fält än.
- Outlook-integration.

## Fler användare med rätt roll och avdelning

Bara Gustav (admin, ser allt) finns just nu. Vilka AI-agenter en användare
ser styrs av `ai_agent_access` (avdelning → agent) — en användare måste
vara medlem i en avdelning via `department_members` för att agent-
filtreringen ska ge något annat än tomt.

Matrisen just nu (satt via `visible_to_departments` i mallen):

| Avdelning  | Ser agenter |
|---|---|
| sales      | Sälj-AI |
| support    | Kundtjänst-AI |
| delivery   | Sälj-AI, Leverans-AI, Kundtjänst-AI (allt utom Lednings-AI) |
| management | Alla fyra |

Skapa en ny användare (samma mönster som för Gustav):

```sql
-- 1. Skapa användaren i Authentication -> Users i dashboarden först,
--    notera dess id, kör sedan:
update auth.users set raw_app_meta_data =
  raw_app_meta_data || jsonb_build_object('tenant_id', '<tenant-id>')
where id = '<user-id>';

insert into public.users (id, tenant_id, email, full_name)
values ('<user-id>', '<tenant-id>', '<email>', '<namn>');

insert into public.user_roles (user_id, role_id, tenant_id)
select '<user-id>', id, tenant_id from public.roles
where tenant_id = '<tenant-id>' and key = 'support_agent'; -- eller annan roll

insert into public.department_members (department_id, user_id, tenant_id)
select id, '<user-id>', tenant_id from public.departments
where tenant_id = '<tenant-id>' and key = 'support'; -- avdelningen styr AI-åtkomst
```

Logga sedan ut/in i appen (JWT byggs vid inloggning).
