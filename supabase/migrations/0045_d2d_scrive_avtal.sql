-- D2D → Scrive: avtal som skickas för signering från en lägenhet.
-- Edge-funktionen scrive-sign skapar avtalet i Scrive från mallen och fyller
-- i det; scrive-callback uppdaterar status och sparar den signerade PDF:en.

create table if not exists public.d2d_avtal (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  lagenhet_id        uuid not null references public.records(id) on delete cascade,
  scrive_document_id text,
  status             text not null default 'skapas'
                     check (status in ('skapas', 'vantar', 'signerat', 'avvisat', 'avbrutet', 'fel')),
  leverans           text not null default 'plats' check (leverans in ('plats', 'skickat')),
  kund_namn          text,
  underlag           jsonb not null default '{}'::jsonb,   -- det som fylldes i avtalet
  pdf_path           text,
  fel                text,
  callback_token     text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  skapad_av          uuid references public.users(id) on delete set null,
  skapad             timestamptz not null default now(),
  uppdaterad         timestamptz not null default now(),
  signerad           timestamptz
);
create index if not exists d2d_avtal_lagenhet_idx on public.d2d_avtal (lagenhet_id, skapad desc);
alter table public.d2d_avtal enable row level security;

-- Läs: samma som lägenheten (den som får se lägenheten ser dess avtal).
-- Skrivningar görs bara av edge-funktionerna (service role).
create or replace function public.d2d_avtal_for(p_lagenhet uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_owner uuid;
begin
  select owner_user_id into v_owner from records
   where id = p_lagenhet and tenant_id = my_tenant_id() and object_type = 'd2d_lagenhet' and deleted_at is null;
  if not found or not can_row('d2d_lagenhet', 'read', v_owner) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'status', a.status, 'leverans', a.leverans, 'kundNamn', a.kund_namn,
             'scriveId', a.scrive_document_id, 'harPdf', a.pdf_path is not null, 'fel', a.fel,
             'skapad', a.skapad, 'uppdaterad', a.uppdaterad, 'signerad', a.signerad,
             'skapadAv', (select coalesce(nullif(full_name, ''), email::text) from users where id = a.skapad_av))
           order by a.skapad desc)
      from d2d_avtal a where a.lagenhet_id = p_lagenhet and a.tenant_id = my_tenant_id()), '[]'::jsonb);
end $$;
grant execute on function public.d2d_avtal_for(uuid) to authenticated;

-- Privat lagring för signerade avtal (hämtas via signerad länk från edge-funktionen).
insert into storage.buckets (id, name, public)
values ('d2d-avtal', 'd2d-avtal', false)
on conflict (id) do nothing;
