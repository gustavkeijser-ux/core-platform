-- =============================================================================
-- 0008 — D2D ↔ CRM-relationer
-- =============================================================================
--
-- Kopplar Door 2 Door-modulen till befintliga CRM-objekt:
--
--   d2d_fastighet → förvaltningsbolag  (valfri — vilken förvaltare hanterar)
--   d2d_fastighet → direktagt_bolag    (valfri — vilken ägare)
--   d2d_projekt   → delivery           (valfri — koppling till leveransprojekt)
--
-- d2d_fastighet → koncernmoder finns redan i 0007.
-- =============================================================================

begin;

do $$
declare
  v_tenant uuid;
begin
  select id into v_tenant from public.tenants limit 1;
  if v_tenant is null then
    raise exception 'Ingen tenant hittades.';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. D2D-fastighet → Förvaltningsbolag
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_fast_forvaltning', 'd2d_fastighet', 'forvaltningsbolag',
     'many_to_one', 'Förvaltningsbolag', 'D2D-fastigheter', false)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. D2D-fastighet → Direktägt bolag
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_fast_direktagt', 'd2d_fastighet', 'direktagt_bolag',
     'many_to_one', 'Direktägt bolag', 'D2D-fastigheter', false)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. D2D-projekt → Leverans (delivery)
  -- ═══════════════════════════════════════════════════════════════════════════

  insert into public.relationship_definitions
    (tenant_id, rel_type, from_object, to_object, cardinality, label_forward, label_reverse, is_required)
  values
    (v_tenant, 'd2d_proj_delivery', 'd2d_projekt', 'delivery',
     'many_to_one', 'Leveransprojekt', 'D2D-projekt', false)
  on conflict (tenant_id, rel_type) do update set
    from_object = excluded.from_object, to_object = excluded.to_object,
    label_forward = excluded.label_forward, label_reverse = excluded.label_reverse;

end
$$;

commit;
