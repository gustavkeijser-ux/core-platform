-- =============================================================================
-- 0002 — Säkerhet
-- =============================================================================
--
-- Hela behörighetslagret ligger i databasen. Det är den stora skillnaden mot
-- en Node-backend: där kunde klienten bara nå data genom ett servicelager
-- som gjorde kontrollerna. Här pratar klienten direkt med Postgres, så
-- kontrollerna måste sitta i RLS eller inte alls.
--
-- PRESTANDA
--   my_tenant_id(), my_scopes() och my_department_peers() tar inga argument
--   och är STABLE. Postgres kan därför köra dem en gång per statement i
--   stället för en gång per rad. Om du någonsin lägger till en parameter på
--   dem försvinner den optimeringen och listfrågor blir långsamma.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vem är den anropande användaren
-- -----------------------------------------------------------------------------

-- Tenant kommer ur app_metadata i JWT, som bara kan sättas med service-nyckeln.
-- En användare kan inte förfalska den, till skillnad från user_metadata.
create function public.my_tenant_id() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb
        -> 'app_metadata' ->> 'tenant_id',
      ''
    ), ''
  )::uuid
$$;

-- Alla behörigheter för den inloggade användaren, som {"objekt:åtgärd": "scope"}.
-- Bredaste scope vinner när flera roller ger samma kombination.
create function public.my_scopes() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    jsonb_object_agg(k, scope),
    '{}'::jsonb
  )
  from (
    select
      rp.object_type || ':' || rp.action as k,
      (array_agg(rp.scope order by
        case rp.scope when 'tenant' then 3 when 'department' then 2 else 1 end desc
      ))[1] as scope
    from public.role_permissions rp
    join public.user_roles ur on ur.role_id = rp.role_id
    where ur.user_id = auth.uid()
    group by rp.object_type, rp.action
  ) s
$$;

-- Användare som delar avdelning med den inloggade. Driver scope = 'department'.
create function public.my_department_peers() returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct dm2.user_id), '{}'::uuid[])
  from public.department_members dm1
  join public.department_members dm2 on dm2.department_id = dm1.department_id
  where dm1.user_id = auth.uid()
$$;

-- Bredaste scope för en kombination, eller null. '*' matchar allt.
create function public.my_scope(p_object_type text, p_action text) returns text
language sql stable as $$
  select case
    when public.my_scopes() ->> ('*:' || p_action) = 'tenant' then 'tenant'
    else coalesce(
      public.my_scopes() ->> (p_object_type || ':' || p_action),
      public.my_scopes() ->> ('*:' || p_action)
    )
  end
$$;

create function public.can_do(p_object_type text, p_action text) returns boolean
language sql stable as $$
  select public.my_scope(p_object_type, p_action) is not null
$$;

-- Radnivå-regeln. Poster utan ägare är synliga för hela avdelningen; annars
-- blir de osynliga för alla och ingen kan åtgärda det.
create function public.in_scope(p_scope text, p_owner uuid) returns boolean
language sql stable as $$
  select case p_scope
    when 'tenant'     then true
    when 'own'        then p_owner = auth.uid()
    when 'department' then p_owner is null
                        or p_owner = auth.uid()
                        or p_owner = any(public.my_department_peers())
    else false
  end
$$;

create function public.can_row(p_object_type text, p_action text, p_owner uuid)
returns boolean language sql stable as $$
  select public.in_scope(public.my_scope(p_object_type, p_action), p_owner)
$$;

-- -----------------------------------------------------------------------------
-- RLS på tenant-nivå
-- -----------------------------------------------------------------------------
--
-- Varje tabell nedan har tenant_id, även de som logiskt hänger på en
-- förälder. RLS ärvs inte via foreign keys, så en tabell utan egen tenant_id
-- hade varit oskyddad vid en direktfråga från klienten.

do $$
declare t text;
begin
  foreach t in array array[
    'users', 'departments', 'department_members', 'roles', 'role_permissions',
    'user_roles', 'object_definitions', 'field_definitions',
    'relationship_definitions', 'status_definitions', 'records',
    'relationships', 'activities', 'tasks', 'communications',
    'communication_links', 'documents', 'document_links', 'events',
    'ai_agents', 'ai_threads', 'ai_messages', 'ai_proposals', 'audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format($f$
      create policy tenant_read on public.%I for select to authenticated
        using (tenant_id = public.my_tenant_id())
    $f$, t);
  end loop;
end $$;

alter table public.tenants enable row level security;
create policy tenants_read on public.tenants for select to authenticated
  using (id = public.my_tenant_id());

-- -----------------------------------------------------------------------------
-- Radnivå på records
-- -----------------------------------------------------------------------------
--
-- Läsning filtreras på scope. En användare med scope 'own' ser bara sina
-- egna poster, i alla frågor, oavsett vad klienten skickar.

drop policy tenant_read on public.records;

create policy records_read on public.records for select to authenticated
  using (
    tenant_id = public.my_tenant_id()
    and deleted_at is null
    and public.can_row(object_type, 'read', owner_user_id)
  );

-- Relaterade poster får bara synas om användaren får läsa båda ändarna.
drop policy tenant_read on public.relationships;

create policy relationships_read on public.relationships for select to authenticated
  using (
    tenant_id = public.my_tenant_id()
    and exists (select 1 from public.records r where r.id = from_record_id)
    and exists (select 1 from public.records r where r.id = to_record_id)
  );

-- -----------------------------------------------------------------------------
-- INGEN SKRIVNING DIREKT FRÅN KLIENTEN
-- -----------------------------------------------------------------------------
--
-- Detta är den viktigaste delen av hela filen.
--
-- Ingen policy för insert, update eller delete skapas. Med RLS påslaget
-- betyder avsaknad av policy att åtgärden nekas. All skrivning måste därför
-- gå genom funktionerna i 0003, som validerar mot metadata och skriver
-- aktivitet, audit och event i samma transaktion.
--
-- Rättigheterna återkallas dessutom explicit, så att en framtida policy som
-- läggs till av misstag inte öppnar en väg förbi.

revoke insert, update, delete on all tables in schema public from authenticated;
revoke insert, update, delete on all tables in schema public from anon;
revoke all on public.audit_log from authenticated, anon;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
revoke select on public.audit_log from authenticated;

-- anon får ingenting. Inloggning krävs för allt.
revoke all on all tables in schema public from anon;

-- Läsning av audit-loggen går via en funktion i 0003 som kräver
-- metadata-behörighet, inte via direktåtkomst till tabellen.
