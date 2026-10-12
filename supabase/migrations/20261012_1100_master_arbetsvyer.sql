-- Arbetsvyer: vilken meny man ser. Fyra vyer — fastighetssaljare, d2d, leverans, admin.
-- Vyn styr BARA menyn; roller/behörigheter styr fortfarande vilken data man får se.
-- Administratörer får alltid alla fyra vyer och kan växla fritt. Övriga får de vyer
-- Gustav tilldelar under Inställningar → Användare. Saknar man rad visas hela menyn som förr.
create table if not exists public.user_arbetsvyer (
  user_id    uuid primary key references public.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  vyer       text[] not null default array[]::text[],
  vald       text,
  updated_at timestamptz not null default now()
);
alter table public.user_arbetsvyer enable row level security;
-- Inga policies: allt går via funktionerna nedan.

create or replace function public.arbetsvyer_giltiga()
 returns text[] language sql immutable as $$ select array['fastighetssaljare','d2d','leverans','admin'] $$;

-- Mina vyer + vald vy. {vyer:[...], vald:text|null}. Tom lista = ingen väljare (hela menyn).
create or replace function public.mina_arbetsvyer()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_rad user_arbetsvyer; v_vyer text[];
begin
  select * into v_rad from user_arbetsvyer where user_id = auth.uid();
  if is_admin() then v_vyer := arbetsvyer_giltiga();
  else v_vyer := coalesce((select array_agg(v order by array_position(arbetsvyer_giltiga(), v))
                             from unnest(v_rad.vyer) v where v = any(arbetsvyer_giltiga()) and v <> 'admin'), array[]::text[]);
  end if;
  return jsonb_build_object('vyer', to_jsonb(v_vyer),
    'vald', case when v_rad.vald = any(v_vyer) then v_rad.vald
                 when cardinality(v_vyer) = 0 then null
                 when 'admin' = any(v_vyer) then 'admin'
                 else v_vyer[1] end);
end $function$;

create or replace function public.valj_arbetsvy(p_vy text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v jsonb := mina_arbetsvyer();
begin
  if not (v->'vyer' ? p_vy) then raise exception 'Vyn finns inte för dig' using errcode = '42501'; end if;
  insert into user_arbetsvyer (user_id, tenant_id, vyer, vald)
  values (auth.uid(), my_tenant_id(), array[]::text[], p_vy)
  on conflict (user_id) do update set vald = excluded.vald, updated_at = now();
end $function$;

-- Admin: alla användares tilldelade vyer {<user_id>: [...]}.
create or replace function public.arbetsvyer_alla()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(a.user_id, to_jsonb(a.vyer))
                     from user_arbetsvyer a where a.tenant_id = my_tenant_id()), '{}'::jsonb);
end $function$;

create or replace function public.satt_arbetsvyer(p_user uuid, p_vyer text[])
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare v_vyer text[];
begin
  if not is_admin() then raise exception 'Saknar behörighet' using errcode = '42501'; end if;
  if not exists (select 1 from users where id = p_user and tenant_id = my_tenant_id()) then
    raise exception 'Okänd användare';
  end if;
  select coalesce(array_agg(distinct v), array[]::text[]) into v_vyer
    from unnest(coalesce(p_vyer, array[]::text[])) v where v = any(arbetsvyer_giltiga());
  insert into user_arbetsvyer (user_id, tenant_id, vyer)
  values (p_user, my_tenant_id(), v_vyer)
  on conflict (user_id) do update set vyer = excluded.vyer, updated_at = now();
end $function$;

revoke all on function public.mina_arbetsvyer() from public, anon;
revoke all on function public.valj_arbetsvy(text) from public, anon;
revoke all on function public.arbetsvyer_alla() from public, anon;
revoke all on function public.satt_arbetsvyer(uuid, text[]) from public, anon;
grant execute on function public.mina_arbetsvyer() to authenticated;
grant execute on function public.valj_arbetsvy(text) to authenticated;
grant execute on function public.arbetsvyer_alla() to authenticated;
grant execute on function public.satt_arbetsvyer(uuid, text[]) to authenticated;

-- Startläge utifrån dagens roller: dörrsäljare → d2d, kundtjänst → leverans, admin → admin.
insert into public.user_arbetsvyer (user_id, tenant_id, vyer)
select u.id, u.tenant_id,
       array(select v from unnest(array['fastighetssaljare','d2d','leverans','admin']) v
              where (v = 'd2d'      and 'dorrsaljare' = any(k))
                 or (v = 'leverans' and 'kundtjanst'  = any(k))
                 or (v = 'admin'    and 'admin'       = any(k)))
  from public.users u
  join lateral (select array_agg(r.key) k from public.user_roles ur join public.roles r on r.id = ur.role_id
                 where ur.user_id = u.id) rr on true
 where u.deleted_at is null and rr.k && array['dorrsaljare','kundtjanst','admin']
on conflict (user_id) do nothing;
