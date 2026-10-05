-- =====================================================================
--  0059 — Door to door → Avtal → Sålda: alla lägenheter med status
--  "Såld" i D2D, med adress, fastighet, projekt, säljare och det som
--  såldes (salt_*-fälten — priserna räknas i klienten mot prislistan).
--  Datum = senaste kontakt (samma som Utfall), annars senast ändrad.
--  Var och en ser de lägenheter de får se (can_row).
-- =====================================================================

create or replace function public.d2d_salda_lista(p_fran date default null, p_till date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with l as (
    select l.id, l.data ld, coalesce((l.data->>'senast_kontakt')::timestamptz, l.updated_at) datum
      from records l
     where l.tenant_id = my_tenant_id() and l.object_type = 'd2d_lagenhet'
       and l.deleted_at is null and l.status = 'sald'
       and can_row('d2d_lagenhet', 'read', l.owner_user_id)
  ),
  urval as (
    select * from l
     where (p_fran is null or datum::date >= p_fran)
       and (p_till is null or datum::date <= p_till)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'kundNamn', nullif(u.ld->>'kund_namn', ''), 'datum', u.datum,
           'adress', nullif(concat_ws(' ', u.ld->>'gatunamn', u.ld->>'gatunummer', nullif(nullif(u.ld->>'ingang', ''), '-')), ''),
           'lgh', u.ld->>'name', 'ort', u.ld->>'postort',
           'fastighet', coalesce(f.data->>'fastighetsbeteckning', u.ld->>'fastighetsbeteckning'), 'fastighetId', f.id,
           'projekt', p.title, 'projektId', p.id,
           'saljare', (select coalesce(nullif(us.full_name, ''), us.email::text) from users us where us.id::text = u.ld->>'saljare'),
           'data', coalesce((select jsonb_object_agg(k, v) from jsonb_each(u.ld) e(k, v)
                              where k like 'salt\_%'), '{}'::jsonb))
         order by u.datum desc), '[]'::jsonb)
    from urval u
    left join relationships rf on rf.from_record_id = u.id and rf.rel_type = 'd2d_lag_fastighet'
    left join records f on f.id = rf.to_record_id
    left join relationships rp on rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt'
    left join records p on p.id = rp.to_record_id
$$;
revoke all on function public.d2d_salda_lista(date, date) from public, anon;
grant execute on function public.d2d_salda_lista(date, date) to authenticated;
