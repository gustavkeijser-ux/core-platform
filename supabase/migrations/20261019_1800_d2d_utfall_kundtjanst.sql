-- Utfall räknar kundtjänst och följer lönen (Gustav 19 okt: "i Utfall står det att kundtjänst har 0 sålda").
--  * Per säljare: kundtjänst får en egen rad (roll kundtjänst) med de affärer den lämnat till en
--    säljare — samma regel som lönen och topplistan (+1 på både säljaren och kundtjänst).
--    Säljarraderna får viaKt = hur många av säljarens affärer som kom via kundtjänst.
--  * Filtret Säljare matchar även kundtjänst (data.kundtjanst), och kundtjänst finns i listan.
--  * Period: sålda lägenheter räknas på såld-tidpunkten (d2d_sald_tid, samma som lönen) i stället
--    för senaste kontakt, så att importerade/rättade affärer hamnar i rätt period.
do $$
declare v text; n text;
begin
  select pg_get_functiondef('public.d2d_utfall_kalla(text, uuid, uuid, date, date)'::regprocedure) into v;
  if position('''kundtjanst'', s.kt' in v) > 0 then raise notice 'redan gjort'; return; end if;
  n := v;

  n := replace(n, 'and (p_saljare is null or b.saljare = p_saljare::text)',
                  'and (p_saljare is null or b.saljare = p_saljare::text or b.d->>''kundtjanst'' = p_saljare::text)');
  n := replace(n, 'and (p_fran is null or b.kontakt >= p_fran)',
                  'and (p_fran is null or coalesce(case when b.status = ''sald'' then d2d_sald_tid(b.id, b.d) end, b.kontakt) >= p_fran)');
  n := replace(n, 'and (p_till is null or b.kontakt < p_till + 1)',
                  'and (p_till is null or coalesce(case when b.status = ''sald'' then d2d_sald_tid(b.id, b.d) end, b.kontakt) < p_till + 1)');
  n := replace(n, '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal,',
                  '''besok'', besok, ''oppnade'', oppnade, ''salda'', salda, ''mer'', mer, ''avtal'', avtal,
          ''kundtjanst'', s.kt, ''viaKt'', s.via_kt,');
  n := replace(n, 'where u3.ar_sald and u3.saljare = s.saljare',
                  'where u3.ar_sald and (case when s.kt then u3.d->>''kundtjanst'' else u3.saljare end) = s.saljare');
  n := replace(n, 'where u2.ar_sald and u2.saljare = s.saljare',
                  'where u2.ar_sald and (case when s.kt then u2.d->>''kundtjanst'' else u2.saljare end) = s.saljare');
  n := replace(n, 'order by salda desc, besok desc)', 'order by s.kt, salda desc, besok desc)');
  n := replace(n,
'from (select saljare, count(*) besok, count(*) filter (where status <> ''inte_hemma'') oppnade,
                     count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer) mer,
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0) avtal
                from urval where saljare is not null group by 1) s)',
'from (select saljare, false kt, count(*) besok, count(*) filter (where status <> ''inte_hemma'') oppnade,
                     count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer) mer,
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0) avtal,
                     count(*) filter (where ar_sald and d->>''kundtjanst'' ~* ''^[0-9a-f-]{36}$'' and d->>''kundtjanst'' <> saljare) via_kt
                from urval where saljare is not null and (p_saljare is null or saljare = p_saljare::text) group by 1
              union all
              select d->>''kundtjanst'', true, count(*), count(*) filter (where status <> ''inte_hemma''),
                     count(*) filter (where ar_sald), count(*) filter (where ar_sald and mer),
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0), count(*) filter (where ar_sald)
                from urval where d->>''kundtjanst'' ~* ''^[0-9a-f-]{36}$'' and d->>''kundtjanst'' is distinct from saljare
                 and (p_saljare is null or d->>''kundtjanst'' = p_saljare::text) group by 1) s)');
  n := replace(n, 'from (select distinct saljare s from bas where saljare is not null) z',
                  'from (select distinct saljare s from bas where saljare is not null
              union select distinct d->>''kundtjanst'' from bas where d->>''kundtjanst'' ~* ''^[0-9a-f-]{36}$'') z');

  -- Alla nio ersättningar måste ha slagit igenom.
  if (length(n) - length(v)) < 900
     or position('s.kt then u3' in n) = 0 or position('s.kt then u2' in n) = 0
     or position('union all
              select d->>''kundtjanst''' in n) = 0
     or position('b.d->>''kundtjanst'' = p_saljare' in n) = 0
     or position('d2d_sald_tid(b.id, b.d) end, b.kontakt) >= p_fran' in n) = 0
     or position('d2d_sald_tid(b.id, b.d) end, b.kontakt) < p_till' in n) = 0
     or position('order by s.kt,' in n) = 0
     or position('union select distinct d->>''kundtjanst'' from bas' in n) = 0
     or position('''viaKt''' in n) = 0 then
    raise exception 'd2d_utfall_kalla: texten att byta hittades inte (diff %)', length(n) - length(v);
  end if;
  execute n;
end $$;
