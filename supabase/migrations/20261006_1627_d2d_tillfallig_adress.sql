-- =====================================================================
--  D2D — Tillfällig lägenhet med egen adress
--  Adressen kan skilja sig inom samma fastighet, så säljaren anger även
--  gatunamn, gatunummer och ingång (förifyllda från fastigheten i UI:t).
--  Ny funktion d2d_skapa_tillfallig_adress(fastighet, lgh, alias,
--  gatunamn, gatunummer, ingang). Dubblettkontrollen gäller nu
--  lgh-nummer + adress + ingång, inte bara lgh-nummer.
--  De äldre d2d_skapa_tillfallig_lagenhet(…) finns kvar som tunna ombud
--  (DROP hänger via verktyget) — använd d2d_skapa_tillfallig_adress.
-- =====================================================================

create or replace function public.d2d_skapa_tillfallig_adress(
  p_fastighet_id uuid, p_lgh_nummer text, p_alias text, p_gatunamn text, p_gatunummer text, p_ingang text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_tenant uuid := my_tenant_id();
  v_id uuid := gen_random_uuid();
  v_f records%rowtype;
  v_nr text := nullif(btrim(coalesce(p_lgh_nummer, '')), '');
  v_alias text := nullif(btrim(coalesce(p_alias, '')), '');
  v_ingang text := nullif(btrim(coalesce(p_ingang, '')), '');
  v_adress text;
  v_gatunamn text := nullif(btrim(coalesce(p_gatunamn, '')), '');
  v_gatunr text := nullif(btrim(coalesce(p_gatunummer, '')), '');
  v_m text[];
begin
  if v_tenant is null then raise exception 'Ingen tenant i token' using errcode = '42501'; end if;
  if not (can_do('d2d_fastighet', 'read') and can_do('d2d_lagenhet', 'update')) then
    raise exception 'Saknar behörighet att skapa tillfälliga lägenheter' using errcode = '42501';
  end if;
  if v_nr is null then raise exception 'Lägenhetsnummer saknas' using errcode = '22023'; end if;

  select * into v_f from records
   where id = p_fastighet_id and tenant_id = v_tenant and object_type = 'd2d_fastighet' and deleted_at is null;
  if not found then raise exception 'Fastigheten finns inte' using errcode = 'P0002'; end if;

  -- Saknas gatunamn tas fastighetens adress ("Storgatan 12B" → "Storgatan", "12B").
  if v_gatunamn is null then
    v_adress := nullif(btrim(coalesce(v_f.data->>'adress', v_f.title, '')), '');
    v_m := regexp_match(coalesce(v_adress, ''), '^(.*\S)\s+(\d+\s?[A-Za-z]?)$');
    if v_m is not null then v_gatunamn := v_m[1]; v_gatunr := coalesce(v_gatunr, v_m[2]); else v_gatunamn := v_adress; end if;
  end if;

  if exists (
    select 1 from records l
    join relationships r on r.from_record_id = l.id and r.rel_type = 'd2d_lag_fastighet' and r.to_record_id = p_fastighet_id
    where l.object_type = 'd2d_lagenhet' and l.deleted_at is null and lower(l.title) = lower(v_nr)
      and lower(coalesce(l.data->>'gatunamn', '')) = lower(coalesce(v_gatunamn, ''))
      and lower(coalesce(l.data->>'gatunummer', '')) = lower(coalesce(v_gatunr, ''))
      and lower(coalesce(l.data->>'ingang', '')) = lower(coalesce(v_ingang, ''))) then
    raise exception 'Lägenhet % finns redan på den adressen', v_nr using errcode = '23505';
  end if;

  insert into records (id, tenant_id, object_type, status, owner_user_id, created_by, data)
  values (v_id, v_tenant, 'd2d_lagenhet', 'ej_knackad', auth.uid(), auth.uid(),
          jsonb_strip_nulls(jsonb_build_object(
            'name', v_nr, 'alias', v_alias,
            'gatunamn', v_gatunamn, 'gatunummer', v_gatunr, 'ingang', v_ingang,
            'postort', nullif(v_f.data->>'ort', ''),
            'postnummer', nullif(v_f.data->>'postnummer', ''),
            'fastighetsbeteckning', nullif(v_f.data->>'fastighetsbeteckning', ''),
            'portkod_adress', nullif(v_f.data->>'portkod', ''),
            'saljare', auth.uid()::text,
            'tillfallig', true, 'tillfallig_skapad_av', auth.uid()::text)));

  insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
  values (v_tenant, v_id, p_fastighet_id, 'd2d_lag_fastighet')
  on conflict do nothing;

  perform log_activity(v_id, 'record_created', 'Tillfällig lägenhet skapad av säljare', '{}'::jsonb);
  perform emit_event('d2d.tillfallig_skapad', v_id, jsonb_build_object('objectType', 'd2d_lagenhet', 'fastighetId', p_fastighet_id));
  return v_id;
end $$;
grant execute on function public.d2d_skapa_tillfallig_adress(uuid, text, text, text, text, text) to authenticated;

-- Äldre varianter blir ombud (två signaturer finns i databasen).
create or replace function public.d2d_skapa_tillfallig_lagenhet(p_fastighet_id uuid, p_lgh_nummer text, p_alias text default null)
returns uuid language sql security definer set search_path to 'public' as $$
  select public.d2d_skapa_tillfallig_adress(p_fastighet_id, p_lgh_nummer, p_alias, null, null, null);
$$;
create or replace function public.d2d_skapa_tillfallig_lagenhet(
  p_fastighet_id uuid, p_lgh_nummer text, p_alias text default null,
  p_gatunamn text default null, p_gatunummer text default null, p_ingang text default null)
returns uuid language sql security definer set search_path to 'public' as $$
  select public.d2d_skapa_tillfallig_adress(p_fastighet_id, p_lgh_nummer, p_alias, p_gatunamn, p_gatunummer, p_ingang);
$$;
