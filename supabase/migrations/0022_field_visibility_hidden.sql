-- =============================================================================
-- 0022 — Tillåt visibility = 'hidden' på fält
-- =============================================================================
-- Fältkonfiguratorn (FieldConfigPanel) och alla listor/formulär i klienten
-- använder visibility = 'hidden' för att dölja ett fält, men CHECK-
-- constrainten tillät bara 'all' | 'department' | 'restricted'. Resultatet
-- var att "Dölj fält" aldrig fungerade — uppdateringen avvisades tyst.
-- =============================================================================

alter table public.field_definitions
  drop constraint if exists field_definitions_visibility;

alter table public.field_definitions
  add constraint field_definitions_visibility
  check (visibility in ('all', 'department', 'restricted', 'hidden'));
