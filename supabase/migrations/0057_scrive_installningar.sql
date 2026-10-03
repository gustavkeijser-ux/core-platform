-- =====================================================================
--  0057 — Scrive: vilken mall avtalen skapas från, per tenant.
--  Mall-id:t är ingen hemlighet och ligger därför i databasen (inte som
--  edge function-secret), så att det kan bytas utan att röra secrets.
--  Läses bara av edge functions (service role) — ingen policy för klienter.
-- =====================================================================

create table if not exists public.scrive_installningar (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  mall_id    text not null,
  uppdaterad timestamptz not null default now()
);
alter table public.scrive_installningar enable row level security;

insert into public.scrive_installningar (tenant_id, mall_id)
select id, '9222115557591145766' from public.tenants where id = 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1'
on conflict (tenant_id) do update set mall_id = excluded.mall_id, uppdaterad = now();
