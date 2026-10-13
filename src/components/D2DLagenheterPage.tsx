import type { ObjectDef } from "@/lib/data";
import { ObjectListPage } from "./ObjectListPage";

/* =============================================================================
   Door to door → Lägenheter (CRM): tabellvyn — alla lägenheter med markera,
   byt säljare och CSV-export. Kortvyn med namn/telefon/kommentar och status
   direkt i kortet ligger i D2D-sälj → Projekt → Alla lägenheter
   (D2DAllaLagenheter.tsx). Båda läser och skriver samma poster, så det som
   fylls i där syns här direkt.
   ========================================================================== */

export function D2DLagenheterPage({ objectDef, onOpenRecord, onMetadataChanged, reloadKey }: {
  objectDef: ObjectDef;
  projektDef?: ObjectDef;
  onOpenRecord: (id: string) => void;
  onMetadataChanged?: () => void;
  reloadKey?: number;
}) {
  return (
    <ObjectListPage
      key="tabell"
      objectDef={objectDef}
      onOpenRecord={onOpenRecord}
      onMetadataChanged={onMetadataChanged}
      reloadKey={reloadKey}
      stateKeySuffix=":tabell"
    />
  );
}
