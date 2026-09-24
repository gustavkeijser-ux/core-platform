-- =============================================================================
-- 0018 — Tvingat lösenordsbyte vid första inloggning
-- =============================================================================
-- Konton som skapas med ett delat temporärt lösenord (t.ex. onboarding av
-- flera dörrsäljare på en gång) ska tvinga användaren till "Byt lösenord"
-- innan resten av appen visas. E-postverifiering med kod hanteras separat
-- via Supabase Auths inbyggda signup-bekräftelse (auth.users.email_confirmed_at
-- + resend/verifyOtp i klienten) — inget extra schema krävs för den delen.

alter table public.users
  add column if not exists must_change_password boolean not null default false;

comment on column public.users.must_change_password is
  'true tvingar "Byt lösenord"-vyn i appen innan något annat visas. Sätts '
  'true vid skapande av konton med delat/temporärt lösenord, false igen av '
  'complete_password_change() när användaren själv satt ett eget.';

-- Exponera flaggan i get_metadata() så klienten kan gata appen direkt efter
-- inloggning utan extra rundtripp.
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
    'mustChangePassword', coalesce((
      select u.must_change_password from public.users u where u.id = auth.uid()
    ), false)
  )
$$;

-- ── Rensa flaggan när användaren själv satt ett nytt lösenord ──────────────
-- Sätter INTE lösenordet (det gör klienten direkt via
-- supabase.auth.updateUser({password}), som Auth hanterar helt själv) —
-- bara markerar att kravet är uppfyllt. security definer eftersom
-- public.users saknar UPDATE-policy för klienten (se 0002_security.sql).
create or replace function public.complete_password_change()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.users set must_change_password = false where id = auth.uid();
end;
$$;

grant execute on function public.complete_password_change() to authenticated;
