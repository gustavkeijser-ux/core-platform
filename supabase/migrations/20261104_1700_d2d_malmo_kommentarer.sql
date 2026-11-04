-- D2D: kommentarer och status från telefonlistan "In i CRM Skåne" (Gustav 4 nov) in på
-- projektet Malmö/Lund. Adresserna fanns redan och var utdelade; här läggs bara kommentar
-- och status in.
--
-- 95 rader med kommentar på 6 fastigheter (Stettin 21, Beckasinen 9, Tärningholm 10,
-- Hillebarden 2, Björnen 20, Fersen 3). Matchning per fastighet: Telias punkt-id när
-- listan har det, annars gata + gatunummer + ingång + lgh-nummer.
--  * Kommentaren skrivs in (läggs sist om lägenheten redan har en annan kommentar).
--  * Status ändras bara på de 9 rader där listan har uttrycklig status, och bara om
--    lägenheten fortfarande är Ej knackad:
--      - 6 "Återkoppling" → Återkoppling, ligger kvar hos adressens säljare.
--      - 3 namngivna → Återkoppling, delas ut till den namngivna säljaren:
--        Bergsgatan 25 lgh 1501 och Monbijougatan 7 lgh 1201 → Jacob,
--        Mariedalsvägen 45 A lgh 1202 → Anton Häggberg.
--  * Rader märkta "Ej Knackad" får bara kommentaren (status oförändrad, enligt Gustav).
-- d2d.import = 1 så att inga mejl/notiser går ut. Idempotent.
do $do$
declare
  v_fast constant uuid[] := array[
    '254c6d08-4ee4-4bdb-b84d-aa3a6f447fcf',  -- Stettin 21
    '65133096-c109-4180-9a92-2adfa89ef8d7',  -- Beckasinen 9
    'a25d5824-f05e-420a-bdb0-f7b75ae1d7ca',  -- Tärningholm 10
    'd549de98-06c5-4b3b-95c3-180b24a0c0b3',  -- Hillebarden 2
    'b36d4e63-35a5-443e-a52b-38d7964b66e6',  -- Björnen 20
    '023cea30-0610-433f-b4be-5b8cbcebd5ac']::uuid[];  -- Fersen 3
  v_rad jsonb; v_id uuid; v_r records%rowtype; v_ny jsonb; v_agare uuid;
  v_kom int := 0; v_st int := 0; v_saknas int := 0; v_status_ej int := 0;
begin
  perform set_config('d2d.import', '1', true);
  for v_rad in select * from jsonb_array_elements($j$[
{"rad":43,"g":"Bergsgatan","n":"25","lgh":"1101","p":"163896628","k":"Sanaa Abou Hassan, inget nummer"},
{"rad":44,"g":"Bergsgatan","n":"25","lgh":"1102","p":"163896629","k":"Sara Cristianson, 076-006 85 76, es, bor i halmsta, så fel nummer"},
{"rad":45,"g":"Bergsgatan","n":"25","lgh":"1103","p":"161759559","k":"Ingen skriven online"},
{"rad":46,"g":"Bergsgatan","n":"25","lgh":"1104","p":"163460739","k":"Linnéa Lindberg, 070-865 85 55, es, es, bunden sen januari"},
{"rad":47,"g":"Bergsgatan","n":"25","lgh":"1105","p":"163896630","k":"Ingen skriven online"},
{"rad":48,"g":"Bergsgatan","n":"25","lgh":"1201","p":"163896631","k":"Tiffany Vajda, inget nummer, telia 300 1 år"},
{"rad":49,"g":"Bergsgatan","n":"25","lgh":"1202","p":"163896632","k":"Amanda Fors, 073-568 68 86, es, es"},
{"rad":50,"g":"Bergsgatan","n":"25","lgh":"1203","p":"156023562","k":"Ferdi Saliji, inget nummer"},
{"rad":51,"g":"Bergsgatan","n":"25","lgh":"1204","p":"153297660","k":"Mari-Louise Frej, 072-888 34 31, gammal dam kan inget, sonen har koll på allt, betalar till han, mbb, det är 3 med extra sim kort som hon fått i router, data kort, ska ringa sonen, Philip, 0733761515, hon betalar 99 kr obegränsat, använder knappt nätverk, inte värt med fiber"},
{"rad":52,"g":"Bergsgatan","n":"25","lgh":"1205","p":"161858157","k":"Lillemor Anita Nilsson, inget nummer"},
{"rad":53,"g":"Bergsgatan","n":"25","lgh":"1301","p":"163566915","k":"Sophie Thörnlund, 073-803 07 44, 16:30 ring nu, sitter i massa möten och trodde att jag var budbärare som hon väntade på, bott ett tag, mbb alltid haft, hon älskar det och tar med det ofta, på semester alltid med det, tänker inte byta till fiber för hon vill flytta med det. 199 kr månaden"},
{"rad":54,"g":"Bergsgatan","n":"25","lgh":"1302","p":"163896633","k":"Jonas André Nilsson, 070-889 08 16, es, es, beställde i juni fiber, bahnoff, egen router, 300 eller 600 hastighet, mellan 4-430 kr, streamar, vardagsanvänding, jobbar lite hemifrån, spelar datorspel ibland, 469 kr, 250 mbit"},
{"rad":55,"g":"Bergsgatan","n":"25","lgh":"1303","p":"163896634","k":"Daniel Wendenburg, 073-949 52 38, es,es, es, es"},
{"rad":56,"g":"Bergsgatan","n":"25","lgh":"1304","p":"163896635","k":"Lisa Andersson, inget nummer"},
{"rad":57,"g":"Bergsgatan","n":"25","lgh":"1305","p":"163896636","k":"Yassin Salim Salah, inget nummer"},
{"rad":58,"g":"Bergsgatan","n":"25","lgh":"1401","p":"112928256","k":"Salma Nora Salm, inget nummer"},
{"rad":59,"g":"Bergsgatan","n":"25","lgh":"1402","p":"163896637","k":"Elizabet Pajor, 040-6112053, 070 790 29 16, kompis ringde växel, tele 2 på mbb, bott 45 år, 479 kr, routern lånad av tele 2, ska inte vara bunden"},
{"rad":60,"g":"Bergsgatan","n":"25","lgh":"1403","p":"163896638","k":"Ingen skriven online"},
{"rad":61,"g":"Bergsgatan","n":"25","lgh":"1404","p":"163896639","k":"Sven Åke Andersson, 076-883 03 99, es, es, es"},
{"rad":62,"g":"Bergsgatan","n":"25","lgh":"1405","p":"161705771","k":"Ingen skriven online, telia 300 1 år"},
{"rad":63,"g":"Bergsgatan","n":"25","lgh":"1501","p":"153294359","k":"Hamda Mohamed Dubad, 0722585229, detta är rätt nummer, bott här i 3 år, har mbb idag, haft i 2 år, sonen spelar, 3 idag, 4-500, äger router, sambon måste hem såklat och prata om det, hans dotter står på det, bodde här innan, 429 kr, kommer hem senare i veckan, hamda_dubad@icloud.com, mail skickat, 06/15 es, ringde upp mig men jag var i samtal då, 06/17 es, 06/18 es, 06/30, barn överallt, Mattias som står på lägenheten måste jag prata med","s":"aterkoppling","sa":"393256b0-a7dc-4640-8233-696b07079321"},
{"rad":64,"g":"Bergsgatan","n":"25","lgh":"1502","p":"163896640","k":"Jan-Nadi Shadida, inget nummer"},
{"rad":65,"g":"Bergsgatan","n":"25","lgh":"1503","p":"112928258","k":"Kushtrim Pefqeli, inget nummer går till honom"},
{"rad":66,"g":"Bergsgatan","n":"25","lgh":"1504","p":"154623916","k":"Naser Lutfi Ata Al Saied, inget nummer"},
{"rad":67,"g":"Bergsgatan","n":"25","lgh":"1505","p":"163896641","k":"Sebastian Östberg, inget nummer"},
{"rad":68,"g":"Bergsgatan","n":"25","lgh":"1506","p":"158330782","k":"Ingen skriven online"},
{"rad":69,"g":"Bergsgatan","n":"25","lgh":"1602","p":"163896642","k":"Ingen skriven online"},
{"rad":70,"g":"Monbijougatan","n":"7","lgh":"1001","p":"163896612","k":"Ingen skriven online"},
{"rad":71,"g":"Monbijougatan","n":"7","lgh":"1101","p":"163896613","k":"Jan Einar Herlin, inget nummer"},
{"rad":72,"g":"Monbijougatan","n":"7","lgh":"1102","p":"153297684","k":"Halil Kanat, inget nummer"},
{"rad":73,"g":"Monbijougatan","n":"7","lgh":"1201","p":"163896614","k":"Hinda Mohamed, 076-073 80 55, inga abonent, trodde jag hette hampus, november 1 år, har mbb tankar varje månad via comviq, 399 kr varje månad, vill inte vara bunden säger hon, aldrig varit bunden förut, trodde att wifi skulle ingå i hyran, fick mitt nummer av grannen","s":"aterkoppling","sa":"393256b0-a7dc-4640-8233-696b07079321"},
{"rad":74,"g":"Monbijougatan","n":"7","lgh":"1202","p":"163896615","k":"Younis Yousef Hilaaie, 072-727 28 59, inte i bruk"},
{"rad":75,"g":"Monbijougatan","n":"7","lgh":"1301","p":"117047811","k":"Anton Kadieva, inget nummer"},
{"rad":76,"g":"Monbijougatan","n":"7","lgh":"1302","p":"163560853","k":"Julia Wennerholm, inget nummer"},
{"rad":77,"g":"Monbijougatan","n":"9","lgh":"1002","p":"162344315","k":"Alhassane Toure, inget nummer"},
{"rad":78,"g":"Monbijougatan","n":"9","lgh":"1101","p":"163896616","k":"Alexandros Strologkas, inget nummer"},
{"rad":79,"g":"Monbijougatan","n":"9","lgh":"1102","p":"153287548","k":"Sofie Hallgren, inget nummer"},
{"rad":80,"g":"Monbijougatan","n":"9","lgh":"1201","p":"163896617","k":"Ingen skriven online"},
{"rad":81,"g":"Monbijougatan","n":"9","lgh":"1202","p":"117047833","k":"Martin Joshua Højelsen, inget nummer"},
{"rad":82,"g":"Monbijougatan","n":"9","lgh":"1301","p":"161605633","k":"Erik Christer Helgesson, 072-723 95 33, ringt en gång, scrive skickad, mbb telia igår, skånskan var helt sjuk, kunde inte ens höra mailadressen så han fick skicka all info när vi hade lagt på"},
{"rad":83,"g":"Monbijougatan","n":"9","lgh":"1302","p":"153286430","k":"Maxine Bergwall, 070-045 35 45, ringt en gång, ingen CPE, hör av sig till mig när hon fått tid bokad med tekniker, scrive skickad"},
{"rad":84,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1101","p":"161427655","k":"Lisette Bodensjö, 073-360 81 33, ringt en gång, svarade att hon vill ha sms"},
{"rad":85,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1102","p":"163896647","k":"Karl Axel Vesterlund, 070-683 37 08, ringt två gånger+sms, gammal skulle iväg ringer imorgon igen"},
{"rad":86,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1103","p":"163896648","k":"Ruben Stjernfeldt, inget nummer,es"},
{"rad":87,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1104","p":"155365289","k":"Paul Eriksson, inget nummer"},
{"rad":88,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1201","p":"163896649","k":"Filip Skallberg, 073-395 10 52, ringt två gånger+sms , es"},
{"rad":89,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1202","p":"112757302","k":"Gustav Håkansson, 073-339 33 83, ring vid 15, mitt i möte nu, mbb via tre idag, funkar bra men ska byta över till fiber, ska se vad, lång bindningstid messar när Olle","s":"aterkoppling","sa":"36813fae-466d-42d7-9a60-bb9ca2b7af4b"},
{"rad":90,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1203","p":"163896650","k":"Ingen skriven online"},
{"rad":91,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1204","p":"162113587","k":"Mikael Jebril, 073-658 76 18, ingen abbonent"},
{"rad":92,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1301","p":"112757315","k":"Maja Lofteskog, 073-974 48 40, ms direkt så lämnar sms"},
{"rad":93,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1302","p":"163896651","k":"Jonas Flaum, inget nummer"},
{"rad":94,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1303","p":"163896652","k":"Richard Jacob, inget nummer"},
{"rad":95,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1304","p":"112757305","k":"Karin Elisabet Sandrina Racz, inget nummer"},
{"rad":96,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1401","p":"158483155","k":"Stuart John Cosgrave, 073-543 35 76, ringt två gånger+sms, höras imorgon vid 14:00"},
{"rad":97,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1402","p":"163896653","k":"Roger Antonsson, 076-409 50 51, klickade mig direkt, skickade sms, ringde upp, minns inte till 100% vad som hände men tror mbb bunden men vet ej helt så jag inte skrev något...."},
{"rad":98,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1403","p":"112757313","k":"Ingen skriven online"},
{"rad":99,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1404","p":"112757310","k":"Nanna Rosenkjaer, 076-555 45 06, mbb idag, ca 400kr, obunden comviq, tycker det funkar utmärkt, använder inte mycket, känern att det blir massa krångel för henne, kanske byggde upp helt fel och var för pushig"},
{"rad":100,"g":"Mariedalsvägen","n":"45","i":"A","lgh":"1501","p":"153295739","k":"Dan Rosén, 070-940 55 40, 80 år är absolut inte sugen på ett byte, har lärt sig allt äntligen asså fan vad händer"},
{"rad":101,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1101","p":"159379302","k":"Margareta Björk, 070-795 55 09, ringt två gånger+sms, es, redan bra lösning"},
{"rad":102,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1102","p":"163896654","k":"Czeslaw Dziamalek, inget nummer"},
{"rad":103,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1103","p":"163896655","k":"Ingen skriven online"},
{"rad":104,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1104","p":"163896656","k":"Kashif Naveed Bhatti, inget nummer"},
{"rad":105,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1201","p":"163548516","k":"Mariell Bodensjö, 070-818 33 57, ringt två gånger+sms, ringer mig torsdag 25/6, är i stockholm just nu, telia 300 1 år"},
{"rad":106,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1202","p":"112757325","k":"Christina Weibull, 89 år, kommer ej ringa"},
{"rad":107,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1203","p":"163896657","k":"Ingen skriven online"},
{"rad":108,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1204","p":"112757323","k":"Janet Ingela Rosalie Johansson, 076-415 98 11, ringt en gång"},
{"rad":109,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1301","p":"153282786","k":"Anne Nilsson, 070-655 25 09, ringt en gång, es"},
{"rad":110,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1302","p":"163896658","k":"Ingen skriven online"},
{"rad":111,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1303","p":"156634804","k":"Ingen skriven online"},
{"rad":112,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1304","p":"112757327","k":"Inger Margareta Eriksson, 070-816 56 40, sonen ska ringa upp mig, han står på bredbandet, hon vet inte ens vad det kostar","s":"aterkoppling"},
{"rad":113,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1401","p":"112757333","k":"Ingen skriven online"},
{"rad":114,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1402","p":"159264703","k":"Lars Nilsson, inget nummer"},
{"rad":115,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1403","p":"161605611","k":"Amina Abu Asab, inget nummer, anton pratat med, vet exakt vad vi erbjuder, 070-260 46 59, tror han ska aktivera fiber men oklart","s":"aterkoppling"},
{"rad":116,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1404","p":"163896659","k":"Nellie Lamréus, 073-581 13 62, ingen abb, sa upp mbb på egen hand, ringde växel när han var utan internet, scrive skickad, ville ha det påslaget asap vilket jag ej kunde lova"},
{"rad":117,"g":"Mariedalsvägen","n":"45","i":"B","lgh":"1501","p":"112757336","k":"Christina Lells, 073-097 00 93, es"},
{"rad":135,"g":"ALLHEMSGATAN","n":"5","i":"B","lgh":"1003","p":"134885138","k":"han svarade, sa att han inte har fått någon installation sedan la han på direkt"},
{"rad":146,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1101","k":"Taibe Senghore, 072-324 05 14, kan ej kopplas fram"},
{"rad":147,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1102","k":"Sandra Löfgren, inget nummer"},
{"rad":148,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1201","k":"Michael Protos, 072-207 17 50, tele2 mbb idag, försöke inte sälja något alls, ringer och säljer sen när vi har Telia","s":"aterkoppling"},
{"rad":149,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1202","k":"Yvonne Hufvudsson, inget nummer"},
{"rad":150,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1301","k":"Jasmine Ekberg, 070-238 39 95, ringt+sms"},
{"rad":151,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1302","k":"Sandy Ljunglöf, 073-968 20 95, direkt till ms, lämnar sms"},
{"rad":152,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1401","k":"Kasper Polk Gramstrup, inget nummer"},
{"rad":153,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1402","k":"Nathalie Delalle, inget nummer, har tele service, sälj, engelska"},
{"rad":154,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1403","k":"Ingen skriven online"},
{"rad":155,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1501","k":"Clara Ljungsvik, 070-942 68 30, ringt+sms"},
{"rad":156,"g":"DAVIDSHALLSGATAN","n":"22","lgh":"1502","k":"Ingen skriven online"},
{"rad":157,"g":"SÖDRA FÖRSTADSGATAN","n":"23","i":"B","lgh":"LGH","k":"Företag"},
{"rad":158,"g":"NORRA VALLGATAN","n":"32","lgh":"LGH","k":"Henryk Jan Maciejewski, inget nummer"},
{"rad":159,"g":"ÖSTERGATAN","n":"25","lgh":"1101","k":"Delia Vercelli, 073-589 94 88, ringt+sms, använder bara mobil, försökte inte sälja, har telenor på telefonen, obegränsat, kommer sälja telia mobil och fiber på denna","s":"aterkoppling"},
{"rad":160,"g":"ÖSTERGATAN","n":"25","lgh":"1102","k":"Emmelie Lundin, 073-342 01 13, tele2 koax idag, obundet, hon jobbar med tjejen ovan, de satt tillsammans, ring under nästa vecka när vi har fått Telia, vill ha mobil, tv och bredband via fibern, jättebra kontakt med denna Anton","s":"aterkoppling"},
{"rad":161,"g":"ÖSTERGATAN","n":"25","lgh":"1201","k":"Emma Larsson, 076-782 64 42, ringt+sms, använder teleservice, scrive skickad"},
{"rad":162,"g":"ÖSTERGATAN","n":"25","lgh":"1202","k":"Ingen skriven online"},
{"rad":163,"g":"ÖSTERGATAN","n":"25","lgh":"1301","k":"Robert Jönsson, 073-697 37 75, la på och var tyst, sen la han på, lämnat sms, har 3 mbb, han vill höras igen senare, intresserad","s":"aterkoppling"},
{"rad":164,"g":"ÖSTERGATAN","n":"25","lgh":"1302","k":"Tomas Årnell, 070-620 30 85 , Erika Huerta Ogalde 070-614 92 18 , Hilda Årnell , 070-723 27 74, använder teleservice"}
]$j$::jsonb)
  loop
    select l.id into v_id
      from relationships rl
      join records l on l.id = rl.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
     where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = any(v_fast)
       and (case when v_rad->>'p' is not null then l.data->>'punkt_id' = v_rad->>'p'
            else lower(l.data->>'gatunamn') = lower(v_rad->>'g')
             and l.data->>'gatunummer' = v_rad->>'n'
             and upper(coalesce(l.data->>'ingang', '')) = upper(coalesce(v_rad->>'i', ''))
             and upper(l.data->>'name') = upper(v_rad->>'lgh') end)
     limit 1;
    if v_id is null and v_rad->>'p' is not null then
      -- punkt-id saknas i CRM: försök med adressen
      select l.id into v_id
        from relationships rl
        join records l on l.id = rl.from_record_id and l.deleted_at is null and l.object_type = 'd2d_lagenhet'
       where rl.rel_type = 'd2d_lag_fastighet' and rl.to_record_id = any(v_fast)
         and lower(l.data->>'gatunamn') = lower(v_rad->>'g') and l.data->>'gatunummer' = v_rad->>'n'
         and upper(coalesce(l.data->>'ingang', '')) = upper(coalesce(v_rad->>'i', ''))
         and upper(l.data->>'name') = upper(v_rad->>'lgh')
       limit 1;
    end if;
    if v_id is null then
      v_saknas := v_saknas + 1;
      raise notice 'Hittar inte rad % (% % % lgh %)', v_rad->>'rad', v_rad->>'g', v_rad->>'n', coalesce(v_rad->>'i', ''), v_rad->>'lgh';
      continue;
    end if;

    select * into v_r from records where id = v_id for update;
    v_ny := '{}'::jsonb;
    if position(v_rad->>'k' in coalesce(v_r.data->>'kommentar', '')) = 0 then
      v_ny := jsonb_build_object('kommentar',
        case when nullif(btrim(coalesce(v_r.data->>'kommentar', '')), '') is null then v_rad->>'k'
             else (v_r.data->>'kommentar') || E'\n\n' || (v_rad->>'k') end);
      v_kom := v_kom + 1;
    end if;

    v_agare := v_r.owner_user_id;
    if v_rad->>'s' is not null and v_r.status = 'ej_knackad' then
      if v_rad->>'sa' is not null then
        v_ny := v_ny || jsonb_build_object('saljare', v_rad->>'sa');
        v_agare := (v_rad->>'sa')::uuid;
      end if;
      update records set status = v_rad->>'s', data = data || v_ny, owner_user_id = v_agare, updated_at = now()
       where id = v_id;
      v_st := v_st + 1;
    elsif v_rad->>'s' is not null and v_r.status <> v_rad->>'s' then
      v_status_ej := v_status_ej + 1;
      raise notice 'Rad %: status redan % i CRM, rörs inte', v_rad->>'rad', v_r.status;
      if v_ny <> '{}'::jsonb then update records set data = data || v_ny, updated_at = now() where id = v_id; end if;
    elsif v_ny <> '{}'::jsonb then
      update records set data = data || v_ny, updated_at = now() where id = v_id;
    else
      continue;
    end if;

    insert into activities (tenant_id, record_id, activity_type, body, metadata, actor_user_id, actor_kind, occurred_at)
    values (v_r.tenant_id, v_id, 'field_change',
            'Kommentar' || case when v_rad->>'s' is not null and v_r.status = 'ej_knackad' then ' och status Återkoppling' else '' end
              || ' inlagd från listan "In i CRM Skåne" (4 nov)',
            jsonb_build_object('kalla', 'import_malmo_kommentarer_2026-11-04', 'excel_rad', (v_rad->>'rad')::int,
                               'fore', jsonb_build_object('status', v_r.status, 'saljare', v_r.data->'saljare',
                                 'owner_user_id', v_r.owner_user_id, 'kommentar', v_r.data->'kommentar')),
            null, 'system', now());
  end loop;
  raise notice 'Kommentarer: %, status ändrad: %, status redan ändrad i CRM: %, hittades inte: %', v_kom, v_st, v_status_ej, v_saknas;
end $do$;
