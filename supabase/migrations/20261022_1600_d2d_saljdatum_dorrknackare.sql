-- D2D: bara dörrknackare ändrar säljdatum (Gustav 22 okt 2026): "ändringar som jag gör ska inte
-- ändra datum på säljet, det är bara de som har dörrknackare som ändrar datum".
--  * d2d_sald_datum_satt: Såld datum sätts vid statusbyte till Såld bara när den som ändrar har
--    rollen dorrsaljare. Annars gäller tidpunkten då adressen först blev Såld (d2d_sald_tidpunkt).
--  * d2d_sald_datum_tjanster: säljet flyttas vid ändrade tjänster bara när den som ändrar har
--    rollen dorrsaljare (och, som förut, inte en admin som ändrar någon annans sälj).
create or replace function public.d2d_ar_dorrsaljare(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_uid is not null and exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                        where ur.user_id = p_uid and r.key = 'dorrsaljare')
$$;

do $$ declare d text; n text; begin
  d := pg_get_functiondef('public.d2d_sald_datum_tjanster'::regproc);
  if position('d2d_ar_dorrsaljare' in d) = 0 then
    n := replace(d, 'if v_uid::text is distinct from new.data->>''saljare'' and public.is_admin() then return new; end if;',
      E'if v_uid::text is distinct from new.data->>''saljare'' and public.is_admin() then return new; end if;\n  -- Bara dörrknackare (rollen dorrsaljare) flyttar säljet — aldrig admins ändringar (Gustav 22 okt).\n  if not public.d2d_ar_dorrsaljare(v_uid) then return new; end if;');
    if n = d then raise exception 'saknas tjanster'; end if;
    execute n;
  end if;
  d := pg_get_functiondef('public.d2d_sald_datum_satt'::regproc);
  if position('d2d_ar_dorrsaljare' in d) = 0 then
    n := replace(d, E'     and coalesce(current_setting(''d2d.import'', true), '''') <> ''1'' then',
      E'     and coalesce(current_setting(''d2d.import'', true), '''') <> ''1''\n     -- Bara dörrknackare sätter säljdatum vid statusbyte (Gustav 22 okt); annars gäller\n     -- tidpunkten då adressen först blev Såld.\n     and public.d2d_ar_dorrsaljare(auth.uid()) then');
    if n = d then raise exception 'saknas satt'; end if;
    execute n;
  end if;
end $$;
