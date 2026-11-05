-- Säljprocess: kontaktytor för befintliga kunder (Gustav 5 nov 2026).
--
-- En kontakt (objekttyp contact) hör till ett eller flera bolag (koncernmoder, direktägt bolag,
-- förvaltningsbolag) och har en eller flera kontaktytor ur en fast lista:
--   Bostadsförvaltare, Kommersiell förvaltare, Teknisk förvaltare, Avtalskontakt, Ansvarig förvaltare,
--   Kontakt för avisering, Infomail (info@), Teknisk ansvarig, Ombud hyresförhandling
-- plus en fritext ("Annan kontaktyta") som sparas på kontakten men aldrig läggs till i listan.
--
-- Kontakterna ärvs: kontaktytor_for_post(id) går från valfri post (affär, affärsmöjlighet, leverans,
-- onboarding, uppstartsmöte, hyresförhandling, appleverans, ärende, leveransöversikt, D2D-fastighet,
-- direktägt bolag …) uppåt via relationerna till bolagen och returnerar bolagens kontakter.
-- Kontaktrelationerna blir många-till-många så samma person kan höra till dubbletter av en kund.
-- Idempotent.

-- ── 1. Fält ───────────────────────────────────────────────────────────────
do $$
declare t record; v_c uuid; v_km uuid;
begin
  for t in select id from tenants loop
    select id into v_c  from object_definitions where tenant_id = t.id and key = 'contact';
    select id into v_km from object_definitions where tenant_id = t.id and key = 'koncernmoder';
    continue when v_c is null;

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility, help_text)
    select v_c, t.id, f.key, f.label, f.typ, false, f.opt::jsonb, f.sort, 'all', f.help
      from (values
        ('kontaktytor', 'Kontaktytor', 'multi_select', '{"_column":true,"_column_order":1,"choices":[
            {"key":"bostadsforvaltare","label":"Bostadsförvaltare"},
            {"key":"kommersiell_forvaltare","label":"Kommersiell förvaltare"},
            {"key":"teknisk_forvaltare","label":"Teknisk förvaltare"},
            {"key":"avtalskontakt","label":"Avtalskontakt"},
            {"key":"ansvarig_forvaltare","label":"Ansvarig förvaltare"},
            {"key":"avisering","label":"Kontakt för avisering"},
            {"key":"infomail","label":"Infomail (info@)"},
            {"key":"teknisk_ansvarig","label":"Teknisk ansvarig"},
            {"key":"ombud_hyresforhandling","label":"Ombud hyresförhandling"}]}', 15,
         'Vilka frågor kontakten ska ha. Ärvs till affär, leverans och alla processer för bolaget.'),
        ('kontaktyta_fritext', 'Annan kontaktyta', 'text', '{}', 16,
         'Fritext när ingen kontaktyta i listan passar. Läggs inte till i listan.')
      ) as f(key, label, typ, opt, sort, help)
     where not exists (select 1 from field_definitions x where x.object_id = v_c and x.key = f.key);

    -- Den gamla rollistan (beslutsfattare …) ersätts av kontaktytorna. Inga kontakter finns ännu.
    update field_definitions set visibility = 'hidden'
     where object_id = v_c and key = 'roll' and visibility <> 'hidden';
    update field_definitions set label = 'Titel'
     where object_id = v_c and key = 'role_title' and label = 'Roll/Titel';

    insert into field_definitions (object_id, tenant_id, key, label, field_type, is_required, options, sort_order, visibility)
    select v_km, t.id, 'vaxelnummer', 'Växelnummer', 'phone', false, '{"section":"kontaktinfo"}'::jsonb, 92, 'all'
     where v_km is not null and not exists (select 1 from field_definitions x where x.object_id = v_km and x.key = 'vaxelnummer');
  end loop;
end $$;

-- ── 2. En kontakt kan höra till flera bolag (dubbletter, koncern + förvaltare) ──
update relationship_definitions set cardinality = 'many_to_many'
 where rel_type in ('contact_of', 'contact_of_db', 'contact_of_fb') and cardinality <> 'many_to_many';

-- ── 3. Kontaktytor för en post: bolagen uppåt i kedjan och deras kontakter ──
create or replace function public.kontaktytor_for_post(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  v_t uuid; v_typ text; v_agare uuid; v_bolag uuid[]; v_res jsonb;
begin
  select tenant_id, object_type, owner_user_id into v_t, v_typ, v_agare from records where id = p_id and deleted_at is null;
  if v_t is null or v_t <> my_tenant_id() or not d2d_kan_lasa(p_id, v_typ, v_agare)
     or not can_do('contact', 'read') then
    return jsonb_build_object('bolag', '[]'::jsonb, 'kontakter', '[]'::jsonb);
  end if;

  -- Gå uppåt längs utgående relationer (högst tre steg) tills ett bolag nås.
  -- In i fastigheter går vi aldrig (affärer och leveranser har egna bolagsrelationer); från en fastighet går det.
  with recursive kedja(id, typ, djup) as (
    select p_id, v_typ, 0
    union
    select x.id, x.object_type, k.djup + 1
      from kedja k
      join relationships r on r.from_record_id = k.id
      join records x on x.id = r.to_record_id and x.deleted_at is null and x.tenant_id = v_t
     where k.djup < 3
       and k.typ <> 'koncernmoder'
       and (k.typ not in ('direktagt_bolag', 'forvaltningsbolag') or x.object_type = 'koncernmoder')
       and x.object_type <> 'property'
       and x.object_type not in ('contact', 'd2d_lagenhet', 'user')
  ),
  bolag as (
    select id from kedja where typ in ('koncernmoder', 'direktagt_bolag', 'forvaltningsbolag')
    union
    -- På koncernmodern: även kontakter på dess direktägda bolag och förvaltningsbolag.
    select r.from_record_id from relationships r
     where v_typ = 'koncernmoder' and r.to_record_id = p_id and r.rel_type in ('direktagt_av', 'forvaltning_av')
  )
  select array_agg(id) into v_bolag from bolag;

  select jsonb_build_object(
    'bolag', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'namn', b.title, 'typ', b.object_type)
                         order by case b.object_type when 'koncernmoder' then 0 when 'direktagt_bolag' then 1 else 2 end, b.title)
                         from records b where b.id = any(coalesce(v_bolag, '{}')) and b.deleted_at is null), '[]'::jsonb),
    'kontakter', coalesce((select jsonb_agg(k.j order by k.sort, k.namn) from (
        select jsonb_build_object(
                 'id', c.id, 'namn', c.data->>'name', 'titel', c.data->>'role_title',
                 'telefon', c.data->>'phone', 'epost', c.data->>'email',
                 'kontaktytor', coalesce(c.data->'kontaktytor', '[]'::jsonb),
                 'fritext', c.data->>'kontaktyta_fritext', 'notering', c.data->>'bra_att_veta',
                 'bolag', (select jsonb_agg(jsonb_build_object('id', b.id, 'namn', b.title, 'typ', b.object_type, 'rel', r2.rel_type) order by b.title)
                             from relationships r2 join records b on b.id = r2.to_record_id and b.deleted_at is null
                            where r2.from_record_id = c.id and r2.rel_type in ('contact_of', 'contact_of_db', 'contact_of_fb'))) as j,
               c.data->>'name' as namn,
               case when jsonb_array_length(coalesce(c.data->'kontaktytor', '[]'::jsonb)) > 0 then 0 when c.data->>'kontaktyta_fritext' is not null then 1 else 2 end as sort
          from records c
         where c.object_type = 'contact' and c.deleted_at is null and c.tenant_id = v_t
           and exists (select 1 from relationships r where r.from_record_id = c.id
                        and r.rel_type in ('contact_of', 'contact_of_db', 'contact_of_fb')
                        and r.to_record_id = any(coalesce(v_bolag, '{}')))
      ) k), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

revoke all on function public.kontaktytor_for_post(uuid) from public, anon;
grant execute on function public.kontaktytor_for_post(uuid) to authenticated;
