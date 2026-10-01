-- TV-paketet heter "TV Mini" hos Telia och i avtalet. Bara namnet byts;
-- nyckeln tv_bas (och sparade värden och priser) är oförändrade.
update field_definitions fd
   set options = jsonb_set(fd.options, '{choices}', (
         select jsonb_agg(case when c->>'key' = 'tv_bas' then c || '{"label":"TV Mini"}'::jsonb else c end)
           from jsonb_array_elements(fd.options->'choices') c))
  from object_definitions od
 where od.id = fd.object_id and od.key = 'd2d_lagenhet' and fd.key = 'salt_tv'
   and fd.options ? 'choices';
