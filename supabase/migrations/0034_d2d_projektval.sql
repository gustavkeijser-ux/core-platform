-- D2D: säljaren väljer projekt innan fastigheterna visas.
-- Dörrsäljare behöver kunna läsa projektnamnen (och kopplingen
-- fastighet → projekt, som RLS bara släpper igenom när båda posterna syns).
insert into role_permissions (role_id, tenant_id, object_type, action, scope)
select r.id, r.tenant_id, 'd2d_projekt', 'read', 'tenant'
  from roles r
 where r.key = 'dorrsaljare'
   and not exists (select 1 from role_permissions rp
                    where rp.role_id = r.id and rp.object_type = 'd2d_projekt' and rp.action = 'read');
