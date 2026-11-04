-- D2D: Telia-rader utan fastighetsbeteckning matchas på adress (gata + nummer + postnummer).

create or replace function public.d2d_telia_adressnyckel(p_gata text, p_nr text, p_pnr text)
 returns text
 language sql
 immutable
as $function$
  select case
    when coalesce(btrim(p_gata), '') = '' or coalesce(btrim(p_nr), '') = ''
      or coalesce(regexp_replace(p_pnr, '\D', '', 'g'), '') = '' then null
    else upper(regexp_replace(btrim(p_gata), '\s+', ' ', 'g')) || '|'
      || upper(regexp_replace(p_nr, '\s', '', 'g')) || '|'
      || regexp_replace(p_pnr, '\D', '', 'g')
  end
$function$;

create or replace function public.d2d_telia_rader(p_fastighet_id uuid)
 returns setof telia_adresser
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare f record; v_bet text; v_kommuner int;
begin
  select r.tenant_id, r.data into f from records r
   where r.id = p_fastighet_id and r.object_type = 'd2d_fastighet' and r.deleted_at is null;
  if not found then return; end if;
  v_bet := upper(btrim(coalesce(f.data->>'fastighetsbeteckning', '')));
  if v_bet = '' then return; end if;

  select count(distinct coalesce(kommun, stad)) into v_kommuner
    from telia_adresser where tenant_id = f.tenant_id and fastighetsbeteckning = v_bet;

  return query
    with egna as (
      select a.* from telia_adresser a
       where a.tenant_id = f.tenant_id and a.fastighetsbeteckning = v_bet
         and (v_kommuner <= 1
              or samma_ort(a.kommun, f.data->>'kommun') or samma_ort(a.stad, f.data->>'ort')
              or samma_ort(a.kommun, f.data->>'ort') or samma_ort(a.stad, f.data->>'kommun')
              or (a.postnummer is not null and a.postnummer = replace(coalesce(f.data->>'postnummer', ''), ' ', '')))
    ),
    -- Fastighetens adresser: Telias rader med rätt beteckning, fastighetens egen adress
    -- ("Gata 12, 222 29 Ort") och adresserna på lägenheter som redan finns.
    nycklar as (
      select d2d_telia_adressnyckel(e.gata, e.gatunummer, e.postnummer) k from egna e
      union
      select d2d_telia_adressnyckel(m[1], m[2], m[3])
        from regexp_match(coalesce(f.data->>'adress', ''),
                          '^\s*(.*?\S)\s+(\d+\s*[A-Za-zÅÄÖåäö]?)\s*,\s*(\d{3}\s?\d{2})') m
      union
      select d2d_telia_adressnyckel(l.data->>'gatunamn', l.data->>'gatunummer',
                                    coalesce(l.data->>'postnummer', f.data->>'postnummer'))
        from relationships rl join records l on l.id = rl.from_record_id and l.deleted_at is null
       where rl.to_record_id = p_fastighet_id and rl.rel_type = 'd2d_lag_fastighet'
    )
    select e.* from egna e
     where coalesce(e.byggnadskategori, 'MDU') in ('MDU', 'SDU')
       and coalesce(e.status, '') <> 'Inactive'
    union all
    select a.* from telia_adresser a
     where a.tenant_id = f.tenant_id
       and coalesce(btrim(a.fastighetsbeteckning), '') = ''
       and coalesce(a.byggnadskategori, 'MDU') in ('MDU', 'SDU')
       and coalesce(a.status, '') <> 'Inactive'
       and d2d_telia_adressnyckel(a.gata, a.gatunummer, a.postnummer)
           in (select k from nycklar where k is not null);
end $function$;
