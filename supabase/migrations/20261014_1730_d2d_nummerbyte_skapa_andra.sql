-- =============================================================================
-- Nummerbyten: admin kan skapa ett nummerbyte för hand och ändra alla fält
-- (feedback från Lukas 6 och 8 okt, godkänt av Gustav 14 okt).
--
-- d2d_nummerbyte_spara(p_id, p_data)
--   p_id null  → nytt ärende (status oppen). Kopplas INTE till lägenhetens
--                mobil_nummerbyte_id, så synken från lägenheten skriver inte
--                över eller makulerar det. lagenhet_id kan anges för länk.
--   p_id satt  → ändrar ett befintligt ärende (öppet eller i historiken).
--   Tillåtna fält: kund, personnummer, adress, saljare, mobiltjanst, kalla,
--   signeringsdatum, startdatum, nummer (lista {typ, riktigt, agare}),
--   kommentar, lagenhet_id. Datumen för hantering räknas om (nb_refresh).
-- Bara admin. Ändringar loggas som field_change på ärendet.
-- =============================================================================

create or replace function public.d2d_nummerbyte_spara(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := my_tenant_id();
  v_tillatna text[] := array['kund','personnummer','adress','saljare','mobiltjanst','kalla',
                             'signeringsdatum','startdatum','nummer','kommentar','lagenhet_id'];
  v_in jsonb := '{}'::jsonb;
  v_rec records;
  v_id uuid;
  k text;
begin
  if not public.is_admin() then
    raise exception 'Bara admin kan skapa eller ändra nummerbyten' using errcode = '42501';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Uppgifter saknas' using errcode = '22023';
  end if;

  -- Bara kända fält; tomma strängar blir null.
  for k in select jsonb_object_keys(p_data) loop
    if k = any(v_tillatna) then
      v_in := v_in || jsonb_build_object(k,
        case when jsonb_typeof(p_data->k) = 'string' and btrim(p_data->>k) = '' then 'null'::jsonb else p_data->k end);
    end if;
  end loop;

  if v_in ? 'nummer' and jsonb_typeof(v_in->'nummer') not in ('array', 'null') then
    raise exception 'Nummer måste vara en lista' using errcode = '22023';
  end if;
  if v_in ? 'kalla' and v_in->>'kalla' is not null and v_in->>'kalla' not in ('sald', 'scrive') then
    raise exception 'Okänd källa' using errcode = '22023';
  end if;
  foreach k in array array['signeringsdatum', 'startdatum'] loop
    if v_in->>k is not null then
      v_in := v_in || jsonb_build_object(k, to_char((v_in->>k)::date, 'YYYY-MM-DD'));
    end if;
  end loop;

  if p_id is null then
    if coalesce(btrim(v_in->>'kund'), '') = '' then
      raise exception 'Ange kundens namn' using errcode = '22023';
    end if;
    insert into records (tenant_id, object_type, status, owner_user_id, data)
    values (v_tenant, 'nummerbyte', 'oppen', null,
            jsonb_strip_nulls(v_in) || jsonb_build_object(
              'name', 'Nummerbyte – ' || (v_in->>'kund'),
              'signeringsdatum', coalesce(v_in->>'signeringsdatum', to_char(now() at time zone 'Europe/Stockholm', 'YYYY-MM-DD')),
              'nummer', coalesce(v_in->'nummer', '[]'::jsonb)))
    returning id into v_id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind)
    values (v_tenant, v_id, 'record_created', 'Nummerbyte skapat för hand', '{}'::jsonb, auth.uid(), 'user');
  else
    select * into v_rec from records
     where id = p_id and object_type = 'nummerbyte' and tenant_id = v_tenant and deleted_at is null;
    if not found then raise exception 'Ärendet finns inte' using errcode = 'P0002'; end if;
    v_id := p_id;
    update records
       set data = data || v_in
                  || case when v_in ? 'kund' and v_in->>'kund' is not null
                          then jsonb_build_object('name', 'Nummerbyte – ' || (v_in->>'kund')) else '{}'::jsonb end
     where id = p_id;
    for k in select jsonb_object_keys(v_in) loop
      if (v_rec.data->k) is distinct from (v_in->k) then
        perform log_activity(p_id, 'field_change', k || ' ändrades',
          jsonb_build_object('field', k, 'from', v_rec.data->k, 'to', v_in->k));
      end if;
    end loop;
    -- Startdatum följer med till lägenheten, som när det ändras i listan.
    if v_in ? 'startdatum' and coalesce(v_rec.data->>'lagenhet_id', '') <> '' then
      update records set data = data || jsonb_build_object('mobil_startdatum', v_in->'startdatum')
       where id = (v_rec.data->>'lagenhet_id')::uuid;
    end if;
  end if;

  perform public.nb_refresh(v_id);
  return v_id;
end $$;

revoke execute on function public.d2d_nummerbyte_spara(uuid, jsonb) from public, anon;
grant execute on function public.d2d_nummerbyte_spara(uuid, jsonb) to authenticated, service_role;
