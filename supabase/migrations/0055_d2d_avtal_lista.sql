-- =====================================================================
--  0055 — Door to door → Avtal: alla avtal som skickats för signering
--  med Scrive från D2D-vyn, med kund, adress, fastighet, projekt,
--  säljare och vad som såldes. Var och en ser avtalen för de lägenheter
--  de får se (samma regel som d2d_avtal_for).
-- =====================================================================

create or replace function public.d2d_avtal_lista(p_fran date default null, p_till date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with a as (
    select a.*, l.data ld, l.owner_user_id agare, l.id lag_id
      from d2d_avtal a
      join records l on l.id = a.lagenhet_id and l.deleted_at is null
     where a.tenant_id = my_tenant_id()
       and can_row('d2d_lagenhet', 'read', l.owner_user_id)
       and (p_fran is null or coalesce(a.signerad, a.skapad)::date >= p_fran)
       and (p_till is null or coalesce(a.signerad, a.skapad)::date <= p_till)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'status', a.status, 'leverans', a.leverans, 'kundNamn', a.kund_namn,
           'skapad', a.skapad, 'signerad', a.signerad, 'harPdf', a.pdf_path is not null, 'fel', a.fel,
           'scriveId', a.scrive_document_id, 'lagenhetId', a.lag_id,
           'adress', nullif(concat_ws(' ', a.ld->>'gatunamn', a.ld->>'gatunummer', nullif(a.ld->>'ingang', '')), ''),
           'lgh', a.ld->>'name', 'ort', a.ld->>'postort',
           'fastighet', f.data->>'fastighetsbeteckning', 'fastighetId', f.id,
           'projekt', p.title, 'projektId', p.id,
           'saljare', coalesce(
              (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id::text = a.ld->>'saljare'),
              (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = a.skapad_av)),
           'tjanster', coalesce((select jsonb_agg(m->>'label') from jsonb_array_elements(coalesce(a.underlag->'manad', '[]'::jsonb)) m), '[]'::jsonb),
           'manadSumma', (select sum(nullif(m->>'kampanj', '')::numeric) from jsonb_array_elements(coalesce(a.underlag->'manad', '[]'::jsonb)) m),
           'engangSumma', (select sum(nullif(m->>'kampanj', '')::numeric) from jsonb_array_elements(coalesce(a.underlag->'engang', '[]'::jsonb)) m))
         order by coalesce(a.signerad, a.skapad) desc), '[]'::jsonb)
    from a
    left join relationships rf on rf.from_record_id = a.lag_id and rf.rel_type = 'd2d_lag_fastighet'
    left join records f on f.id = rf.to_record_id
    left join relationships rp on rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt'
    left join records p on p.id = rp.to_record_id
$$;
revoke all on function public.d2d_avtal_lista(date, date) from public, anon;
grant execute on function public.d2d_avtal_lista(date, date) to authenticated;
