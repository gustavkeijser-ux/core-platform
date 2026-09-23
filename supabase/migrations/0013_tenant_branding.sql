-- =============================================================================
-- 0013 — Varumärkesanpassning av sidomenyn (färg + logotyp)
-- =============================================================================
-- Låter en admin sätta en varumärkesfärg och en logotyp per tenant, som
-- ersätter standardfärgen respektive ConnectEstate-texten i sidomenyn.
-- Samma mönster som admin_create_field/is_admin (0009) och documents-bucketen
-- (0010/0012-familjen): admin-skyddad RPC, tenant-scopad storage-mapp.
-- =============================================================================

alter table public.tenants
  add column if not exists brand_color text,
  add column if not exists logo_url    text;

alter table public.tenants
  add constraint tenants_brand_color_format
  check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$');

-- ── get_metadata: lägg till tenant-branding vid sidan av objektlistan ───────
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
    -- app_metadata.role visade sig opålitligt (saknas i JWT:et även för
    -- admin-användare — se UserSettings.tsx). Exponera den faktiska
    -- is_admin()-kollen istället, så frontend kan gata admin-bara UI
    -- (Utseende-sektionen) på sanning.
    'isAdmin', public.is_admin()
  )
$$;

-- ── Uppdatera varumärkesfärg/logotyp (admin) ────────────────────────────────
create or replace function public.update_tenant_branding(
  p_brand_color text default null,
  p_logo_url    text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_row    record;
begin
  if not public.is_admin() then
    raise exception 'Åtkomst nekad — admin krävs.';
  end if;

  if p_brand_color is not null and p_brand_color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'Ogiltig färgkod — ange hex, t.ex. #1a73e8.';
  end if;

  select tenant_id into v_tenant from public.users where id = auth.uid();

  update public.tenants
     set brand_color = p_brand_color,
         logo_url    = p_logo_url
   where id = v_tenant
  returning id, name, brand_color, logo_url into v_row;

  return jsonb_build_object(
    'id', v_row.id, 'name', v_row.name,
    'brandColor', v_row.brand_color, 'logoUrl', v_row.logo_url
  );
end;
$$;

revoke all on function public.update_tenant_branding(text, text) from public;
grant execute on function public.update_tenant_branding(text, text) to authenticated;

-- ── Storage: publik bucket för logotyper, admin-skyddad uppladdning ─────────
-- Publik (till skillnad från "documents") eftersom logotypen ska kunna
-- renderas direkt i <img src> i sidomenyn på varje sida, utan en signerad
-- länk per request. Sökväg <tenant>/... matchar samma RLS-mönster som
-- documents-bucketen för skrivskydd.
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

create policy "admin_upload_branding" on storage.objects
  for insert with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (my_tenant_id())::text
    and public.is_admin()
  );

create policy "admin_update_branding" on storage.objects
  for update using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (my_tenant_id())::text
    and public.is_admin()
  );

create policy "admin_delete_branding" on storage.objects
  for delete using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (my_tenant_id())::text
    and public.is_admin()
  );
