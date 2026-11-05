-- =============================================================================
-- D2D → Avtal: orderbekräftelse via Scrive (Gustav 5 nov 2026).
--
-- Admin skickar en orderbekräftelse på en såld lägenhet eller ett signerat
-- Scrive-avtal. Edge-funktionen scrive-sign (action "order_skicka") bygger en PDF av
-- tjänsterna, priserna, bindningstiden och kunduppgifterna, laddar upp den i
-- Scrive och startar dokumentet. ConnectEstate (avsändaren) är signerande part
-- utan BankID; kunden är mottagare och får orderbekräftelsen när avsändaren
-- signerat. scrive-callback uppdaterar statusen.
--
-- Skrivningar görs bara av edge-funktionerna (service role). Läsning för
-- administratörer via d2d_orderbekraftelse_lista().
-- =============================================================================

create table if not exists public.d2d_orderbekraftelse (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  lagenhet_id        uuid not null references public.records(id) on delete cascade,
  avtal_id           uuid references public.d2d_avtal(id) on delete set null,
  scrive_document_id text,
  -- skapas: byggs; vantar: väntar på avsändarens signatur; skickad: kunden har fått den
  status             text not null default 'skapas'
                     check (status in ('skapas', 'vantar', 'skickad', 'avbrutet', 'fel')),
  kund_namn          text,
  mottagare          text,
  underlag           jsonb not null default '{}'::jsonb,
  pdf_path           text,
  fel                text,
  callback_token     text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  skapad_av          uuid references public.users(id) on delete set null,
  skapad             timestamptz not null default now(),
  uppdaterad         timestamptz not null default now(),
  skickad            timestamptz
);
create index if not exists d2d_orderbekraftelse_lagenhet_idx on public.d2d_orderbekraftelse (lagenhet_id, skapad desc);
create unique index if not exists d2d_orderbekraftelse_scrive_idx on public.d2d_orderbekraftelse (scrive_document_id) where scrive_document_id is not null;
alter table public.d2d_orderbekraftelse enable row level security;

-- Senaste orderbekräftelsen per lägenhet (bara administratörer).
create or replace function public.d2d_orderbekraftelse_lista()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', o.id, 'lagenhetId', o.lagenhet_id, 'avtalId', o.avtal_id, 'status', o.status,
             'mottagare', o.mottagare, 'skapad', o.skapad, 'skickad', o.skickad, 'fel', o.fel,
             'harPdf', o.pdf_path is not null,
             'skapadAv', (select coalesce(nullif(full_name, ''), email::text) from users where id = o.skapad_av)))
      from (select distinct on (lagenhet_id) * from d2d_orderbekraftelse
             where tenant_id = my_tenant_id() order by lagenhet_id, skapad desc) o), '[]'::jsonb);
end $$;
revoke all on function public.d2d_orderbekraftelse_lista() from public;
grant execute on function public.d2d_orderbekraftelse_lista() to authenticated;
