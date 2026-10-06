-- =============================================================================
-- 20261006_1440 — Master: handle_new_auth_user tolererar saknad app_metadata
-- =============================================================================
-- Triggern på auth.users krävde app_metadata.tenant_id och app_metadata.role
-- redan vid insert och kastade annars fel → Supabase Auth svarade
-- "Database error creating new user". Auth skriver raden innan app_metadata
-- hinner sättas (Admin API och inbjudan), så kravet stoppade sidan Användare.
--
-- Nu: finns tenant_id skapas profilen (och rollen om role finns), annars görs
-- inget — edge function `admin-users` sätter tenant_id, profil och roller själv.
-- Konton som skapas i dashboarden utan tenant får fortfarande ingen åtkomst
-- (my_tenant_id() är null) och syns inte i CRM:et förrän de kompletteras.
-- =============================================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_tenant uuid;
  v_rollkey text;
  v_roll uuid;
begin
  v_tenant := nullif(new.raw_app_meta_data ->> 'tenant_id', '')::uuid;
  if v_tenant is null or not exists (select 1 from tenants where id = v_tenant) then
    return new;
  end if;

  insert into users (id, tenant_id, email, full_name)
  values (new.id, v_tenant, new.email,
          coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  v_rollkey := nullif(new.raw_app_meta_data ->> 'role', '');
  if v_rollkey is not null then
    select id into v_roll from roles where tenant_id = v_tenant and key = v_rollkey;
    if v_roll is not null then
      insert into user_roles (user_id, role_id, tenant_id)
      values (new.id, v_roll, v_tenant)
      on conflict do nothing;
    end if;
  end if;

  return new;
end $function$;
