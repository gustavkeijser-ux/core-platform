-- D2D: Scrive-mallen 9222115557591481195 ligger i papperskorgen ("The template is in Trash").
-- Den aktiva mallen "ConnectEstate avtalsförslag tjänster" är 9222115557591481415
-- (51 fält, alla kända, inkl. "Övrigt" som flerradigt textfält).
do $$ begin
  update scrive_installningar set mall_id = '9222115557591481415';
end $$;
