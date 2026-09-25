-- =============================================================================
-- 0021 — Säljare ser bara säljarvyn
-- =============================================================================
-- Dörrsäljare (rollen "dorrsaljare") ska mötas av D2D-säljarvyn direkt vid
-- inloggning, utan tillgång till resten av CRM:et — enklare för dem, och
-- undviker att de hamnar i vyer/menyer som inte är relevanta för jobbet.
-- Gäller bara den som ENDAST är dörrsäljare; en admin som också råkar ha
-- rollen ska fortfarande se hela CRM:et (is_admin() vinner i klienten).
--
-- Samma mönster som is_admin() (0009): security definer-funktion som
-- kollar user_roles/roles, exponerad via get_metadata() så klienten kan
-- gata appen direkt efter inloggning utan extra rundtripp.
-- =============================================================================

create or replace function public.is_seller()
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.user_roles ur
    join   public.roles r on r.id = ur.role_id
    where  ur.user_id = auth.uid()
      and  r.key = 'dorrsaljare'
  );
$$;

-- Säkerställ att rollen finns för varje tenant som redan kör D2D, så
-- is_seller() inte blir en permanent falsk-false om rollen av någon
-- anledning saknas (den har hittills bara satts upp manuellt).
insert into public.roles (tenant_id, key, name)
select t.id, 'dorrsaljare', 'Dörrsäljare'
from public.tenants t
on conflict (tenant_id, key) do nothing;

create or replace function public.get_metadata()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'objects', coalesce((
      select jsonb_agg(o order by o->>'sortOrder') from (
        select jsonb_build_object(
          'key', od.key,
          'labelSingular', od.label_singular,
          'labelPlural', od.label_plural,
          'icon', od.icon,
          'titleField', od.title_field,
          'sortOrder', od.sort_order,
          'fields', coalesce((
            select jsonb_agg(jsonb_build_object(
              'key', fd.key, 'label', fd.label, 'fieldType', fd.field_type,
              'isRequired', fd.is_required, 'options', fd.options,
              'helpText', fd.help_text, 'sortOrder', fd.sort_order,
              'visibility', fd.visibility
            ) order by fd.sort_order)
            from field_definitions fd where fd.object_id = od.id
          ), '[]'::jsonb),
          'statuses', coalesce((
            select jsonb_agg(jsonb_build_object(
              'key', sd.key, 'label', sd.label, 'color', sd.color,
              'isInitial', sd.is_initial, 'isTerminal', sd.is_terminal
            ) order by sd.sort_order)
            from status_definitions sd where sd.object_id = od.id
          ), '[]'::jsonb),
          'relations', jsonb_build_object(
            'outgoing', coalesce((
              select jsonb_agg(to_jsonb(r)) from (
                select rel_type as "relType", from_object as "fromObject",
                       to_object as "toObject", cardinality,
                       label_forward as "labelForward", label_reverse as "labelReverse",
                       is_required as "isRequired"
                  from relationship_definitions
                 where tenant_id = od.tenant_id and from_object = od.key) r
            ), '[]'::jsonb),
            'incoming', coalesce((
              select jsonb_agg(to_jsonb(r)) from (
                select rel_type as "relType", from_object as "fromObject",
                       to_object as "toObject", cardinality,
                       label_forward as "labelForward", label_reverse as "labelReverse",
                       is_required as "isRequired"
                  from relationship_definitions
                 where tenant_id = od.tenant_id and to_object = od.key) r
            ), '[]'::jsonb)
          ),
          'can', jsonb_build_object(
            'create', can_do(od.key, 'create'),
            'update', can_do(od.key, 'update'),
            'delete', can_do(od.key, 'delete')
          )
        ) as o
        from object_definitions od
        where od.tenant_id = my_tenant_id()
          and od.is_active
          and can_do(od.key, 'read')
      ) s
    ), '[]'::jsonb),
    'tenant', (
      select jsonb_build_object(
        'id', t.id, 'name', t.name,
        'brandColor', t.brand_color, 'logoUrl', t.logo_url
      )
      from tenants t where t.id = my_tenant_id()
    ),
    'isAdmin', public.is_admin(),
    'isSeller', public.is_seller(),
    'mustChangePassword', coalesce((
      select u.must_change_password from public.users u where u.id = auth.uid()
    ), false)
  )
$$;
