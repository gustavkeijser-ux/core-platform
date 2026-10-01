-- D2D: prislista för "Vad såldes?" → sammanfattning av avtalet (kampanj- och
-- ordinarie pris per tjänst, totaler, router och TV-box). Samma siffror ska
-- senare fyllas i Scrive-avtalet. Priserna ändras av admin i D2D-vyn.
--
-- Nycklar: "<fält>:<alternativ>" (t.ex. salt_bredband:bb300), eller bara
-- "<fält>" för Ja/Nej-kategorier (salt_trygghet, salt_tvbox).

create table if not exists public.d2d_prislista (
  tenant_id  uuid primary key references public.tenants(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.d2d_prislista enable row level security;
-- Inga direkta läs-/skrivrättigheter: allt går via funktionerna nedan.

create or replace function public.get_d2d_prislista()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select data || jsonb_build_object('updatedAt', updated_at)
                     from d2d_prislista where tenant_id = my_tenant_id()), '{}'::jsonb)
$$;
grant execute on function public.get_d2d_prislista() to authenticated;

create or replace function public.set_d2d_prislista(p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Bara administratörer kan ändra prislistan' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'Ogiltig prislista' using errcode = '22023';
  end if;
  insert into d2d_prislista (tenant_id, data, updated_at, updated_by)
  values (my_tenant_id(), p_data - 'updatedAt', now(), auth.uid())
  on conflict (tenant_id) do update
    set data = excluded.data, updated_at = now(), updated_by = auth.uid();
  return get_d2d_prislista();
end $$;
grant execute on function public.set_d2d_prislista(jsonb) to authenticated;

-- Nya kategorier i "Vad såldes?": router (1 eller 2 st) och TV-box, samt
-- valet "utan Netflix" för sportpaketen (eget UI under Sport).
insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order)
select od.id, od.tenant_id, v.key, v.label, v.typ, false, v.opts, v.sort
  from object_definitions od
 cross join (values
  ('salt_router', 'Router', 'select', '{"section": "salt", "sold_panel": true, "choices": [{"key": "1_router", "label": "1 router (ASUS ZenWiFi BD4)"}, {"key": "2_routrar", "label": "2 routrar (ASUS ZenWiFi BD4)"}]}'::jsonb, 510),
  ('salt_tvbox', 'TV-box', 'boolean', '{"section": "salt", "sold_panel": true}'::jsonb, 525),
  ('salt_sport_utan_netflix', 'Sport utan Netflix', 'boolean', '{"section": "salt"}'::jsonb, 545)
 ) as v(key, label, typ, opts, sort)
 where od.key = 'd2d_lagenhet'
   and not exists (select 1 from field_definitions f where f.object_id = od.id and f.key = v.key);

-- Startpriser (Telia FM-kampanjer, okt 2026) för tenanter som har D2D.
insert into d2d_prislista (tenant_id, data)
select od.tenant_id, $json${
  "kampanjManader": 12,
  "bindningManader": 12,
  "priser": {
    "salt_bredband:bb150":  { "kampanj": 289, "kampanjUtanTv": 369, "ordinarie": 599 },
    "salt_bredband:bb300":  { "kampanj": 299, "kampanjUtanTv": 389, "ordinarie": 649 },
    "salt_bredband:bb600":  { "kampanj": 349, "kampanjUtanTv": 389, "ordinarie": 749 },
    "salt_bredband:bb1000": { "kampanj": 449, "kampanjUtanTv": 489, "ordinarie": 899 },
    "salt_tv:tv_bas":       { "kampanj": 100, "ordinarie": 249 },
    "salt_tv:tv_mellan":    { "kampanj": 150, "ordinarie": 399 },
    "salt_tv:tv_mycket":    { "kampanj": 200, "ordinarie": 549 },
    "salt_streaming_film:streaming_mer":   { "kampanj": 200, "ordinarie": 249 },
    "salt_streaming_film:streaming_maxad": { "kampanj": 250, "ordinarie": 399 },
    "salt_streaming_film:streaming_mest":  { "kampanj": 400, "ordinarie": 549 },
    "salt_streaming_sport:lilla_sportpaketet":   { "kampanj": 400, "kampanjUtanNetflix": 300, "ordinarie": 549 },
    "salt_streaming_sport:stora_sportpaketet":   { "kampanj": 750, "kampanjUtanNetflix": 650, "ordinarie": 799 },
    "salt_streaming_sport:storsta_sportpaketet": { "kampanj": 850, "kampanjUtanNetflix": 750, "ordinarie": 999 },
    "salt_mobil:10_gb":                       { "kampanj": 199, "ordinarie": 299 },
    "salt_mobil:20_gb":                       { "kampanj": 249, "ordinarie": 399 },
    "salt_mobil:obegransad":                  { "kampanj": 299, "ordinarie": 499 },
    "salt_mobil:obegransad_plus":             { "kampanj": 349, "ordinarie": 569 },
    "salt_mobil:obegransad_plus_1_streaming": { "kampanj": 449, "ordinarie": 599 },
    "salt_mobil:obegransad_plus_3_streaming": { "kampanj": 549, "ordinarie": 699 },
    "salt_mobil:extra_anvandare":             { "kampanj": 169, "ordinarie": 229 },
    "salt_trygghet": { "kampanj": 99, "kampanjUtanBredband": 129, "ordinarie": 129 }
  },
  "engang": {
    "salt_router:1_router":  { "bbEnsam": 972,  "bbTv": 972,  "bbPp": 0,   "bbTvTillval": 0 },
    "salt_router:2_routrar": { "bbEnsam": 1800, "bbTv": 1944, "bbPp": 972, "bbTvTillval": 972 },
    "salt_tvbox": { "kampanj": 799, "ordinarie": 1795 }
  }
}$json$::jsonb
  from object_definitions od
 where od.key = 'd2d_lagenhet'
on conflict (tenant_id) do nothing;
