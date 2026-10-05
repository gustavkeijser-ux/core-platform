-- =====================================================================
--  0061 — Door to door → Utfall med flikarna Sålda, Scrive och Totalt,
--  som på Avtal-sidan. d2d_utfall_kalla(p_kalla, …) räknar exakt som
--  d2d_utfall men med olika definition av "såld":
--    • 'sald'   — lägenheten har status Såld (som tidigare)
--    • 'scrive' — lägenheten har ett signerat Scrive-avtal
--    • 'totalt' — något av dem
--  Svaret har också 'scrive' (skickade/signerade/väntar/avbrutna avtal
--  bland besöken i urvalet). Funktionen byggs från d2d_utfall så att de
--  två aldrig glider isär i hur resten räknas.
-- =====================================================================

do $$
declare
  v text := pg_get_functiondef('public.d2d_utfall(uuid, uuid, date, date)'::regprocedure);
  par text[][] := array[
    ['public.d2d_utfall(p_projekt', 'public.d2d_utfall_kalla(p_kalla text DEFAULT ''sald''::text, p_projekt'],
    ['(l.data->>''senast_kontakt'')::timestamptz kontakt',
     '(l.data->>''senast_kontakt'')::timestamptz kontakt,
           exists (select 1 from d2d_avtal da where da.lagenhet_id = l.id and da.status = ''signerat'') signerat'],
    ['d2d_bunden_manad(d) bunden',
     'd2d_bunden_manad(d) bunden,
      case p_kalla when ''scrive'' then b.signerat when ''totalt'' then (b.status = ''sald'' or b.signerat)
                   else b.status = ''sald'' end ar_sald'],
    ['salda as (select * from urval where status = ''sald'')', 'salda as (select * from urval where ar_sald)'],
    ['(select count(*) from bundna where status <> ''sald'')', '(select count(*) from bundna where not ar_sald)'],
    ['(select count(*) from svarade where status <> ''sald'')', '(select count(*) from svarade where not ar_sald)'],
    ['count(*) filter (where status = ''sald'') salda, count(*) filter (where status = ''sald'' and mer) mer',
     'count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer) mer'],
    ['''besok'', (select count(*) from urval),',
     '''besok'', (select count(*) from urval),
    ''kalla'', p_kalla,
    ''scrive'', (select jsonb_build_object(
        ''skickade'', count(*), ''signerade'', count(*) filter (where da.status = ''signerat''),
        ''vantar'', count(*) filter (where da.status in (''skapas'', ''vantar'')),
        ''avbrutna'', count(*) filter (where da.status in (''avvisat'', ''avbrutet'', ''fel'')))
        from d2d_avtal da join urval uu on uu.id = da.lagenhet_id),']
  ];
  i int;
begin
  for i in 1 .. array_length(par, 1) loop
    if position(par[i][1] in v) = 0 then
      raise exception 'd2d_utfall_kalla: hittar inte "%"', par[i][1];
    end if;
    v := replace(v, par[i][1], par[i][2]);
  end loop;
  execute v;
end $$;

revoke all on function public.d2d_utfall_kalla(text, uuid, uuid, date, date) from public, anon;
grant execute on function public.d2d_utfall_kalla(text, uuid, uuid, date, date) to authenticated;
