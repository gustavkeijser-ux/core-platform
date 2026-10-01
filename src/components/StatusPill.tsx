import type { StatusDef } from "@/lib/data";

export function StatusPill({ status, def }: { status: string | null; def?: StatusDef }) {
  if (!status) return <span className="status-pill"><span className="status-pill__dot" />Ingen status</span>;
  const c = def?.color;
  const color = c ? (c.startsWith("#") ? c : `var(--hue-${c})`) : undefined;
  return (
    <span className="status-pill" style={color ? ({ "--pill": color } as React.CSSProperties) : undefined}>
      <span className="status-pill__dot" />
      {def?.label ?? status}
    </span>
  );
}
