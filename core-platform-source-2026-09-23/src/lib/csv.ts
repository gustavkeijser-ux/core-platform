import type { FieldDef, RecordRow } from "./data";
import { formatValue } from "./fields";

/**
 * Genererar en CSV-sträng utifrån poster och fältdefinitioner.
 * Allt är metadatadrivet — inga hårdkodade kolumner.
 */
export function recordsToCsv(fields: FieldDef[], rows: RecordRow[]): string {
  const headers = ["ID", "Titel", "Status", ...fields.map((f) => f.label), "Skapad", "Uppdaterad"];

  const escape = (v: string) => {
    if (v.includes(",") || v.includes('"') || v.includes("\n")) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const lines = [headers.map(escape).join(",")];

  for (const r of rows) {
    const cells = [
      r.id,
      r.title ?? "",
      r.status ?? "",
      ...fields.map((f) => formatValue(f, r.data[f.key])),
      r.created_at ?? "",
      r.updated_at ?? "",
    ];
    lines.push(cells.map(escape).join(","));
  }

  return lines.join("\n");
}

/** Triggera en CSV-nedladdning i webbläsaren */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM för Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
