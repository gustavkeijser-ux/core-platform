-- [Leverans] Leveranslistan heter nu "Projektplan" (lista + kanban, synkas från
-- Telias projektplan). Kortvyn ligger som egen menypost: "Leveransöversikt".
-- Singularen ("Leverans") behålls för enskilda poster.
update object_definitions set label_plural = 'Projektplan'
 where key = 'delivery' and label_plural = 'Leveranser';
