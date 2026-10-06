import type { Session } from "@supabase/supabase-js";
import type { FieldDef, TenantBranding } from "@/lib/data";
import { ProfileSettings, AppearanceSettings } from "./UserSettings";
import { UsersAdminPage } from "./UsersAdminPage";
import { M365StatusPage } from "./M365StatusPage";
import { D2DPrislistaPage } from "./D2DAvtal";
import { ImportPage } from "./ImportPage";

/* =============================================================================
   Inställningar — en sida för allt som är konfiguration (#/installningar/<flik>).
   Flikar till vänster på desktop, som rullbar rad på mobil. Vilka flikar som
   visas styrs av roll: Profil och Import för alla, resten bara för admin.
   ========================================================================== */

export type SettingsTab = "profil" | "utseende" | "anvandare" | "m365" | "priser" | "import";

export const SETTINGS_TABS: Array<{ key: SettingsTab; label: string; sub: string; admin?: boolean; cases?: boolean }> = [
  { key: "profil", label: "Profil", sub: "Ditt konto, lösenord och läge" },
  { key: "utseende", label: "Utseende", sub: "Färg och logotyp för hela organisationen", admin: true },
  { key: "anvandare", label: "Användare", sub: "Konton och roller i CRM:et", admin: true },
  { key: "m365", label: "Microsoft 365", sub: "Kopplingen till e-postlådan och e-postsignatur", admin: true, cases: true },
  { key: "priser", label: "Priser (D2D)", sub: "Priser och villkor för alla avtalsförslag i D2D", admin: true },
  { key: "import", label: "Import", sub: "Läs in data från fil" },
];

export function isSettingsTab(s: string | undefined): s is SettingsTab {
  return SETTINGS_TABS.some((t) => t.key === s);
}

export function SettingsPage({ tab, onTab, session, isAdmin, canCases, branding, onBrandingChanged, lagFields }: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  session: Session;
  isAdmin: boolean;
  canCases: boolean;
  branding: TenantBranding | null;
  onBrandingChanged: () => void;
  lagFields: FieldDef[];
}) {
  const tabs = SETTINGS_TABS.filter((t) => (!t.admin || isAdmin) && (!t.cases || canCases));
  const current = tabs.some((t) => t.key === tab) ? tab : "profil";

  return (
    <div className="page set">
      <nav className="set__nav" aria-label="Inställningar">
        {tabs.map((t) => (
          <button key={t.key} className="set__tab" aria-current={current === t.key} onClick={() => onTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="set__body">
        {current === "profil" && <ProfileSettings session={session} />}
        {current === "utseende" && isAdmin && <AppearanceSettings branding={branding} onBrandingChanged={onBrandingChanged} />}
        {current === "anvandare" && isAdmin && <UsersAdminPage meId={session.user.id} />}
        {current === "m365" && isAdmin && <M365StatusPage />}
        {current === "priser" && isAdmin && <D2DPrislistaPage fields={lagFields} />}
        {current === "import" && <ImportPage />}
      </div>
    </div>
  );
}
