import type { StatusDef } from "@/lib/data";

export function StatusPill({ status, def }: { status: string | null; def?: StatusDef }) {
  if (!status) return <span className="status-pill"><span className="status-pill__dot" />Ingen status</span>;
  const color = def?.color ? `var(--hue-${def.color})` : undefined;
  return (
    <span className="status-pill">
      <span className="status-pill__dot" style={color ? { background: color } : undefined} />
      {def?.label ?? status}
    </span>
  );
}
