-- Utfall: säljarens snitt räknas på egna dörrförsäljningar (Gustav 19 okt: "nu blev Lukas snitt sämre").
-- Affärer som kundtjänst lämnat till säljaren räknas fortfarande i säljarens Sålda (volym, som i
-- lönen och topplistan), men snitt avtal/kund, "mer än bredband" och attach rate på säljarraden
-- räknas bara på säljarens egna affärer. Kundtjänstens affärer har sitt snitt på kundtjänstraden.
-- Nytt fält per rad: saldaEgna (= nämnaren för snitt och mer än bredband).
do $$
declare v text; n text;
  via constant text := 'coalesce(d->>''kundtjanst'' ~* ''^[0-9a-f-]{36}$'' and d->>''kundtjanst'' <> saljare, false)';
begin
  select pg_get_functiondef('public.d2d_utfall_kalla(text, uuid, uuid, date, date)'::regprocedure) into v;
  if position('saldaEgna' in v) > 0 then raise notice 'redan gjort'; return; end if;
  if position('''viaKt'', s.via_kt,' in v) = 0 then raise exception 'kräver 20261019_1800'; end if;
  n := v;

  -- Säljargrenen: mer/avtal bara på egna affärer, plus antal egna.
  n := replace(n,
'from (select saljare, false kt, count(*) besok, count(*) filter (where status <> ''inte_hemma'') oppnade,
                     count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer) mer,
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0) avtal,',
'from (select saljare, false kt, count(*) besok, count(*) filter (where status <> ''inte_hemma'') oppnade,
                     count(*) filter (where ar_sald) salda, count(*) filter (where ar_sald and mer and not ' || via || ') mer,
                     coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald and not ' || via || '), 0) avtal,
                     count(*) filter (where ar_sald and not ' || via || ') salda_egna,');
  -- Kundtjänstgrenen: alla dess affärer är "egna".
  n := replace(n,
'coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0), count(*) filter (where ar_sald)
                from urval where d->>''kundtjanst''',
'coalesce(sum(d2d_antal_avtal(d)) filter (where ar_sald), 0), count(*) filter (where ar_sald), count(*) filter (where ar_sald)
                from urval where d->>''kundtjanst''');
  -- Kolumnordningen i unionen: säljargrenen har via_kt före salda_egna; kundtjänstgrenen likadant.
  n := replace(n, '''kundtjanst'', s.kt, ''viaKt'', s.via_kt,', '''kundtjanst'', s.kt, ''viaKt'', s.via_kt, ''saldaEgna'', s.salda_egna,');
  -- Attach rate (kategorier) på säljarraden: bara egna affärer.
  n := replace(n, 'where u3.ar_sald and (case when s.kt then u3.d->>''kundtjanst'' else u3.saljare end) = s.saljare',
                  'where u3.ar_sald and (case when s.kt then u3.d->>''kundtjanst'' else u3.saljare end) = s.saljare
                                     and (s.kt or not coalesce(u3.d->>''kundtjanst'' ~* ''^[0-9a-f-]{36}$'' and u3.d->>''kundtjanst'' <> u3.saljare, false))');

  if position('salda_egna,' in n) = 0 or position('''saldaEgna''' in n) = 0
     or position('count(*) filter (where ar_sald), count(*) filter (where ar_sald)
                from urval where d->>''kundtjanst''' in n) = 0
     or position('and (s.kt or not coalesce(u3.d' in n) = 0 then
    raise exception 'd2d_utfall_kalla: texten att byta hittades inte';
  end if;
  execute n;
end $$;
