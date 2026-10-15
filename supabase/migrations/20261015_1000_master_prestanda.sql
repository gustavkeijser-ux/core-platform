-- =============================================================================
-- Prestanda (15 okt 2026): sidorna laddade långsamt.
--
-- Mätt före → efter (samma anrop i databasen):
--   Säljare läser sina lägenheter genom RLS     16 400 ms → 570 ms
--   d2d_saljstatistik (topplistan)                3 400 ms → 590 ms
--   d2d_alla_lagenheter (admin, ~10 000 lgh)      ~8 000 ms → 2 300 ms
--   get_dashboard_summary (admin)                   200 ms → 110 ms
--
-- 1. my_scopes() cachas per transaktion. RLS på records anropar
--    d2d_kan_lasa → can_row/my_scope → my_scopes för VARJE rad, och my_scope
--    anropar my_scopes upp till tre gånger. Varje anrop läste role_permissions
--    (≈420 rader) + user_roles: 1,4 miljoner seq scans / 686 miljoner lästa
--    rader sedan senaste omstart. Nu räknas svaret ut en gång per anrop
--    (transaktion) och läggs i ce.my_scopes med användar-id som nyckel.
-- 2. Index activities(record_id, occurred_at): många funktioner slår upp
--    aktiviteter per post utan tenant_id (t.ex. säljtidpunkten per lägenhet),
--    och det befintliga indexet börjar med tenant_id.
-- 3. ANALYZE: tabellerna hade aldrig analyserats efter flytten/omstarten
--    (reltuples -1 / last_analyze null), så planeraren gissade.
-- =============================================================================

create or replace function public.my_scopes()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
-- Användarens behörigheter (objekt:åtgärd → scope). Anropas per rad i RLS
-- (via my_scope/can_row/d2d_kan_lasa), så svaret cachas i transaktionen
-- (ce.my_scopes, nyckel = användar-id) i stället för att läsa
-- role_permissions/user_roles för varje rad. Ett API-anrop = en transaktion.
declare
  v_uid text := coalesce(auth.uid()::text, '');
  v_c text := current_setting('ce.my_scopes', true);
  v_res jsonb;
begin
  if v_c is not null and v_c <> '' and split_part(v_c, '|', 1) = v_uid then
    return substr(v_c, length(v_uid) + 2)::jsonb;
  end if;
  select coalesce(jsonb_object_agg(k, scope), '{}'::jsonb) into v_res
  from (
    select rp.object_type || ':' || rp.action as k,
           (array_agg(rp.scope order by
              case rp.scope when 'tenant' then 3 when 'department' then 2 else 1 end desc))[1] as scope
      from public.role_permissions rp
      join public.user_roles ur on ur.role_id = rp.role_id
     where ur.user_id = auth.uid()
     group by rp.object_type, rp.action
  ) s;
  perform set_config('ce.my_scopes', v_uid || '|' || v_res::text, true);
  return v_res;
end $$;
revoke execute on function public.my_scopes() from public, anon;
grant execute on function public.my_scopes() to authenticated, service_role;

create index if not exists activities_record_id_occurred_at_idx
  on public.activities (record_id, occurred_at);

analyze public.records; analyze public.activities; analyze public.relationships;
analyze public.role_permissions; analyze public.user_roles; analyze public.roles; analyze public.users;
