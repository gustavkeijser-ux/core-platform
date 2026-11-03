-- D2D: knackhistorik. Varje statusbyte på en dörr sparas som en rad i
-- d2d_knackning. Dörrens status (records.status) är nuläget; tabellen är
-- historiken. Den behövs för planeringen: hur många gånger ett hus knackats
-- och när senast (faktorerna "knackat 1/2/3/fler gånger" och "senast knackad").
--
-- Ett hus får nya dörrposter när det läggs i ett nytt projekt, så raderna bär
-- också kommun, fastighetsbeteckning och dörrens namn. Då kan historiken
-- räknas per hus över flera projekt.
--
-- Triggern lyssnar på både 'd2d_lagenhet' och 'dorr' så att den fungerar före
-- och efter namnbytet av objekttypen.

create table if not exists public.d2d_knackning (
  id bigserial primary key,
  tenant_id uuid not null,
  dorr_id uuid not null,
  fastighet_id uuid,
  projekt_id uuid,
  kommun text,
  fastighetsbeteckning text,
  dorr_namn text,
  status_fran text,
  status text not null,
  saljare text,
  utford_av uuid,
  kalla text not null default 'statusbyte',  -- statusbyte | aterbesok | aterskapad
  tid timestamptz not null default now()
);
create index if not exists d2d_knackning_dorr_idx on public.d2d_knackning (dorr_id, tid desc);
create index if not exists d2d_knackning_hus_idx on public.d2d_knackning (tenant_id, lower(kommun), lower(fastighetsbeteckning), tid desc);
create index if not exists d2d_knackning_fast_idx on public.d2d_knackning (fastighet_id, tid desc);

-- Ingen läsning direkt från klienten; allt går via funktionerna nedan.
alter table public.d2d_knackning enable row level security;

create or replace function public.d2d_knackning_trg()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_fast uuid; v_proj uuid; v_fd jsonb; v_kalla text;
begin
  if new.deleted_at is not null then return null; end if;
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then
      -- Samma status igen men ny kontakt (t.ex. Inte hemma två kvällar) = återbesök.
      if (new.data->>'senast_kontakt') is not distinct from (old.data->>'senast_kontakt') then return null; end if;
      v_kalla := 'aterbesok';
    else
      v_kalla := 'statusbyte';
    end if;
  else
    v_kalla := 'statusbyte';
  end if;
  if coalesce(new.status, 'ej_knackad') = 'ej_knackad' then return null; end if;

  select rl.to_record_id into v_fast from relationships rl
   where rl.from_record_id = new.id and rl.rel_type in ('d2d_lag_fastighet', 'dorr_fastighet') limit 1;
  if v_fast is not null then
    select f.data into v_fd from records f where f.id = v_fast;
    select rp.to_record_id into v_proj from relationships rp
     where rp.from_record_id = v_fast and rp.rel_type = 'd2d_fast_projekt' limit 1;
  end if;

  insert into d2d_knackning (tenant_id, dorr_id, fastighet_id, projekt_id, kommun, fastighetsbeteckning,
                             dorr_namn, status_fran, status, saljare, utford_av, kalla)
  values (new.tenant_id, new.id, v_fast, v_proj,
          coalesce(nullif(v_fd->>'kommun', ''), nullif(v_fd->>'ort', ''), nullif(new.data->>'postort', '')),
          coalesce(nullif(v_fd->>'fastighetsbeteckning', ''), nullif(new.data->>'fastighetsbeteckning', '')),
          coalesce(new.title, new.data->>'name'),
          case when tg_op = 'UPDATE' then old.status end, new.status,
          nullif(new.data->>'saljare', ''), auth.uid(), v_kalla);
  return null;
end $function$;

create or replace trigger trg_d2d_knackning
  after insert or update of status, data on public.records
  for each row when (new.object_type in ('d2d_lagenhet', 'dorr'))
  execute function public.d2d_knackning_trg();

-- Återskapa det som går: en rad per dörr som redan har ett utfall, daterad
-- till senaste kontakt / säljdatum / senaste ändring. Körs bara en gång.
insert into public.d2d_knackning (tenant_id, dorr_id, fastighet_id, projekt_id, kommun, fastighetsbeteckning,
                                  dorr_namn, status, saljare, kalla, tid)
select l.tenant_id, l.id, f.id, rp.to_record_id,
       coalesce(nullif(f.data->>'kommun', ''), nullif(f.data->>'ort', ''), nullif(l.data->>'postort', '')),
       coalesce(nullif(f.data->>'fastighetsbeteckning', ''), nullif(l.data->>'fastighetsbeteckning', '')),
       coalesce(l.title, l.data->>'name'), l.status, nullif(l.data->>'saljare', ''), 'aterskapad',
       coalesce(
         case when l.data->>'senast_kontakt' ~ '^\d{4}-\d{2}-\d{2}' then (l.data->>'senast_kontakt')::timestamptz end,
         case when l.data->>'sald_datum' ~ '^\d{4}-\d{2}-\d{2}' then (l.data->>'sald_datum')::timestamptz end,
         l.updated_at)
  from records l
  left join relationships rl on rl.from_record_id = l.id and rl.rel_type in ('d2d_lag_fastighet', 'dorr_fastighet')
  left join records f on f.id = rl.to_record_id
  left join relationships rp on rp.from_record_id = f.id and rp.rel_type = 'd2d_fast_projekt'
 where l.object_type in ('d2d_lagenhet', 'dorr') and l.deleted_at is null
   and coalesce(l.status, 'ej_knackad') <> 'ej_knackad'
   and not exists (select 1 from public.d2d_knackning k where k.kalla = 'aterskapad' limit 1);

-- Historiken för en dörr (nyast först).
create or replace function public.d2d_knackhistorik_dorr(p_dorr uuid)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not (can_do('d2d_lagenhet', 'read') or can_do('dorr', 'read')) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('tid', k.tid, 'status', k.status, 'statusFran', k.status_fran,
           'saljare', k.saljare, 'kalla', k.kalla) order by k.tid desc)
    from d2d_knackning k where k.dorr_id = p_dorr and k.tenant_id = my_tenant_id()), '[]'::jsonb);
end $function$;
grant execute on function public.d2d_knackhistorik_dorr(uuid) to authenticated;

-- Bearbetning per hus (kommun + beteckning), över alla projekt. Underlaget till
-- dörrkvaliteten: hur många vändor huset knackats, när senast, och utfallet.
-- En vända = ett projekt; dörrar utan projekt räknas per kalendervecka.
-- bara_aterskapad = huset har bara återskapad historik (före 2026-11-03), då är
-- antalet vändor en uppskattning.
create or replace function public.d2d_knackhistorik_per_hus(p_kommun text default null, p_beteckning text default null)
 returns table (kommun text, fastighetsbeteckning text, vandor int, dorrar_knackade int, knackningar int,
                forst_knackad timestamptz, senast_knackad timestamptz, salda int, bara_aterskapad boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not (can_do('d2d_lagenhet', 'read') or can_do('dorr', 'read')) then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  return query
  select max(k.kommun), max(k.fastighetsbeteckning),
         count(distinct coalesce(k.projekt_id::text, to_char(k.tid, 'IYYY-IW')))::int,
         count(distinct k.dorr_id)::int, count(*)::int, min(k.tid), max(k.tid),
         count(distinct k.dorr_id) filter (where k.status in ('sald', 'scrive'))::int,
         bool_and(k.kalla = 'aterskapad')
    from d2d_knackning k
   where k.tenant_id = my_tenant_id() and k.fastighetsbeteckning is not null
     and (p_kommun is null or lower(k.kommun) = lower(p_kommun))
     and (p_beteckning is null or lower(k.fastighetsbeteckning) = lower(p_beteckning))
   group by lower(k.kommun), lower(k.fastighetsbeteckning);
end $function$;
grant execute on function public.d2d_knackhistorik_per_hus(text, text) to authenticated;
