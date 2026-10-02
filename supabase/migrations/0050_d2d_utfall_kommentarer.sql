-- D2D-utfall: kommentarerna bakom varje skäl till "bara bredband",
-- så att man kan fälla ut skälet och läsa vad säljarna skrev.
do $mig$
declare d text;
  a text := '    ''ejIntresserad'', coalesce(';
begin
  d := pg_get_functiondef('public.d2d_utfall(uuid,uuid,date,date)'::regprocedure);
  if position('ejMerKommentarer' in d) > 0 then return; end if;
  if position(a in d) = 0 then raise exception 'd2d_utfall: hittar inte insättningspunkten'; end if;
  d := replace(d, a,
'    ''ejMerKommentarer'', coalesce((select jsonb_object_agg(k, rader) from (
        select k, jsonb_agg(jsonb_build_object(
                 ''id'', id, ''adress'', concat_ws('' '', d->>''gatunamn'', d->>''gatunummer'') || coalesce('', lgh '' || nullif(d->>''name'', ''''), ''''),
                 ''ort'', d->>''postort'', ''kommentar'', nullif(btrim(d->>''kommentar''), ''''),
                 ''saljare'', (select coalesce(nullif(u.full_name, ''''), u.email::text) from users u where u.id::text = saljare))
               order by kontakt desc nulls last) rader
          from (select s.*, coalesce(nullif(k0, ''''), ''saknas'') k
                  from salda s
                  left join lateral jsonb_array_elements_text(d2d_arr(s.d->''ej_mer_anledning'')) k0 on true
                 where not s.mer) z
         group by k) x), ''{}''::jsonb),
' || a);
  execute d;
end $mig$;
