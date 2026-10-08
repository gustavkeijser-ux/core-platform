-- [Leverans] Leveranser utan kopplad Kund (koncernmoder): koppla till befintlig Kund
-- där den finns, annars skapa Kund. Nyckel: data->>'fastighetsagare'. Idempotent:
-- skapar inte dubbletter och kopplar bara leveranser som saknar delivery_for.
do $$
declare
  t uuid := 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1';
  agare_user uuid := 'e6704634-f66c-4725-8a89-13fd3debe2a1';
  m record; kund uuid; n int; tot int := 0; nya int := 0;
begin
  for m in select * from (values
    ('Amramus AB',                                           null, 'Amramus AB'),
    ('CENTRIA',                                              'Centria fastigheter', null),
    ('Gamla Livförsäkringsaktiebolaget SEB Trygg Liv (publ)','SEB', null),
    ('Cordan förvaltning',                                   null, 'Cordan förvaltning'),
    ('Arkon Aktiebolag',                                     null, 'Arkon Aktiebolag'),
    ('ANDOL Bostad AB',                                      null, 'ANDOL Bostad AB'),
    ('BRF Vävaren Två',                                      null, 'BRF Vävaren Två'),
    ('HSB BRF Södermalm i Kristinehamn',                     null, 'HSB BRF Södermalm i Kristinehamn'),
    ('Meras Bostäder AB',                                    'Meras Holding AB', null),
    ('Meras Lokaler AB',                                     'Meras Holding AB', null),
    ('Riksbyggens BRF Hallstahammarshus nr 1',               null, 'Riksbyggens BRF Hallstahammarshus nr 1'),
    ('Savills förvaltning',                                  null, 'Savills förvaltning'),
    ('SHAMOUN Invest AB',                                    null, 'SHAMOUN Invest AB'),
    ('Shamoun Fastigheter AB',                               null, 'SHAMOUN Invest AB'),
    ('Bostadsrättsföreningen Vasatornet i Linköping',        null, 'Bostadsrättsföreningen Vasatornet i Linköping'),
    ('BRF Häradsskrivaren',                                  null, 'BRF Häradsskrivaren'),
    ('BRF Lotusblomman',                                     null, 'BRF Lotusblomman'),
    ('Brf Skogsbrynet',                                      null, 'Brf Skogsbrynet'),
    ('BRF Sparvugglan',                                      null, 'BRF Sparvugglan'),
    ('Kattugglan, Enköping, BRF',                            null, 'BRF Kattugglan Enköping'),
    ('Spettet, BRF',                                         null, 'BRF Spettet'),
    ('Bostadsrättsföreningen Luxvreten',                     null, 'Bostadsrättsföreningen Luxvreten'),
    ('Ängsgatan Varla 5:22 ekonomisk förening',              null, 'Ängsgatan Varla 5:22 ekonomisk förening')
  ) as x(agare, befintlig, ny)
  loop
    select id into kund from records
     where tenant_id = t and object_type = 'koncernmoder' and deleted_at is null
       and title = coalesce(m.befintlig, m.ny)
     order by created_at limit 1;
    if kund is null then
      if m.befintlig is not null then raise exception 'Kund saknas: %', m.befintlig; end if;
      insert into records (tenant_id, object_type, data, status, owner_user_id, created_by)
      values (t, 'koncernmoder', jsonb_build_object('name', m.ny), 'active', agare_user, agare_user)
      returning id into kund;
      nya := nya + 1;
    end if;
    insert into relationships (tenant_id, from_record_id, to_record_id, rel_type)
    select t, d.id, kund, 'delivery_for'
      from records d
     where d.tenant_id = t and d.object_type = 'delivery' and d.deleted_at is null
       and btrim(d.data->>'fastighetsagare') = m.agare
       and not exists (select 1 from relationships r where r.from_record_id = d.id and r.rel_type = 'delivery_for');
    get diagnostics n = row_count;
    tot := tot + n;
  end loop;
  raise notice 'Nya kunder: %, kopplade leveranser: %', nya, tot;
end $$;
