-- [Leverans] Leveransöversikten → "Alla fastigheter": en rad per fastighet i
-- projektplanen (Gustav 3 nov). Idempotent.
--
-- 1. Nytt fält Kundklar CE (kundklar_ce) på leveransen. Sätts av ConnectEstate i
--    listan; projektplan-importen rör det aldrig (Telias kundklar ligger kvar i
--    `kundklar` och skrivs över varje timme som förut).
-- 2. RPC leverans_fastighetslista: samma behörighet, sök och filter som listan
--    (återanvänder list_records_filtered, security invoker) plus Kund
--    (koncernmoder), direktägande bolag och befintlig koax från Telias
--    adresslista (via D2D-fastigheten).

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, 'kundklar_ce', 'Kundklar CE', 'date', false,
       '{"section":"tidplan","_column":true,"_column_order":26}'::jsonb, 541
  from object_definitions od
 where od.key = 'delivery'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'kundklar_ce');

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
           'telianow_cs', l.d->>'telianow_cs'
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
