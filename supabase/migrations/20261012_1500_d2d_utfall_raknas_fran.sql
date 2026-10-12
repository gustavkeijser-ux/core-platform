-- =====================================================================
--  D2D: affärer sålda före lönemodellens startdatum (26/9 2026, "Räknas
--  från" under Inställningar → Priser) räknas bort ur Utfall, precis som
--  de redan är bortränade ur pinnar/lön (d2d_lon_period) och Blitz
--  (d2d_saljstatistik räknar bara sälj med statushistorik).
--
--  Gäller framför allt de 34 adresser som importerades från Excel 30/9
--  med status Såld men utan tidpunkt (Gävle/Tierp, äldre affärer):
--  en såld adress utan känd säljtidpunkt, eller med tidpunkt före
--  startdatumet, tas bort ur Utfall helt (den är varken besök eller sälj
--  där). Signerade Scrive-avtal före startdatumet likaså (finns inga i dag).
-- =====================================================================

/** När blev lägenheten såld? Senaste statusbytet till Såld, annars Senast kontakt. */
create or replace function public.d2d_sald_tid(p_id uuid, p_data jsonb)
returns timestamptz language sql stable as $$
  select coalesce(
    (select a.occurred_at from activities a
      where a.record_id = p_id and a.activity_type = 'status_change' and a.metadata->>'to' = 'sald'
      order by a.occurred_at desc limit 1),
    nullif(p_data->>'senast_kontakt', '')::timestamptz)
$$;

/** Lönemodellens startdatum som tidpunkt (svensk tid); saknas det räknas allt. */
create or replace function public.d2d_raknas_fran(p_tenant uuid)
returns timestamptz language sql stable as $$
  select coalesce(nullif(d2d_lonemodell_for(p_tenant)->>'startdatum', '')::date, '2000-01-01'::date)::timestamp
         at time zone 'Europe/Stockholm'
$$;

-- Filtret läggs in i d2d_utfall_kalla:s "bas" på plats (pg_get_functiondef + replace).
do $$
declare v text; v_gammal text; v_ny text;
begin
  v := pg_get_functiondef('public.d2d_utfall_kalla(text, uuid, uuid, date, date)'::regprocedure);
  if position('d2d_raknas_fran' in v) > 0 then
    raise notice 'd2d_utfall_kalla har redan filtret'; return;
  end if;
  v_gammal := '       and in_scope(v_scope, l.owner_user_id)' || E'\n' || '  ),';
  v_ny := '       and in_scope(v_scope, l.owner_user_id)' || E'\n'
       || '       -- Sålda/signerade före lönemodellens startdatum (eller utan säljtidpunkt) räknas inte' || E'\n'
       || '       and not (l.status = ''sald'' and coalesce(d2d_sald_tid(l.id, l.data), ''1900-01-01''::timestamptz) < d2d_raknas_fran(my_tenant_id()))' || E'\n'
       || '       and not (l.status = ''scrive'' and exists (select 1 from d2d_avtal da where da.lagenhet_id = l.id and da.status = ''signerat'')' || E'\n'
       || '                and (select max(coalesce(da.signerad, da.uppdaterad)) from d2d_avtal da where da.lagenhet_id = l.id and da.status = ''signerat'') < d2d_raknas_fran(my_tenant_id()))' || E'\n'
       || '  ),';
  if position(v_gammal in v) = 0 then
    raise exception 'd2d_utfall_kalla: hittar inte bas-villkoret att ändra';
  end if;
  v := replace(v, v_gammal, v_ny);
  execute v;
end $$;
