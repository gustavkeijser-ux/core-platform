-- =====================================================================
--  0058 — D2D: TV-paketen TV Start och TV Bas (0 kr/mån, TV-box ingår).
--  Övriga TV-paket (Mini, Mellan, Mycket) är oförändrade. TV-boxen ingår
--  alltid i alla TV-paket — det sköts i prisberäkningen, inte här.
--  OBS: nyckeln tv_bas är sedan tidigare "TV Mini"; nya TV Bas = tv_basic.
-- =====================================================================

-- Alternativen i ordning: Start, Bas, Mini, Mellan, Mycket.
update public.field_definitions f
   set options = jsonb_set(f.options, '{choices}',
         jsonb_build_array(
           jsonb_build_object('key', 'tv_start', 'label', 'TV Start'),
           jsonb_build_object('key', 'tv_basic', 'label', 'TV Bas'))
         || coalesce((select jsonb_agg(c) from jsonb_array_elements(f.options->'choices') c
                       where c->>'key' not in ('tv_start', 'tv_basic')), '[]'::jsonb))
  from public.object_definitions o
 where o.id = f.object_id and o.key = 'd2d_lagenhet' and f.key = 'salt_tv';

-- Priser: 0 kr kampanj och ordinarie (finns de redan rörs de inte).
update public.d2d_prislista
   set data = jsonb_set(data, '{priser}',
         jsonb_build_object('salt_tv:tv_start', jsonb_build_object('kampanj', 0, 'ordinarie', 0),
                            'salt_tv:tv_basic', jsonb_build_object('kampanj', 0, 'ordinarie', 0))
         || coalesce(data->'priser', '{}'::jsonb))
 where tenant_id is not null;
