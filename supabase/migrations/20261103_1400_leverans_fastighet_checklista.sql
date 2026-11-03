-- [Leverans] Leveransöversikten → Alla fastigheter: expanderbar rad med kontakter
-- och checklista per fastighet (Gustav 3 nov, "Allt per fastighet"). Idempotent.
--
-- 1. 18 nya fält på leveransen (sektion Uppföljning, inga listkolumner):
--    ägare/primär kontakt (namn, e-post), förvaltare (namn, e-post, telefon) och
--    13 kryssrutor. Projektplan-importen rör dem aldrig (de finns inte i
--    projektplan_faltkarta).
-- 2. Förifyllning: tomma fält på fastigheten får värdet från koncernmoderns
--    Leveransöversikt-post (bara där posten har ett värde; ifyllt rörs inte).
-- 3. leverans_fastighetslista skickar med fälten.

insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, f.key, f.label, f.typ, false,
       '{"section":"uppfoljning","_column":false}'::jsonb, f.ord
  from object_definitions od
  cross join (values
    ('kontakt_agare_namn',        'Ägare/primär kontakt – namn',     'text',    1001),
    ('kontakt_agare_epost',       'Ägare/primär kontakt – e-post',   'email',   1002),
    ('forvaltare_namn',           'Förvaltare – namn',               'text',    1003),
    ('forvaltare_epost',          'Förvaltare – e-post',             'email',   1004),
    ('forvaltare_telefon',        'Förvaltare – telefon',            'phone',   1005),
    ('chk_uppsagning_bef',        'Uppsägning befintlig leverantör', 'boolean', 1010),
    ('chk_avi_1',                 'Avi 1',                           'boolean', 1011),
    ('chk_avi_2',                 'Avi 2',                           'boolean', 1012),
    ('chk_avi_3',                 'Avi 3',                           'boolean', 1013),
    ('chk_projekthemsida',        'Projekthemsida',                  'boolean', 1014),
    ('chk_adresslista',           'Adresslista',                     'boolean', 1015),
    ('chk_leveransdatum',         'Leveransdatum',                   'boolean', 1016),
    ('chk_torrinstallation',      'Torrinstallation',                'boolean', 1017),
    ('chk_uppsagningar',          'Uppsägningar',                    'boolean', 1018),
    ('chk_levererad',             'Levererad',                       'boolean', 1019),
    ('chk_bekraftad_projektplan', 'Bekräftad projektplan',           'boolean', 1020),
    ('chk_forvaltningsdokument',  'Förvaltningsdokument',            'boolean', 1021),
    ('chk_bommar',                'Bommar',                          'boolean', 1022)
  ) as f(key, label, typ, ord)
 where od.key = 'delivery'
   and not exists (select 1 from field_definitions x where x.object_id = od.id and x.key = f.key);

-- Förifyll från koncernmoderns Leveransöversikt-post (fält i posten → fält på leveransen).
with karta(post, lev) as (values
    ('agare_namn', 'kontakt_agare_namn'), ('agare_epost', 'kontakt_agare_epost'),
    ('forvaltare_namn', 'forvaltare_namn'), ('forvaltare_epost', 'forvaltare_epost'),
    ('forvaltare_telefon', 'forvaltare_telefon'),
    ('uppsagning_bef', 'chk_uppsagning_bef'), ('avi_1', 'chk_avi_1'), ('avi_2', 'chk_avi_2'),
    ('avi_3', 'chk_avi_3'), ('projekthemsida', 'chk_projekthemsida'), ('adresslista', 'chk_adresslista'),
    ('leveransdatum', 'chk_leveransdatum'), ('torrinstallation', 'chk_torrinstallation'),
    ('uppsagningar', 'chk_uppsagningar'), ('levererad', 'chk_levererad'),
    ('bekraftad_projektplan', 'chk_bekraftad_projektplan'),
    ('forvaltningsdokument', 'chk_forvaltningsdokument'), ('bommar', 'chk_bommar')
), post as (
  select distinct on (rl.to_record_id) rl.to_record_id as kund_id, p.data as pd
    from records p join relationships rl on rl.from_record_id = p.id and rl.rel_type = 'levov_kund'
   where p.object_type = 'leveransoversikt' and p.deleted_at is null
   order by rl.to_record_id, p.updated_at desc
), ny as (
  select d.id, jsonb_object_agg(k.lev, po.pd -> k.post) as patch
    from records d
    join relationships rk on rk.from_record_id = d.id and rk.rel_type = 'delivery_for'
    join post po on po.kund_id = rk.to_record_id
    cross join karta k
   where d.object_type = 'delivery' and d.deleted_at is null
     and not (d.data ? k.lev)
     and po.pd ? k.post
     and jsonb_typeof(po.pd -> k.post) <> 'null'
     and coalesce(po.pd ->> k.post, '') <> ''
   group by d.id
)
update records r set data = r.data || ny.patch
  from ny where r.id = ny.id;

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
           'telianow_cs', l.d->>'telianow_cs',
           'detalj', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                        from jsonb_each(l.d) e
                       where e.key like 'chk\_%'
                          or e.key in ('kontakt_agare_namn', 'kontakt_agare_epost',
                                       'forvaltare_namn', 'forvaltare_epost', 'forvaltare_telefon'))
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
