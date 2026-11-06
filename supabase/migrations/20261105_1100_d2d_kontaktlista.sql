-- Door to door → Kontaktlista.
--
-- Alla D2D-lägenheter där vi fått in telefon och/eller e-post: namn, telefon,
-- e-post, adress, lägenhetsnummer och datum när uppgifterna kom in.
--
-- Säkerhet:
--  * Bara personer i d2d_kontakt_behorighet ser listan (Gustav, Lukas, Anton).
--    Tabellen har RLS utan policyer och inga rättigheter för anon/authenticated,
--    så den kan bara läsas/ändras via security definer-funktionerna nedan
--    (eller av Gustav i Supabase-dashboarden).
--  * Funktionerna kontrollerar behörigheten själva och kastar fel annars.
--  * Varje visning/sökning och varje export loggas i d2d_kontakt_logg
--    (vem, när, sökord, antal rader). Loggen går inte att ändra från appen.
--  * Personnummer ingår inte.
--
-- "Inkom" = första gången telefon eller e-post finns på lägenheten enligt
-- audit_log. Fanns uppgiften redan vid första loggade ändringen (eller finns
-- ingen logg) används lägenhetens skapad-datum (importen).

create table if not exists public.d2d_kontakt_behorighet (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid not null references public.users(id) on delete cascade,
  primary key (tenant_id, user_id)
);
alter table public.d2d_kontakt_behorighet enable row level security;
revoke all on public.d2d_kontakt_behorighet from anon, authenticated;
insert into public.d2d_kontakt_behorighet (tenant_id, user_id)
  select u.tenant_id, u.id from public.users u
   where lower(u.email) in ('gustav@connectestate.se', 'lukas@connectestate.se', 'anton.haggberg@connectestate.se')
  on conflict do nothing;

create table if not exists public.d2d_kontakt_logg (
  id        bigserial primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid,
  handling  text not null check (handling in ('visa', 'export')),
  sok       text,
  antal     integer,
  tid       timestamptz not null default now()
);
alter table public.d2d_kontakt_logg enable row level security;
revoke all on public.d2d_kontakt_logg from anon, authenticated;
revoke all on sequence public.d2d_kontakt_logg_id_seq from anon, authenticated;
create index if not exists d2d_kontakt_logg_tid_idx on public.d2d_kontakt_logg (tenant_id, tid desc);

/** Har den inloggade behörighet till kontaktlistan? */
create or replace function public.d2d_kontakt_behorig()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (
    select 1 from d2d_kontakt_behorighet where tenant_id = my_tenant_id() and user_id = auth.uid())
$$;

/** Raderna (intern, anropas bara av funktionerna nedan). */
create or replace function public.d2d_kontakt_rader(p_tenant uuid, p_sok text)
returns table (
  id uuid, namn text, telefon text, epost text, gata text, postnummer text, postort text,
  lgh text, fastighet text, status text, saljare text, inkom timestamptz
) language sql stable security definer set search_path = public as $$
  with l as (
    select r.* from records r
     where r.tenant_id = p_tenant and r.object_type = 'd2d_lagenhet' and r.deleted_at is null
       and (coalesce(trim(r.data->>'kund_telefon'), '') <> '' or coalesce(trim(r.data->>'kund_epost'), '') <> '')
  )
  select l.id,
         nullif(trim(l.data->>'kund_namn'), ''),
         nullif(trim(l.data->>'kund_telefon'), ''),
         nullif(trim(l.data->>'kund_epost'), ''),
         nullif(trim(concat_ws(' ', nullif(trim(l.data->>'gatunamn'), ''), nullif(trim(l.data->>'gatunummer'), ''), nullif(trim(l.data->>'ingang'), ''))), ''),
         nullif(trim(l.data->>'postnummer'), ''),
         nullif(trim(l.data->>'postort'), ''),
         nullif(trim(l.data->>'name'), ''),
         nullif(trim(l.data->>'fastighetsbeteckning'), ''),
         l.status,
         u.full_name,
         case when a.forsta is null or a.fanns_fore then l.created_at
              else coalesce(a.med_kontakt, l.created_at) end
    from l
    left join users u on u.id = case when (l.data->>'saljare') ~ '^[0-9a-f-]{36}$' then (l.data->>'saljare')::uuid end
    left join lateral (
      select min(x.occurred_at) as forsta,
             min(x.occurred_at) filter (where coalesce(trim(x.after->>'kund_telefon'), '') <> '' or coalesce(trim(x.after->>'kund_epost'), '') <> '') as med_kontakt,
             (array_agg(coalesce(trim(x.before->>'kund_telefon'), '') <> '' or coalesce(trim(x.before->>'kund_epost'), '') <> '' order by x.occurred_at))[1] as fanns_fore
        from audit_log x
       where x.tenant_id = l.tenant_id and x.object_id = l.id
    ) a on true
   where coalesce(trim(p_sok), '') = ''
      or concat_ws(' ', l.data->>'kund_namn', l.data->>'kund_telefon', regexp_replace(coalesce(l.data->>'kund_telefon', ''), '\D', '', 'g'),
                   l.data->>'kund_epost', l.data->>'gatunamn', l.data->>'gatunummer', l.data->>'postort', l.data->>'postnummer',
                   l.data->>'name', l.data->>'fastighetsbeteckning') ilike '%' || trim(p_sok) || '%'
$$;
revoke all on function public.d2d_kontakt_rader(uuid, text) from public, anon, authenticated;

/** Kontaktlistan, en sida i taget (nyast inkomna först). Loggar varje visning/sökning. */
create or replace function public.d2d_kontaktlista(p_sok text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_totalt integer; v_rader jsonb;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet till kontaktlistan' using errcode = '42501';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 100), 1), 500);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  select coalesce(max(k.n), 0)::int,
         coalesce(jsonb_agg(to_jsonb(k) - 'n' order by k.inkom desc, k.gata, k.lgh), '[]'::jsonb)
    into v_totalt, v_rader
    from (select r.*, count(*) over () as n from d2d_kontakt_rader(v_t, p_sok) r
           order by r.inkom desc, r.gata, r.lgh limit p_limit offset p_offset) k;
  if v_totalt = 0 and p_offset > 0 then
    select count(*) into v_totalt from d2d_kontakt_rader(v_t, p_sok);
  end if;

  if p_offset = 0 then
    insert into d2d_kontakt_logg (tenant_id, user_id, handling, sok, antal)
      values (v_t, auth.uid(), 'visa', nullif(trim(p_sok), ''), v_totalt);
  end if;
  return jsonb_build_object('totalt', v_totalt, 'rader', v_rader);
end $$;

/** Export (CSV byggs i webbläsaren). Loggas alltid med antal rader. */
create or replace function public.d2d_kontaktlista_export(p_sok text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_rader jsonb; v_antal integer;
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet till kontaktlistan' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(k) order by k.inkom desc, k.gata, k.lgh), '[]'::jsonb), count(*)
    into v_rader, v_antal from d2d_kontakt_rader(v_t, p_sok) k;
  insert into d2d_kontakt_logg (tenant_id, user_id, handling, sok, antal)
    values (v_t, auth.uid(), 'export', nullif(trim(p_sok), ''), v_antal);
  return v_rader;
end $$;

/** Senaste 100 händelserna i loggen (visas för behöriga på sidan). */
create or replace function public.d2d_kontakt_logglista()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not d2d_kontakt_behorig() then
    raise exception 'Du har inte behörighet till kontaktlistan' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('tid', g.tid, 'handling', g.handling, 'sok', g.sok, 'antal', g.antal,
                                                       'vem', coalesce(u.full_name, u.email)) order by g.tid desc)
                     from (select * from d2d_kontakt_logg where tenant_id = my_tenant_id() order by tid desc limit 100) g
                     left join users u on u.id = g.user_id), '[]'::jsonb);
end $$;

revoke all on function public.d2d_kontakt_behorig() from public, anon;
revoke all on function public.d2d_kontaktlista(text, integer, integer) from public, anon;
revoke all on function public.d2d_kontaktlista_export(text) from public, anon;
revoke all on function public.d2d_kontakt_logglista() from public, anon;
grant execute on function public.d2d_kontakt_behorig() to authenticated;
grant execute on function public.d2d_kontaktlista(text, integer, integer) to authenticated;
grant execute on function public.d2d_kontaktlista_export(text) to authenticated;
grant execute on function public.d2d_kontakt_logglista() to authenticated;
