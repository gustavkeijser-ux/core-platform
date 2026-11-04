-- [Leverans] Avisera i Leveransöversikten (Gustav 4 nov).
-- * Leveransöversikt-posten (en per koncernmoder) får fält för aviseringsprofilen:
--   avi_logo (sökväg i storage-bucketen "documents", <tenant>/<post>/avi-logo-…),
--   avi_farg (profilfärg, #rrggbb) och avi_slug (projekthemsida connectestate.se/<slug>).
-- * leverans_fastighetslista skickar även med antal lokaler (lägenhet och lokal får
--   varsin PDF).
-- Idempotent.

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, f.key, f.label, f.typ, false,
       '{"section":"kontaktinfo"}'::jsonb, f.ord
  from object_definitions od
  cross join (values
    ('avi_logo', 'Avisering – logotyp (fil)',           'text', 600),
    ('avi_farg', 'Avisering – profilfärg',              'text', 610),
    ('avi_slug', 'Avisering – projekthemsida (adress)', 'text', 620)
  ) as f(key, label, typ, ord)
 where od.key = 'leveransoversikt'
   and not exists (select 1 from field_definitions x where x.object_id = od.id and x.key = f.key);

create or replace function public.leverans_fastighetslista(
  p_search text default null,
  p_filters jsonb default '[]'::jsonb
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with res as (
    select public.list_records_filtered('delivery', p_search, coalesce(p_filters, '[]'::jsonb),
                                        'updated_at', 'desc', 100000, 0) as j
  ), lev as (
    select (e->>'id')::uuid as id, e->>'status' as status, e->'data' as d
      from res, jsonb_array_elements(res.j->'items') e
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'status', l.status,
           'kund_id', k.id,
           'kund', coalesce(k.namn, nullif(btrim(l.d->>'fastighetsagare'), '')),
           'kund_kopplad', k.id is not null,
           'bolag', coalesce(b.namn, nullif(btrim(l.d->>'bolagsnamn'), '')),
           'ort', l.d->>'ort',
           'fastighet', l.d->>'fastighetsbeteckning',
           'adress', l.d->>'adress',
           'hushall', l.d->'lagenheter',
           'lokaler', l.d->'lokaler',
           'fs_portar', l.d->'fs_portar',
           'sc_portar', l.d->'sc_portar',
           'fbl', l.d->>'fbl',
           'kundklar', l.d->>'kundklar',
           'kundklar_ce', l.d->>'kundklar_ce',
           'telia_status', l.d->>'projektplan_status',
           'leverans', coalesce(nullif(l.d->>'kanalpaket', ''), nullif(l.d->>'kollektivt_internet', '')),
           'bef_ko', nullif(l.d->>'befintlig_fiberleverantor', ''),
           'avtalstid_ko', l.d->>'avtalstid_ko',
           'bef_koax', coalesce(nullif(l.d->>'befintlig_koax', ''), x.koax),
           'ktv_avtal', l.d->>'ktv_avtal',
           'lpl', l.d->>'responsible_lpl',
           'entreprenor', l.d->>'entreprenor',
           'projektledare', l.d->>'projektledare',
           'telianow_cs', l.d->>'telianow_cs',
           'ce_ansvariga', (select coalesce(jsonb_agg(v), '[]'::jsonb)
                              from unnest(array[nullif(l.d->>'ce_ansvarig', ''), nullif(l.d->>'ce_ansvarig_2', '')]) v
                             where v is not null),
           'detalj', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                        from jsonb_each(l.d) e
                       where e.key like 'chk\_%'
                          or e.key in ('kontakt_agare_namn', 'kontakt_agare_epost',
                                       'forvaltare_namn', 'forvaltare_epost', 'forvaltare_telefon',
                                       'checklista_kommentar'))
         ) order by lower(coalesce(k.namn, l.d->>'fastighetsagare', 'ö')), lower(l.d->>'ort'), lower(l.d->>'fastighetsbeteckning')), '[]'::jsonb)
    from lev l
    left join lateral (
      select r.id, coalesce(nullif(r.title, ''), r.data->>'name') as namn
        from relationships rl join records r on r.id = rl.to_record_id and r.deleted_at is null
       where rl.from_record_id = l.id and rl.rel_type = 'delivery_for'
       limit 1) k on true
    left join lateral (
      select coalesce(nullif(r.title, ''), r.data->>'name') as namn
        from relationships rl join records r on r.id = rl.to_record_id and r.deleted_at is null
       where rl.from_record_id = l.id and rl.rel_type = 'delivery_for_db'
       limit 1) b on true
    left join lateral (
      select string_agg(distinct f.data->>'befintlig_koax', ', ') as koax
        from relationships rl join records f on f.id = rl.from_record_id and f.deleted_at is null
       where rl.to_record_id = l.id and rl.rel_type = 'd2d_fast_delivery'
         and nullif(btrim(f.data->>'befintlig_koax'), '') is not null) x on true
$$;

revoke all on function public.leverans_fastighetslista(text, jsonb) from public, anon;
grant execute on function public.leverans_fastighetslista(text, jsonb) to authenticated;
