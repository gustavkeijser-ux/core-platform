-- [Leverans] Nytt fält: CE-ansvarig (ansvarig från ConnectEstate) på leveranser.
-- Användarfält i sektionen Resurser, direkt efter Ansvarig LPL. Visas på
-- fastighetsägarkorten i kortvyn. Idempotent.
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, 'ce_ansvarig', 'CE-ansvarig', 'user', false,
       '{"section":"resurser","_column":true,"_column_order":51}'::jsonb, 805
  from object_definitions od
 where od.key = 'delivery'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = 'ce_ansvarig');
