-- D2D-sälj → Avtal: säljaren ser sina avtal och sålda även när lägenheten
-- ägs av någon annan (owner_user_id), så länge hen står som säljare.
-- Admin och övriga oförändrade (can_row som förut).
do $$
declare f text; d text;
begin
  foreach f in array array['d2d_avtal_lista(date,date)', 'd2d_salda_lista(date,date)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('l.data->>''saljare'' = auth.uid()::text' in d) > 0 then continue; end if;
    if position('and can_row(''d2d_lagenhet'', ''read'', l.owner_user_id)' in d) = 0 then
      raise exception 'Texten finns inte i %', f;
    end if;
    execute replace(d, 'and can_row(''d2d_lagenhet'', ''read'', l.owner_user_id)',
      'and (can_row(''d2d_lagenhet'', ''read'', l.owner_user_id) or l.data->>''saljare'' = auth.uid()::text)');
  end loop;
end $$;
