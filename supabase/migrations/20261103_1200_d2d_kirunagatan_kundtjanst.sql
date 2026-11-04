-- Kirunagatan 98 lgh 1701 (Vällingby) blir ett rent kundtjänstsälj, enligt Gustav 3 nov:
-- såld 2026-11-03 av kundtjänst ensam. Säljare och ägare är kundtjänst, och markeringen
-- "lämnad av kundtjänst till säljare" (kundtjanst, kundtjanst_lamnad) tas bort så att
-- affären inte räknas som delad med en dörrsäljare. Status ändras inte, så inga mejl.
-- Idempotent.
do $$
declare
  v_id constant uuid := '05a94b2b-12b0-40f4-87e3-861bd6f2bae9';
  v_kt constant text := '5556a666-18c4-40be-9da2-0eeda80a8be9';
  v_r records%rowtype;
begin
  perform set_config('d2d.import', '1', true);
  select * into v_r from records where id = v_id and deleted_at is null for update;
  if not found then return; end if;
  if v_r.data->>'sald_datum' = '2026-11-03' and v_r.data->>'saljare' = v_kt
     and nullif(v_r.data->>'kundtjanst', '') is null then
    return;
  end if;

  update records
     set data = (data - 'kundtjanst' - 'kundtjanst_lamnad')
                || jsonb_build_object('saljare', v_kt, 'sald_datum', '2026-11-03'),
         owner_user_id = v_kt::uuid
   where id = v_id;

  insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
  values (v_r.tenant_id, v_id, 'field_change',
          'Såld av kundtjänst 2026-11-03, inte tilldelad någon säljare (rättat enligt Gustav)',
          jsonb_build_object('kalla', 'rattelse_2026-11-03',
                             'fore', jsonb_build_object('saljare', v_r.data->'saljare', 'kundtjanst', v_r.data->'kundtjanst',
                               'kundtjanst_lamnad', v_r.data->'kundtjanst_lamnad', 'sald_datum', v_r.data->'sald_datum',
                               'owner_user_id', v_r.owner_user_id)),
          null, 'system', now());
end $$;
