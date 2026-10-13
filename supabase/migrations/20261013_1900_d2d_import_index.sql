-- 20261013 — Index för adressimporten (Telia-matchning på PunktID, befintlig lägenhet på PunktID).
-- Utan dem gjorde varje importerad rad en sekventiell genomsökning av telia_adresser.
create index if not exists telia_adresser_punkt on public.telia_adresser (punkt_id);
create index if not exists records_d2d_lag_punkt on public.records ((data->>'punkt_id'))
  where object_type = 'd2d_lagenhet' and deleted_at is null;
