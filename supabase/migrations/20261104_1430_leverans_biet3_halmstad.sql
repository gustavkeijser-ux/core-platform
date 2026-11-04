-- Biet 3 (Halmstad, Halmstadbo AB, Backhausgatan 5–11) läggs in som leverans i CRM:et,
-- enligt Gustav 4 nov. Objektet är avslutat hos Telia men finns inte i projektplanens
-- blad (varken Projektplan eller Avslutade), så importen har aldrig skapat det. Utan
-- leverans går fastigheten inte att välja och dela ut i D2D.
--
-- Skapar leveransen "Biet 3 – Halmstad" med status Avslutad (99. Avslutade) och kopplar:
--   • kunden (koncernmoder + direktägt bolag Halmstadbo AB) och fastigheten (property),
--   • Telias lägenheter (telia_adresser, beteckning+ort),
--   • den D2D-fastighet som redan finns för Biet 3 (Backhausgatan 5) och saknar leverans.
-- Projektplan-importen rör inte posten så länge Biet 3 saknas i Excel-filen; dyker den
-- upp där (beteckning Biet 3, ort Halmstad) uppdateras samma post. Idempotent.
do $$
declare
  v_tenant uuid;
  v_lev uuid;
  v_prop uuid;
  v_km uuid;
  v_db uuid;
  v_fast uuid;
begin
  select id into v_tenant from tenants limit 1;

  select id into v_lev from records
   where tenant_id = v_tenant and object_type = 'delivery' and deleted_at is null
     and upper(btrim(coalesce(data->>'fastighetsbeteckning', ''))) = 'BIET 3'
     and upper(btrim(coalesce(data->>'ort', ''))) = 'HALMSTAD'
   limit 1;

  if v_lev is null then
    insert into records (tenant_id, object_type, status, data)
    values (v_tenant, 'delivery', 'avslutad', jsonb_build_object(
      'name', 'Biet 3 – Halmstad',
      'fastighetsbeteckning', 'Biet 3',
      'ort', 'Halmstad',
      'kommun', 'Halmstad',
      'adress', 'Backhausgatan 5-11, 302 96 Halmstad',
      'postnummer', '30296',
      'fastighetsagare', 'Halmstadbo AB',
      'bolagsnamn', 'Halmstadbo AB',
      'orgnr', '5568914401',
      'lagenheter', 44,
      'projektplan_status', '99. Avslutade',
      'notes', 'Avslutat objekt som saknas i projektplanen. Inlagt manuellt 2026-11-04 för att kunna delas ut i D2D.'))
    returning id into v_lev;

    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_tenant, v_lev, 'field_change',
            'Leveransen skapad manuellt (avslutat objekt som saknas i projektplanen, för D2D)',
            jsonb_build_object('kalla', 'manuell_2026-11-04'), null, 'system', now());
  end if;

  -- Fastigheten (Halmstad, inte Biet 3 i Fagersta) och kunden
  select id into v_prop from records
   where tenant_id = v_tenant and object_type = 'property' and deleted_at is null
     and upper(coalesce(data->>'fastighetsbeteckning_komplett', '')) = 'HALMSTAD BIET 3'
   order by created_at limit 1;
  if v_prop is not null then
    select to_record_id into v_km from relationships where from_record_id = v_prop and rel_type = 'property_of' limit 1;
    select to_record_id into v_db from relationships where from_record_id = v_prop and rel_type = 'property_of_db' limit 1;
  end if;

  if v_prop is not null and not exists (select 1 from relationships where from_record_id = v_lev and rel_type = 'delivery_property') then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type) values (v_tenant, v_lev, v_prop, 'delivery_property');
  end if;
  if v_km is not null and not exists (select 1 from relationships where from_record_id = v_lev and rel_type = 'delivery_for') then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type) values (v_tenant, v_lev, v_km, 'delivery_for');
  end if;
  if v_db is not null and not exists (select 1 from relationships where from_record_id = v_lev and rel_type = 'delivery_for_db') then
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type) values (v_tenant, v_lev, v_db, 'delivery_for_db');
  end if;

  -- Telias lägenheter för Biet 3 i Halmstad
  update telia_adresser
     set delivery_id = v_lev, kopplad_via = 'beteckning+ort',
         koncernmoder_id = coalesce(koncernmoder_id, v_km),
         direktagt_bolag_id = coalesce(direktagt_bolag_id, v_db)
   where tenant_id = v_tenant and upper(fastighetsbeteckning) = 'BIET 3'
     and (upper(coalesce(stad, '')) = 'HALMSTAD' or upper(coalesce(kommun, '')) = 'HALMSTAD')
     and delivery_id is distinct from v_lev;

  -- Befintlig D2D-fastighet för Biet 3 (Halmstad) som saknar leverans
  for v_fast in
    select f.id from records f
     where f.tenant_id = v_tenant and f.object_type = 'd2d_fastighet' and f.deleted_at is null
       and upper(btrim(coalesce(f.data->>'fastighetsbeteckning', ''))) = 'BIET 3'
       and upper(coalesce(f.data->>'ort', f.data->>'kommun', '')) = 'HALMSTAD'
       and not exists (select 1 from relationships x where x.from_record_id = f.id and x.rel_type = 'd2d_fast_delivery')
  loop
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type) values (v_tenant, v_fast, v_lev, 'd2d_fast_delivery');
    if v_prop is not null and not exists (select 1 from relationships where from_record_id = v_fast and rel_type = 'd2d_fast_property') then
      insert into relationships (tenant_id, from_record_id, to_record_id, rel_type) values (v_tenant, v_fast, v_prop, 'd2d_fast_property');
    end if;
  end loop;
end $$;
