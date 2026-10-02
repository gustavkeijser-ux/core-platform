-- D2D-utfall: sålda tjänster räknas med bredband, mobil delas på
-- huvudabonnemang och extra användare. TV-box och extra router räknas
-- inte längre som merförsäljning.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.d2d_utfall(uuid,uuid,date,date)'::regprocedure);
  if position('mobil_huvud' in d) > 0 then return; end if;

  -- "Mer än bredband" utan TV-box och router; mobil = huvudabonnemang eller extra användare.
  d := replace(d, '        or d->>''salt_tvbox'' = ''true'' or nullif(d->>''salt_router'', '''') is not null' || chr(10), '');
  d := replace(d,
    '        ''tv'', (select count(*) from salda where nullif(d->>''salt_tv'', '''') is not null),',
    '        ''bredband'', (select count(*) from salda where nullif(d->>''salt_bredband'', '''') is not null or d->''salt_svar''->>''salt_bredband'' = ''true''),' || chr(10) ||
    '        ''tv'', (select count(*) from salda where nullif(d->>''salt_tv'', '''') is not null),');
  d := replace(d,
    '        ''mobil'', (select count(*) from salda where jsonb_array_length(d2d_arr(d->''salt_mobil'')) > 0),',
    '        ''mobil_huvud'', (select count(*) from salda where exists (select 1 from jsonb_array_elements_text(d2d_arr(d->''salt_mobil'')) x where x <> ''extra_anvandare'')),' || chr(10) ||
    '        ''mobil_extra'', (select count(*) from salda where d2d_arr(d->''salt_mobil'') ? ''extra_anvandare''),');
  d := replace(d, '        ''tvbox'', (select count(*) from salda where d->>''salt_tvbox'' = ''true''),' || chr(10), '');
  d := replace(d, '        ''router'', (select count(*) from salda where nullif(d->>''salt_router'', '''') is not null),' || chr(10), '');

  if position('mobil_huvud' in d) = 0 or position('''bredband'', (select' in d) = 0
     or position('salt_tvbox' in d) > 0 or position('salt_router' in d) > 0 then
    raise exception 'd2d_utfall: ersättningen misslyckades';
  end if;
  execute d;
end $mig$;

-- Äldre sålda (inlästa från Drive) saknar ifyllda tjänster men är bredbandsaffärer:
-- räkna dem som bredband och redovisa hur många det är.
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.d2d_utfall(uuid,uuid,date,date)'::regprocedure);
  if position('bredbandUtanUppgift' in d) > 0 then return; end if;
  d := replace(d,
    '''bredband'', (select count(*) from salda where nullif(d->>''salt_bredband'', '''') is not null or d->''salt_svar''->>''salt_bredband'' = ''true''),',
    '''bredband'', (select count(*) from salda where nullif(d->>''salt_bredband'', '''') is not null or d->''salt_svar''->>''salt_bredband'' = ''true''' ||
      ' or not (d ? ''salt_svar'' or d ? ''salt_bredband'' or d ? ''salt_mobil'' or d ? ''salt_tv'')),' || chr(10) ||
    '        ''bredbandUtanUppgift'', (select count(*) from salda where not (d ? ''salt_svar'' or d ? ''salt_bredband'' or d ? ''salt_mobil'' or d ? ''salt_tv'')),');
  if position('bredbandUtanUppgift' in d) = 0 then raise exception 'd2d_utfall: ersättningen misslyckades'; end if;
  execute d;
end $mig$;
