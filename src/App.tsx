import { useEffect, useState, useCallback, type CSSProperties } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getMetadata, type ObjectDef, type TenantBranding } from "@/lib/data";
import { LoginPage } from "@/components/LoginPage";
import { ForcedPasswordChangePage } from "@/components/ForcedPasswordChangePage";
import { Sidebar } from "@/components/Sidebar";
import { ThemeToggle, useTheme } from "@/lib/theme";
import { brandCssVars } from "@/lib/color";
import { DashboardPage } from "@/components/DashboardPage";
import { AiChatPage } from "@/components/AiChatPage";
import { ObjectListPage } from "@/components/ObjectListPage";
import { RecordDrawer } from "@/components/RecordDrawer";
import { D2DSellerApp } from "@/components/D2DSellerApp";
import { D2DProjectBuilder } from "@/components/D2DProjectBuilder";
import { MyTasksPage } from "@/components/MyTasksPage";
import { ImportPage } from "@/components/ImportPage";
import { UserSettings } from "@/components/UserSettings";

type View =
  | { kind: "dashboard" }
  | { kind: "ai" }
  | { kind: "tasks" }
  | { kind: "import" }
  | { kind: "list"; objectType: string }
  | { kind: "d2d" }
  | { kind: "d2dbuilder" };

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [objects, setObjects] = useState<ObjectDef[] | null>(null);
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);

  // ── Öppna post som redigerbart kort ─────────────────────────────────
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [listReloadKey, setListReloadKey] = useState(0);
  const [visaInstallningar, setVisaInstallningar] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { theme } = useTheme();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBranding(res.tenant ?? null);
        setIsAdmin(!!res.isAdmin);
        setMustChangePassword(!!res.mustChangePassword);
        setView({ kind: "dashboard" });
      })
      .catch((e) => setMetaError(e.message ?? "Kunde inte hämta metadata."));
  }, [session]);

  /** Ladda om metadata (t.ex. efter fältändringar eller ändrad branding).
   *  OBS: måste ligga före alla villkorliga return-satser — hooks får
   *  aldrig hoppas över mellan renderingar. */
  const reloadMetadata = useCallback(() => {
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBranding(res.tenant ?? null);
        setIsAdmin(!!res.isAdmin);
        setMustChangePassword(!!res.mustChangePassword);
      })
      .catch(() => { /* tyst — behåll befintlig data */ });
  }, []);

  if (session === undefined) {
    return <div className="loading-shell">Laddar…</div>;
  }
  if (!session) {
    return <LoginPage />;
  }
  if (metaError) {
    return <div className="loading-shell">{metaError}</div>;
  }
  if (!objects) {
    return <div className="loading-shell">Laddar objekt…</div>;
  }
  if (objects.length === 0) {
    return <div className="loading-shell">Inga objekttyper är konfigurerade för din tenant ännu.</div>;
  }
  if (mustChangePassword) {
    return <ForcedPasswordChangePage onDone={() => setMustChangePassword(false)} />;
  }

  // D2D-läge: helt separat vy
  if (view?.kind === "d2d") {
    return (
      <D2DSellerApp onExitD2D={() => setView({ kind: "dashboard" })} />
    );
  }

  const objectDefFor = (key: string) => objects.find((o) => o.key === key);

  /** Öppna en post som redigerbart kort */
  function openRecord(id: string) {
    setOpenRecordId(id);
  }

  // Varumärkesfärgen sprids som CSS-variabler på .app-shell (inte på
  // document.documentElement) så den ärvs av allt i appen — knappar,
  // aktiva menyval, fokusringar, glöden i sidans övre hörn — utan att
  // påverka LoginPage, som renderas innan branding är inläst.
  const brandVars = branding?.brandColor ? brandCssVars(branding.brandColor, theme === "light") : undefined;

  return (
    <div className="app-shell" style={brandVars as CSSProperties}>
      <Sidebar
        objects={objects}
        branding={branding}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
        activeKey={
          view?.kind === "list" ? view.objectType
          : view?.kind === "dashboard" ? "__dashboard__"
          : view?.kind === "ai" ? "__ai__"
          : view?.kind === "tasks" ? "__tasks__"
          : view?.kind === "import" ? "__import__"
          : view?.kind === "d2dbuilder" ? "__d2dbuilder__"
          : null
        }
        onSelect={(key) =>
          setView(
            key === "__dashboard__" ? { kind: "dashboard" }
            : key === "__ai__" ? { kind: "ai" }
            : key === "__tasks__" ? { kind: "tasks" }
            : key === "__import__" ? { kind: "import" }
            : key === "__d2d__" ? { kind: "d2d" }
            : key === "__d2dbuilder__" ? { kind: "d2dbuilder" }
            : { kind: "list", objectType: key }
          )
        }
      />
      <div className="app-shell__content">
        <div className="topbar">
          <div className="topbar__left">
            {/* Bara synlig under 860px (se app.css) — öppnar sidomenyn som
             *  ett överlägg, eftersom den annars ligger dold utanför skärmen. */}
            <button
              className="topbar__menu-btn"
              aria-label="Öppna meny"
              onClick={() => setMobileNavOpen(true)}
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="2" y1="4" x2="14" y2="4" />
                <line x1="2" y1="8" x2="14" y2="8" />
                <line x1="2" y1="12" x2="14" y2="12" />
              </svg>
            </button>
            <h1>
              {view?.kind === "list" ? objectDefFor(view.objectType)?.labelPlural
                : view?.kind === "dashboard" ? "Översikt"
                : view?.kind === "ai" ? "AI-assistent"
                : view?.kind === "tasks" ? "Mina uppgifter"
                : view?.kind === "import" ? "Import"
                : view?.kind === "d2dbuilder" ? "D2D – Projektbyggare"
                : ""}
            </h1>
          </div>
          <div className="topbar__user">
            <ThemeToggle />
            <button
              className="btn btn--ghost btn--sm topbar__email-btn"
              onClick={() => setVisaInstallningar(true)}
              title="Inställningar och lösenord"
            >
              {session.user.email}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => supabase.auth.signOut()}>Logga ut</button>
          </div>
        </div>

        {view?.kind === "dashboard" && (
          <DashboardPage
            onOpenObject={(key) => setView({ kind: "list", objectType: key })}
            onOpenRecord={openRecord}
          />
        )}

        {view?.kind === "ai" && <AiChatPage />}

        {view?.kind === "tasks" && <MyTasksPage onOpenRecord={openRecord} />}

        {view?.kind === "import" && <ImportPage />}

        {view?.kind === "d2dbuilder" && <D2DProjectBuilder />}

        {view?.kind === "list" && objectDefFor(view.objectType) && (
          <ObjectListPage
            key={`${view.objectType}-${listReloadKey}`}
            objectDef={objectDefFor(view.objectType)!}
            onOpenRecord={openRecord}
            onMetadataChanged={reloadMetadata}
          />
        )}
      </div>

      {visaInstallningar && (
        <UserSettings
          session={session}
          branding={branding}
          isAdmin={isAdmin}
          onBrandingChanged={reloadMetadata}
          onClose={() => setVisaInstallningar(false)}
        />
      )}

      {/* Redigeringskort — visas ovanpå vilken vy som helst */}
      {openRecordId && (
        <RecordDrawer
          objectDef={objects[0]}
          recordId={openRecordId}
          objectDefFor={objectDefFor}
          onClose={() => setOpenRecordId(null)}
          onSaved={() => {
            setListReloadKey((k) => k + 1);
          }}
          onNavigate={(id) => {
            setOpenRecordId(id);
          }}
          onMetadataChanged={reloadMetadata}
        />
      )}
    </div>
  );
}
