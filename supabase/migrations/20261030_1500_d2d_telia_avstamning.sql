-- Utfall → Telia-avstämning och nyckeltal (Gustav 30 okt).
--
-- Varje månad läses Telias orderfil (VT-exporten) in och stäms av mot säljarnas registrerade
-- försäljning (lägenheter med status Såld, såld-tidpunkt = d2d_sald_tid, samma som lönen).
--
--  * d2d_telia_order        — orderfilens rader, en per ordernummer och månad (fil). En ny fil för
--                             samma månad ersätter den gamla (gamla rader får aktuell = false).
--  * d2d_telia_fil          — vilka månader som har en fil (och vem som laddade upp).
--  * d2d_telia_avstamning   — resultatet per månad: en rad per såld lägenhet och per Telia-order
--                             utan motsvarighet. Kategori: matchad / endast_saljare / endast_telia /
--                             avvikande. Utredning: oppen / utredd_korrekt / utredd_rattad (behålls
--                             när avstämningen räknas om).
--  * d2d_telia_paminnelse*  — påminnelse den 15:e om att ladda upp orderfilen (edge function
--                             d2d-telia-paminnelse, pg_cron, cron-token).
--
-- Matchning (Gustavs val 30 okt): gatuadress + lägenhetsnummer (+ uppgång och ort när båda sidor har
-- dem), Telias orderdatum får ligga från 3 dagar före till 30 dagar efter säljdatumet; i andra hand
-- ordernummer som redan ligger på lägenheten (vt_ordernummer). Varje order matchar högst en lägenhet.
-- Tjänster jämförs (bredband, TV, mobil, extraanvändare) → Avvikande när de skiljer sig.
--
-- Nyckeltal (d2d_nyckeltal_manad): pinnar, kunder, tjänster, snitt tjänster/kund, flest tjänster på
-- en kund, hitrate (sälj resp. återkoppling av loggade kontakter), matchningsgrad mot Telia — för
-- månaden, föregående månad och förändringen; per säljare och för teamet (procent viktat på totalerna).
-- Kontakter = statusbyten som säljaren själv gjort (inte import) + knackningar (Inte hemma) utan
-- samtidigt statusbyte.
--
-- Personnummer läses aldrig in från filen.

-- ── 1. Tabeller ───────────────────────────────────────────────────────────────
create table if not exists public.d2d_telia_fil (
  tenant_id uuid not null,
  manad date not null,
  fil_namn text,
  antal_rader int not null default 0,
  antal_ordrar int not null default 0,
  laddad_av uuid,
  laddad_at timestamptz not null default now(),
  primary key (tenant_id, manad)
);
alter table public.d2d_telia_fil enable row level security;

create table if not exists public.d2d_telia_order (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  manad date not null,
  ordernummer text not null,
  fsg_datum date,
  orderstatus text,
  erbjudande text, hastighet text, tv_paket text, tv_val text, tv_premium text, mobil_gb text, extra_anvandare text,
  gata text, nr text, uppgang text, lgh text, postnr text, ort text, csr_id text,
  uppdaterad timestamptz,
  tjanster text,
  bb int, tv boolean, mobil_antal int, extra_antal int,
  rader int not null default 1,
  aktuell boolean not null default true,
  skapad_at timestamptz not null default now(),
  skapad_av uuid
);
create index if not exists d2d_telia_order_tenant_manad on public.d2d_telia_order (tenant_id, manad) where aktuell;
create index if not exists d2d_telia_order_adress on public.d2d_telia_order (tenant_id, lower(gata), lower(nr), lower(lgh)) where aktuell;
alter table public.d2d_telia_order enable row level security;

create table if not exists public.d2d_telia_avstamning (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  manad date not null,
  nyckel text not null,
  lagenhet_id uuid,
  order_id uuid,
  ordernummer text,
  saljare uuid,
  kategori text not null check (kategori in ('matchad', 'endast_saljare', 'endast_telia', 'avvikande')),
  avvikelse text,
  matchning text,
  utredning text not null default 'oppen' check (utredning in ('oppen', 'utredd_korrekt', 'utredd_rattad')),
  utredning_kommentar text,
  utredd_av uuid,
  utredd_at timestamptz,
  aktuell boolean not null default true,
  skapad_at timestamptz not null default now(),
  uppdaterad_at timestamptz not null default now(),
  unique (tenant_id, manad, nyckel)
);
create index if not exists d2d_telia_avstamning_manad on public.d2d_telia_avstamning (tenant_id, manad) where aktuell;
alter table public.d2d_telia_avstamning enable row level security;

create table if not exists public.d2d_telia_paminnelse_mottagare (
  tenant_id uuid not null,
  epost text not null,
  primary key (tenant_id, epost)
);
alter table public.d2d_telia_paminnelse_mottagare enable row level security;
insert into public.d2d_telia_paminnelse_mottagare (tenant_id, epost)
select 'cb257a7f-5245-4a00-80d2-6a394c2c2ee1', 'gustav@connectestate.se'
on conflict do nothing;

create table if not exists public.d2d_telia_paminnelse (
  tenant_id uuid not null,
  manad date not null,
  epost text not null,
  skickad_at timestamptz not null default now(),
  primary key (tenant_id, manad, epost)
);
alter table public.d2d_telia_paminnelse enable row level security;

-- ── 2. Hjälpfunktioner ────────────────────────────────────────────────────────
create or replace function public.d2d_telia_norm(p text)
returns text language sql immutable as $$
  select regexp_replace(translate(lower(coalesce(p, '')), 'éèüÉÈÜ', 'eeueeu'), '[^a-z0-9åäö]', '', 'g')
$$;

/** Första talet i en text (hastighet "300/300" → 300, "BB1000" → 1000). */
create or replace function public.d2d_telia_tal(p text)
returns int language sql immutable as $$
  select nullif(substring(coalesce(p, '') from '\d+'), '')::int
$$;

create or replace function public.d2d_telia_behorig()
returns boolean language sql stable as $$
  select is_admin() or exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                                where ur.user_id = auth.uid() and r.key in ('kundtjanst', 'kundtjanst_leverans', 'ledning'))
$$;

/** Hur en Telia-order skiljer sig från lägenhetens tjänster. Null = lika. */
create or replace function public.d2d_telia_avvikelse(d jsonb, o public.d2d_telia_order)
returns text language plpgsql immutable as $$
declare v text[] := '{}'; v_bb int; v_tv boolean; v_mob int; v_ext int; v_tvs text;
begin
  v_bb := d2d_telia_tal(d->>'salt_bredband');
  v_tv := d2d_tv_raknas(d) or nullif(d->>'salt_tv', '') is not null;
  v_mob := (select count(*) from d2d_mobil_enheter(d));
  v_ext := case when d2d_arr(d->'salt_mobil') ? 'extra_anvandare' then d2d_extra_antal(d) else 0 end;

  if lower(coalesce(o.orderstatus, '')) in ('cancelled', 'canceled') then
    v := array_append(v, 'Avbruten hos Telia (Cancelled)');
  end if;
  if o.bb is not null and v_bb is not null and o.bb <> v_bb then
    v := array_append(v, format('Bredband: säljare %s, Telia %s', v_bb, o.bb));
  elsif o.bb is not null and v_bb is null then
    v := array_append(v, format('Bredband: säljare inget, Telia %s', o.bb));
  elsif o.bb is null and v_bb is not null and coalesce(o.tjanster, '') <> '' then
    v := array_append(v, format('Bredband: säljare %s, Telia inget', v_bb));
  end if;
  if o.tv is not null and o.tv <> v_tv then
    v := array_append(v, case when v_tv then 'TV: säljare ja, Telia nej' else 'TV: säljare nej, Telia ' || coalesce(nullif(o.tv_paket, ''), 'ja') end);
  elsif o.tv and v_tv then
    v_tvs := lower(coalesce(o.tv_paket, '') || ' ' || coalesce(o.tv_val, ''));
    if (v_tvs ~ 'mellan' and d->>'salt_tv' <> 'tv_mellan') or (v_tvs ~ 'mycket' and d->>'salt_tv' <> 'tv_mycket')
       or (v_tvs ~ 'mini' and d->>'salt_tv' <> 'tv_bas') then
      v := array_append(v, format('TV-paket: säljare %s, Telia %s', coalesce(d->>'salt_tv', '–'), btrim(v_tvs)));
    end if;
  end if;
  if o.mobil_antal is not null and o.mobil_antal <> v_mob then
    v := array_append(v, format('Mobil: säljare %s, Telia %s', v_mob, o.mobil_antal));
  end if;
  if o.extra_antal is not null and o.extra_antal <> v_ext then
    v := array_append(v, format('Extraanvändare: säljare %s, Telia %s', v_ext, o.extra_antal));
  end if;
  return nullif(array_to_string(v, '; '), '');
end $$;

-- ── 3. Import av orderfilen ───────────────────────────────────────────────────
/** p_manad = månaden filen avser (vilket datum som helst i månaden). p_rader = filens rader:
 *  [{rad, order, fsg, status, erbjudande, hastighet, tv_paket, tv_val, tv_premium, mobil_gb,
 *    extra, adress, gatnummer, uppgang, lgh, postnr, postort, csr, uppdaterad}]. Rader med samma
 *  ordernummer slås ihop till en order. Filen ersätter månadens tidigare fil. */
create or replace function public.d2d_telia_orderfil_import(p_manad date, p_rader jsonb, p_filnamn text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_m date := date_trunc('month', p_manad)::date; v_n int; v_rader int;
begin
  if not d2d_telia_behorig() then
    raise exception 'Bara admin, ledning och kundtjänst kan läsa in Telias orderfil' using errcode = '42501';
  end if;
  if p_rader is null or jsonb_typeof(p_rader) <> 'array' or jsonb_array_length(p_rader) = 0 then
    raise exception 'Filen innehåller inga rader';
  end if;

  update d2d_telia_order set aktuell = false where tenant_id = v_t and manad = v_m and aktuell;

  with r as (
    select x, nullif(btrim(x->>'order'), '') ordernummer,
           case when x->>'fsg' ~ '^\d{4}-\d{2}-\d{2}' then (x->>'fsg')::date end fsg,
           case when x->>'uppdaterad' ~ '^\d{4}-\d{2}-\d{2}' then (x->>'uppdaterad')::timestamptz end upd
      from jsonb_array_elements(p_rader) x
  ),
  g as (
    select ordernummer,
           min(fsg) fsg_datum,
           max(upd) uppdaterad,
           count(*) rader,
           (array_agg(nullif(btrim(x->>'status'), '') order by upd desc nulls last))[1] orderstatus,
           string_agg(distinct nullif(btrim(x->>'erbjudande'), ''), ', ') erbjudande,
           string_agg(distinct nullif(btrim(x->>'hastighet'), ''), ', ') hastighet,
           string_agg(distinct nullif(btrim(x->>'tv_paket'), ''), ', ') tv_paket,
           string_agg(distinct nullif(btrim(x->>'tv_val'), ''), ', ') tv_val,
           string_agg(distinct nullif(btrim(x->>'tv_premium'), ''), ', ') tv_premium,
           string_agg(nullif(btrim(x->>'mobil_gb'), ''), ', ') mobil_gb,
           string_agg(distinct nullif(btrim(x->>'extra'), ''), ', ') extra_anvandare,
           (array_agg(nullif(btrim(x->>'adress'), '')))[1] gata,
           (array_agg(nullif(btrim(x->>'gatnummer'), '')))[1] nr,
           (array_agg(nullif(btrim(x->>'uppgang'), '')))[1] uppgang,
           (array_agg(nullif(btrim(x->>'lgh'), '')))[1] lgh,
           (array_agg(nullif(btrim(x->>'postnr'), '')))[1] postnr,
           (array_agg(nullif(btrim(x->>'postort'), '')))[1] ort,
           (array_agg(nullif(btrim(x->>'csr'), '')))[1] csr_id,
           count(*) filter (where nullif(btrim(x->>'mobil_gb'), '') is not null) mobil_rader
      from r where ordernummer is not null
     group by ordernummer
  )
  insert into d2d_telia_order (tenant_id, manad, ordernummer, fsg_datum, orderstatus, erbjudande, hastighet, tv_paket, tv_val,
                               tv_premium, mobil_gb, extra_anvandare, gata, nr, uppgang, lgh, postnr, ort, csr_id, uppdaterad,
                               tjanster, bb, tv, mobil_antal, extra_antal, rader, skapad_av)
  select v_t, v_m, g.ordernummer, g.fsg_datum, g.orderstatus, g.erbjudande, g.hastighet, g.tv_paket, g.tv_val, g.tv_premium,
         g.mobil_gb, g.extra_anvandare, g.gata, g.nr, g.uppgang, g.lgh, g.postnr, g.ort, g.csr_id, g.uppdaterad,
         nullif(concat_ws(', ', g.hastighet, g.tv_paket, g.tv_val, g.tv_premium, g.mobil_gb,
                          case when g.extra_anvandare is not null then 'Extra ' || g.extra_anvandare end,
                          case when g.erbjudande ~* 'asus|router|wifi' then 'Router' end), ''),
         d2d_telia_tal(g.hastighet),
         case when g.hastighet is null and g.tv_paket is null and g.mobil_gb is null then null else (g.tv_paket is not null) end,
         case when g.hastighet is null and g.tv_paket is null and g.mobil_gb is null then null
              else greatest(g.mobil_rader, case when g.mobil_gb is not null then 1 else 0 end)::int end,
         case when g.extra_anvandare is null then case when g.hastighet is null and g.mobil_gb is null then null else 0 end
              else coalesce(d2d_telia_tal(g.extra_anvandare), 1) end,
         g.rader, auth.uid()
    from g;
  get diagnostics v_n = row_count;
  v_rader := jsonb_array_length(p_rader);

  insert into d2d_telia_fil (tenant_id, manad, fil_namn, antal_rader, antal_ordrar, laddad_av, laddad_at)
  values (v_t, v_m, p_filnamn, v_rader, v_n, auth.uid(), now())
  on conflict (tenant_id, manad) do update
    set fil_namn = excluded.fil_namn, antal_rader = excluded.antal_rader, antal_ordrar = excluded.antal_ordrar,
        laddad_av = excluded.laddad_av, laddad_at = now();

  -- Föregående månads sälj kan ligga i den här filen (orderdatum upp till 30 dagar efter säljet).
  perform d2d_telia_avstamning_kor((v_m - interval '1 month')::date);
  perform d2d_telia_avstamning_kor(v_m);
  return jsonb_build_object('manad', v_m, 'rader', v_rader, 'ordrar', v_n);
end $$;
revoke all on function public.d2d_telia_orderfil_import(date, jsonb, text) from public, anon;
grant execute on function public.d2d_telia_orderfil_import(date, jsonb, text) to authenticated;

-- ── 4. Avstämningen ───────────────────────────────────────────────────────────
create or replace function public.d2d_telia_avstamning_kor(p_manad date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_m date := date_trunc('month', p_manad)::date;
        v_fran timestamptz; v_till timestamptz; v_min timestamptz;
        l record; o public.d2d_telia_order%rowtype; v_avv text; v_match text; v_n int := 0;
        v_anv uuid[] := '{}';
begin
  if not d2d_telia_behorig() then
    raise exception 'Saknar behörighet' using errcode = '42501';
  end if;
  v_fran := v_m::timestamp at time zone 'Europe/Stockholm';
  v_till := (v_m + interval '1 month')::timestamp at time zone 'Europe/Stockholm';
  v_min := d2d_raknas_fran(v_t);

  update d2d_telia_avstamning set aktuell = false where tenant_id = v_t and manad = v_m and aktuell;

  -- Ordrar som redan är matchade i en annan månads avstämning får inte matchas igen.
  select coalesce(array_agg(order_id), '{}') into v_anv
    from d2d_telia_avstamning where tenant_id = v_t and manad <> v_m and aktuell and order_id is not null
     and kategori in ('matchad', 'avvikande');

  -- Säljarsidan: sålda lägenheter i månaden.
  for l in
    select r.id, r.data d, nullif(r.data->>'saljare', '')::uuid saljare, d2d_sald_tid(r.id, r.data) t
      from records r
     where r.tenant_id = v_t and r.object_type = 'd2d_lagenhet' and r.deleted_at is null and r.status = 'sald'
       and coalesce(r.data->>'tillfallig', '') <> 'true'
       and d2d_sald_tid(r.id, r.data) >= greatest(v_fran, coalesce(v_min, v_fran))
       and d2d_sald_tid(r.id, r.data) < v_till
     order by d2d_sald_tid(r.id, r.data)
  loop
    select x.* into o from d2d_telia_order x where false;  -- nollställ
    v_match := null;
    -- 1. Adress + lägenhetsnummer (+ uppgång/ort när båda har dem), orderdatum −3…+30 dagar.
    select x.* into o from d2d_telia_order x
     where x.tenant_id = v_t and x.aktuell and not (x.id = any (v_anv))
       and d2d_telia_norm(x.gata) = d2d_telia_norm(l.d->>'gatunamn')
       and d2d_telia_norm(x.nr) = d2d_telia_norm(l.d->>'gatunummer')
       and regexp_replace(coalesce(x.lgh, ''), '\D', '', 'g') <> ''
       and regexp_replace(coalesce(x.lgh, ''), '\D', '', 'g') = regexp_replace(coalesce(l.d->>'name', ''), '\D', '', 'g')
       and (nullif(x.uppgang, '') is null or nullif(l.d->>'ingang', '') is null or d2d_telia_norm(x.uppgang) = d2d_telia_norm(l.d->>'ingang'))
       and (nullif(x.ort, '') is null or nullif(l.d->>'postort', '') is null or d2d_telia_norm(x.ort) = d2d_telia_norm(l.d->>'postort'))
       and (x.fsg_datum is null or (x.fsg_datum >= (l.t at time zone 'Europe/Stockholm')::date - 3
                                    and x.fsg_datum <= (l.t at time zone 'Europe/Stockholm')::date + 30))
     order by (x.fsg_datum is null), abs(coalesce(x.fsg_datum, (l.t at time zone 'Europe/Stockholm')::date) - (l.t at time zone 'Europe/Stockholm')::date),
              (lower(coalesce(x.orderstatus, '')) in ('cancelled', 'canceled')), x.manad desc
     limit 1;
    if o.id is not null then v_match := 'adress'; end if;
    -- 2. Ordernummer som redan finns på lägenheten.
    if o.id is null and nullif(l.d->>'vt_ordernummer', '') is not null then
      select x.* into o from d2d_telia_order x
       where x.tenant_id = v_t and x.aktuell and not (x.id = any (v_anv)) and x.ordernummer = l.d->>'vt_ordernummer'
       order by x.manad desc limit 1;
      if o.id is not null then v_match := 'ordernummer'; end if;
    end if;

    if o.id is not null then
      v_anv := v_anv || o.id;
      v_avv := d2d_telia_avvikelse(l.d, o);
    else
      v_avv := null;
    end if;

    insert into d2d_telia_avstamning (tenant_id, manad, nyckel, lagenhet_id, order_id, ordernummer, saljare, kategori, avvikelse, matchning, aktuell, uppdaterad_at)
    values (v_t, v_m, 'l:' || l.id, l.id, o.id, o.ordernummer, l.saljare,
            case when o.id is null then 'endast_saljare' when v_avv is null then 'matchad' else 'avvikande' end,
            v_avv, v_match, true, now())
    on conflict (tenant_id, manad, nyckel) do update
      set lagenhet_id = excluded.lagenhet_id, order_id = excluded.order_id, ordernummer = excluded.ordernummer,
          saljare = excluded.saljare, kategori = excluded.kategori, avvikelse = excluded.avvikelse,
          matchning = excluded.matchning, aktuell = true, uppdaterad_at = now();
    v_n := v_n + 1;
  end loop;

  -- Telia-sidan: ordrar i månadens fil utan motsvarande sälj (avbrutna ordrar räknas inte).
  for o in
    select x.* from d2d_telia_order x
     where x.tenant_id = v_t and x.aktuell and x.manad = v_m and not (x.id = any (v_anv))
       and lower(coalesce(x.orderstatus, '')) not in ('cancelled', 'canceled')
  loop
    insert into d2d_telia_avstamning (tenant_id, manad, nyckel, lagenhet_id, order_id, ordernummer, saljare, kategori, avvikelse, matchning, aktuell, uppdaterad_at)
    values (v_t, v_m, 'o:' || o.ordernummer, null, o.id, o.ordernummer, null, 'endast_telia', null, null, true, now())
    on conflict (tenant_id, manad, nyckel) do update
      set order_id = excluded.order_id, kategori = 'endast_telia', lagenhet_id = null, saljare = null,
          avvikelse = null, matchning = null, aktuell = true, uppdaterad_at = now();
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('manad', v_m, 'rader', v_n);
end $$;
revoke all on function public.d2d_telia_avstamning_kor(date) from public, anon;
grant execute on function public.d2d_telia_avstamning_kor(date) to authenticated;

/** Differenslistan (och allt matchat) för en månad. Admin/ledning/kundtjänst ser allt; en säljare
 *  ser sina egna rader. Kundnamn visas; personnummer finns inte. */
create or replace function public.d2d_telia_avstamning_lista(p_manad date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_m date := date_trunc('month', p_manad)::date; v_alla boolean := d2d_telia_behorig();
begin
  return jsonb_build_object(
    'manad', v_m,
    'fil', (select jsonb_build_object('filNamn', f.fil_namn, 'rader', f.antal_rader, 'ordrar', f.antal_ordrar, 'laddadAt', f.laddad_at,
                                      'laddadAv', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = f.laddad_av))
              from d2d_telia_fil f where f.tenant_id = v_t and f.manad = v_m),
    'filer', coalesce((select jsonb_agg(f.manad order by f.manad desc) from d2d_telia_fil f where f.tenant_id = v_t), '[]'::jsonb),
    'kanUtreda', v_alla,
    'rader', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kategori', a.kategori, 'avvikelse', a.avvikelse, 'matchning', a.matchning,
        'utredning', a.utredning, 'utredningKommentar', a.utredning_kommentar,
        'utreddAv', (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = a.utredd_av), 'utreddAt', a.utredd_at,
        'lagenhetId', a.lagenhet_id,
        'saljareId', a.saljare,
        'saljare', coalesce((select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = a.saljare),
                            case when a.saljare is null and a.lagenhet_id is not null then 'Ingen säljare' end),
        'gata', coalesce(l.data->>'gatunamn', o.gata), 'nummer', coalesce(l.data->>'gatunummer', o.nr),
        'ingang', coalesce(nullif(l.data->>'ingang', ''), o.uppgang), 'lgh', coalesce(nullif(l.data->>'name', ''), o.lgh),
        'ort', coalesce(nullif(l.data->>'postort', ''), o.ort),
        'kund', l.data->>'kund_namn',
        'saldDatum', case when l.id is not null then (d2d_sald_tid(l.id, l.data) at time zone 'Europe/Stockholm')::date end,
        'tjansterSaljare', case when l.id is not null then
            coalesce((select string_agg(d2d_tjanst_etikett(v_t, t), ', ' order by t) from d2d_tjanst_rader(l.data) t), '') end,
        'tjansterTelia', o.tjanster,
        'ordernummer', coalesce(a.ordernummer, o.ordernummer), 'orderstatus', o.orderstatus, 'orderDatum', o.fsg_datum,
        'teliaAdress', case when o.id is not null then concat_ws(' ', o.gata, o.nr, o.uppgang) || coalesce(', lgh ' || nullif(o.lgh, ''), '') || coalesce(', ' || nullif(o.ort, ''), '') end,
        'csr', o.csr_id)
        order by a.kategori, a.saljare, coalesce(l.data->>'gatunamn', o.gata), coalesce(l.data->>'gatunummer', o.nr), coalesce(l.data->>'name', o.lgh))
      from d2d_telia_avstamning a
      left join records l on l.id = a.lagenhet_id
      left join d2d_telia_order o on o.id = a.order_id
     where a.tenant_id = v_t and a.manad = v_m and a.aktuell
       and (v_alla or a.saljare = auth.uid())), '[]'::jsonb));
end $$;
revoke all on function public.d2d_telia_avstamning_lista(date) from public, anon;
grant execute on function public.d2d_telia_avstamning_lista(date) to authenticated;

create or replace function public.d2d_telia_utred(p_id uuid, p_status text, p_kommentar text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t uuid := my_tenant_id();
begin
  if not d2d_telia_behorig() then
    raise exception 'Bara admin, ledning och kundtjänst kan utreda' using errcode = '42501';
  end if;
  if p_status not in ('oppen', 'utredd_korrekt', 'utredd_rattad') then
    raise exception 'Okänd status %', p_status;
  end if;
  update d2d_telia_avstamning
     set utredning = p_status, utredning_kommentar = nullif(btrim(coalesce(p_kommentar, '')), ''),
         utredd_av = case when p_status = 'oppen' then null else auth.uid() end,
         utredd_at = case when p_status = 'oppen' then null else now() end,
         uppdaterad_at = now()
   where id = p_id and tenant_id = v_t;
  if not found then raise exception 'Raden finns inte'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.d2d_telia_utred(uuid, text, text) from public, anon;
grant execute on function public.d2d_telia_utred(uuid, text, text) to authenticated;

-- ── 5. Nyckeltal per säljare och team ─────────────────────────────────────────
create index if not exists activities_tenant_occurred_idx on public.activities (tenant_id, occurred_at);

/** Nyckeltalen för en månad per säljare (uuid): pinnar, kunder, tjänster, flest tjänster, kontakter
 *  med utfall, matchning mot Telia. Månadens aktiviteter läses en gång (akt) så att kontaktfiltren
 *  blir billiga. */
create or replace function public.d2d_nyckeltal_rader(p_tenant uuid, p_manad date)
returns table (saljare uuid, pinnar numeric, kunder int, tjanster int, max_tjanster int, max_kund text, max_lagenhet uuid,
               kontakter int, salj int, aterkoppling int, nej int, ej_hemma int,
               matchade int, avvikande int, endast_saljare int, har_fil boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_m date := date_trunc('month', p_manad)::date; v_fran timestamptz; v_till timestamptz; v_min timestamptz; v_mod jsonb;
begin
  v_fran := v_m::timestamp at time zone 'Europe/Stockholm';
  v_till := (v_m + interval '1 month')::timestamp at time zone 'Europe/Stockholm';
  v_min := d2d_raknas_fran(p_tenant);
  v_mod := d2d_lonemodell_for(p_tenant);
  return query
  with salda0 as materialized (
    select r.id, r.data d, nullif(r.data->>'saljare', '')::uuid saljare, d2d_sald_tid(r.id, r.data) t
      from records r
     where r.tenant_id = p_tenant and r.object_type = 'd2d_lagenhet' and r.deleted_at is null and r.status = 'sald'
       and coalesce(r.data->>'tillfallig', '') <> 'true'
  ),
  salda as (
    select s0.id, s0.d, s0.saljare, d2d_antal_avtal(s0.d) avtal, d2d_pinnar(s0.d, v_mod) pinnar
      from salda0 s0
     where s0.t >= greatest(v_fran, coalesce(v_min, v_fran)) and s0.t < v_till
  ),
  akt as materialized (
    select a.actor_user_id, a.record_id, a.occurred_at, a.activity_type, a.metadata
      from activities a join records r on r.id = a.record_id
     where a.tenant_id = p_tenant and a.occurred_at >= v_fran and a.occurred_at < v_till
       and r.object_type = 'd2d_lagenhet' and a.actor_user_id is not null
       and a.activity_type in ('status_change', 'field_change')
  ),
  -- massändringar (import, fördelning) räknas inte: fler än 5 statusbyten av samma person inom en minut
  bulk as (
    select actor_user_id, date_trunc('minute', occurred_at) minut, count(*) n
      from akt where activity_type = 'status_change' group by 1, 2
  ),
  kont as (
    select a.actor_user_id saljare,
           case when a.metadata->>'to' in ('sald', 'scrive') then 'salj'
                when a.metadata->>'to' = 'aterkoppling' then 'aterkoppling'
                when a.metadata->>'to' = 'inte_hemma' then 'ej_hemma' else 'nej' end utfall
      from akt a join bulk b on b.actor_user_id = a.actor_user_id and b.minut = date_trunc('minute', a.occurred_at)
     where a.activity_type = 'status_change' and b.n <= 5
       and a.metadata ? 'to' and a.metadata->>'kalla' is null
       and a.metadata->>'to' in ('sald', 'scrive', 'aterkoppling', 'inte_hemma', 'inte_saljbar', 'inte_intresserad', 'kall_kund', 'befintlig_telia', 'intresserad')
    union all
    -- knackningar (Inte hemma igen) utan statusbyte i samma stund
    select a.actor_user_id, 'ej_hemma'
      from akt a
     where a.activity_type = 'field_change' and a.metadata->>'field' = 'antal_knackningar'
       and not exists (select 1 from akt b where b.record_id = a.record_id and b.activity_type = 'status_change'
                         and b.actor_user_id = a.actor_user_id and b.occurred_at between a.occurred_at - interval '2 minutes' and a.occurred_at + interval '2 minutes')
  ),
  k as (
    select kont.saljare, count(*)::int kontakter,
           count(*) filter (where utfall = 'salj')::int salj,
           count(*) filter (where utfall = 'aterkoppling')::int aterkoppling,
           count(*) filter (where utfall = 'nej')::int nej,
           count(*) filter (where utfall = 'ej_hemma')::int ej_hemma
      from kont group by kont.saljare
  ),
  s as (
    select salda.saljare, sum(salda.pinnar) pinnar, count(*)::int kunder, sum(salda.avtal)::int tjanster, max(salda.avtal)::int max_tjanster
      from salda group by salda.saljare
  ),
  smax as (
    select distinct on (salda.saljare) salda.saljare, salda.id, salda.d->>'kund_namn' kund
      from salda order by salda.saljare, salda.avtal desc, salda.id
  ),
  av as (
    select a.saljare, count(*) filter (where a.kategori = 'matchad')::int matchade,
           count(*) filter (where a.kategori = 'avvikande')::int avvikande,
           count(*) filter (where a.kategori = 'endast_saljare')::int endast_saljare
      from d2d_telia_avstamning a
     where a.tenant_id = p_tenant and a.manad = v_m and a.aktuell and a.lagenhet_id is not null
     group by a.saljare
  ),
  alla as (
    select s.saljare from s union select k.saljare from k
  )
  select alla.saljare, coalesce(s.pinnar, 0), coalesce(s.kunder, 0), coalesce(s.tjanster, 0), coalesce(s.max_tjanster, 0),
         smax.kund, smax.id,
         coalesce(k.kontakter, 0), coalesce(k.salj, 0), coalesce(k.aterkoppling, 0), coalesce(k.nej, 0), coalesce(k.ej_hemma, 0),
         coalesce(av.matchade, 0), coalesce(av.avvikande, 0), coalesce(av.endast_saljare, 0),
         exists (select 1 from d2d_telia_fil f where f.tenant_id = p_tenant and f.manad = v_m)
    from alla
    left join s on s.saljare is not distinct from alla.saljare
    left join smax on smax.saljare is not distinct from alla.saljare
    left join k on k.saljare is not distinct from alla.saljare
    left join av on av.saljare is not distinct from alla.saljare;
end $$;
revoke all on function public.d2d_nyckeltal_rader(uuid, date) from public, anon, authenticated;

/** Nyckeltal för månaden och föregående månad, per säljare och för teamet. Admin/ledning/kundtjänst
 *  ser alla; andra ser bara sin egen rad. */
create or replace function public.d2d_nyckeltal_manad(p_manad date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t uuid := my_tenant_id(); v_m date := date_trunc('month', coalesce(p_manad, (now() at time zone 'Europe/Stockholm')::date))::date;
        v_f date; v_alla boolean := d2d_telia_behorig(); v jsonb; v_nu jsonb; v_fo jsonb;
begin
  v_f := (v_m - interval '1 month')::date;
  select coalesce(jsonb_agg(to_jsonb(x.*)), '[]'::jsonb) into v_nu from d2d_nyckeltal_rader(v_t, v_m) x;
  select coalesce(jsonb_agg(to_jsonb(x.*)), '[]'::jsonb) into v_fo from d2d_nyckeltal_rader(v_t, v_f) x;
  with nu as (select e from jsonb_array_elements(v_nu) e),
       fo as (select e from jsonb_array_elements(v_fo) e),
       ids as (select nullif(nu.e->>'saljare', '')::uuid saljare from nu union select nullif(fo.e->>'saljare', '')::uuid from fo),
       rad as (
         select ids.saljare,
                (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = ids.saljare) namn,
                (select nu.e - 'saljare' from nu where nullif(nu.e->>'saljare', '')::uuid is not distinct from ids.saljare) nu,
                (select fo.e - 'saljare' from fo where nullif(fo.e->>'saljare', '')::uuid is not distinct from ids.saljare) forra
           from ids
       ),
       summa as (
         select m.m, jsonb_build_object(
           'pinnar', coalesce(sum((x.e->>'pinnar')::numeric), 0), 'kunder', coalesce(sum((x.e->>'kunder')::int), 0),
           'tjanster', coalesce(sum((x.e->>'tjanster')::int), 0), 'max_tjanster', coalesce(max((x.e->>'max_tjanster')::int), 0),
           'max_kund', (array_agg(x.e->>'max_kund' order by (x.e->>'max_tjanster')::int desc nulls last))[1],
           'max_lagenhet', (array_agg(x.e->>'max_lagenhet' order by (x.e->>'max_tjanster')::int desc nulls last))[1],
           'kontakter', coalesce(sum((x.e->>'kontakter')::int), 0), 'salj', coalesce(sum((x.e->>'salj')::int), 0),
           'aterkoppling', coalesce(sum((x.e->>'aterkoppling')::int), 0), 'nej', coalesce(sum((x.e->>'nej')::int), 0),
           'ej_hemma', coalesce(sum((x.e->>'ej_hemma')::int), 0), 'matchade', coalesce(sum((x.e->>'matchade')::int), 0),
           'avvikande', coalesce(sum((x.e->>'avvikande')::int), 0), 'endast_saljare', coalesce(sum((x.e->>'endast_saljare')::int), 0),
           'har_fil', exists (select 1 from d2d_telia_fil f where f.tenant_id = v_t and f.manad = m.m)) j
           from (values (v_m, v_nu), (v_f, v_fo)) m(m, rows)
           left join lateral jsonb_array_elements(m.rows) x(e) on true
          group by m.m
       )
  select jsonb_build_object(
    'manad', v_m, 'forra', v_f, 'alla', v_alla,
    'saljare', coalesce((select jsonb_agg(jsonb_build_object('id', rad.saljare, 'namn', coalesce(rad.namn, 'Ingen säljare'), 'nu', rad.nu, 'forra', rad.forra)
                                          order by coalesce((rad.nu->>'pinnar')::numeric, 0) desc, rad.namn)
                           from rad where v_alla or rad.saljare = auth.uid()), '[]'::jsonb),
    'team', case when v_alla then jsonb_build_object('nu', (select j from summa where m = v_m), 'forra', (select j from summa where m = v_f)) end,
    'filer', coalesce((select jsonb_agg(f.manad order by f.manad desc) from d2d_telia_fil f where f.tenant_id = v_t), '[]'::jsonb))
  into v;
  return v;
end $$;
revoke all on function public.d2d_nyckeltal_manad(date) from public, anon;
grant execute on function public.d2d_nyckeltal_manad(date) to authenticated;

-- ── 6. Påminnelse den 15:e ────────────────────────────────────────────────────
/** Vad edge function d2d-telia-paminnelse ska skicka: från den 15:e, för föregående månad, om
 *  ingen fil laddats upp och mottagaren inte redan fått mejlet. */
create or replace function public.d2d_telia_paminnelse_underlag(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_idag date := (now() at time zone 'Europe/Stockholm')::date; v_m date;
begin
  v_m := (date_trunc('month', v_idag) - interval '1 month')::date;
  return jsonb_build_object(
    'idag', v_idag, 'manad', v_m,
    'harFil', exists (select 1 from d2d_telia_fil f where f.tenant_id = p_tenant and f.manad = v_m),
    'mottagare', case when extract(day from v_idag) >= 15
                        and not exists (select 1 from d2d_telia_fil f where f.tenant_id = p_tenant and f.manad = v_m)
                      then coalesce((select jsonb_agg(m.epost) from d2d_telia_paminnelse_mottagare m
                                      where m.tenant_id = p_tenant
                                        and not exists (select 1 from d2d_telia_paminnelse p where p.tenant_id = p_tenant and p.manad = v_m and p.epost = m.epost)), '[]'::jsonb)
                      else '[]'::jsonb end);
end $$;
revoke all on function public.d2d_telia_paminnelse_underlag(uuid) from public, anon, authenticated;
grant execute on function public.d2d_telia_paminnelse_underlag(uuid) to service_role;

create or replace function public.d2d_telia_paminnelse_klar(p_tenant uuid, p_manad date, p_epost text[])
returns void language sql security definer set search_path = public as $$
  insert into public.d2d_telia_paminnelse (tenant_id, manad, epost)
  select p_tenant, p_manad, e from unnest(p_epost) e
  on conflict do nothing
$$;
revoke all on function public.d2d_telia_paminnelse_klar(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.d2d_telia_paminnelse_klar(uuid, date, text[]) to service_role;

-- Cron: den 15:e kl 06:30 UTC (07:30/08:30 svensk tid) + reserv den 16:e (databasen hindrar dubbelsändning).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'd2d-telia-paminnelse') then
      perform cron.schedule('d2d-telia-paminnelse', '30 6 15,16 * *', $c$
        select net.http_post(
          url := 'https://gpxwfboyjwcaqeinxxwr.supabase.co/functions/v1/d2d-telia-paminnelse',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'mail_sync_cron_token')),
          body := '{}'::jsonb,
          timeout_milliseconds := 60000);
      $c$);
    end if;
  end if;
end $$;
