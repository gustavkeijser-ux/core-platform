-- Bondegatan 3 A 1102, Mjölby: såld-datum rättas till 16/10 2026 (Gustav 20 okt).
-- sald_datum 2026-03-13 kom från den gamla adresslistan och följde med när lägenheten återställdes
-- vid VT-avstämningen 19 okt. Försäljningen gjordes 16/10 (kundtjänst lämnade till Jacob, Jacob
-- satte Såld) — mobil kunde inte säljas före 26/9. Ändringen loggas med värdet före.
do $$
declare v_r records%rowtype;
begin
  perform set_config('d2d.import', '1', true);
  select * into v_r from records where id = '2c7f176d-27c3-428d-8571-1e4a9aaaee99' for update;
  if v_r.data->>'sald_datum' = '2026-03-13' then
    update records set data = data || jsonb_build_object('sald_datum', '2026-10-16') where id = v_r.id;
    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_r.tenant_id, v_r.id, 'field_change',
            'Såld-datum rättat till 2026-10-16 (försäljningen registrerades 16/10; 13/3 kom från gamla adresslistan)',
            jsonb_build_object('field', 'sald_datum', 'from', '2026-03-13', 'to', '2026-10-16', 'kalla', 'gustav_2026-10-20'),
            null, 'system', now());
  end if;
end $$;
