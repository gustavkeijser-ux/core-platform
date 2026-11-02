-- D2D: d2d_utfall_rapport tog ~10 s (statement timeout när månadsrapporten hämtar två
-- månader parallellt). Orsak: "vb.id::text = data->>'vt_bestallning_id'" kan inte använda
-- primärnyckelindexet och gick igenom alla poster en gång per rad. Nu jämförs som uuid
-- (ogiltig text → ingen träff), så uppslaget blir ett indexslag. Ändras på plats.
do $$
declare v_def text;
        v_gammal text := $x$where vb.id::text = u.d->>'vt_bestallning_id' and vb.deleted_at is null$x$;
        v_ny text := $x$where vb.id = (case when u.d->>'vt_bestallning_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (u.d->>'vt_bestallning_id')::uuid end) and vb.deleted_at is null$x$;
begin
  select pg_get_functiondef('public.d2d_utfall_rapport'::regproc) into v_def;
  if position(v_ny in v_def) > 0 then
    raise notice 'd2d_utfall_rapport: redan ändrad';
    return;
  end if;
  if position(v_gammal in v_def) = 0 then
    raise exception 'd2d_utfall_rapport: hittar inte texten som ska bytas';
  end if;
  execute replace(v_def, v_gammal, v_ny);
end $$;
