import { useEffect, useState, useCallback, type CSSProperties } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getMetadata, type ObjectDef, type TenantBranding } from "@/lib/data";
import { LoginPage } from "@/components/LoginPage";
import { ForcedPasswordChangePage } from "@/components/ForcedPasswordChangePage";
import { Sidebar } from "@/components/Sidebar";
import { GlobalSearch } from "@/components/GlobalSearch";
import { ThemeToggle, useTheme } from "@/lib/theme";
import { brandCssVars } from "@/lib/color";
import { DashboardPage } from "@/components/DashboardPage";
import { AiChatPage } from "@/components/AiChatPage";
import { ObjectListPage } from "@/components/ObjectListPage";
import { RecordDrawer } from "@/components/RecordDrawer";
import { D2DSellerApp } from "@/components/D2DSellerApp";
import { D2DProjectBuilder } from "@/components/D2DProjectBuilder";
import { MyTasksPage } from "@/components/MyTasksPage";
import { NummerbytenPage } from "@/components/NummerbytenPage";
import { CasesPage } from "@/components/CasesPage";
import { CaseView } from "@/components/CaseView";
import { M365StatusPage } from "@/components/M365StatusPage";
import { type CaseFilter, getCaseSummary } from "@/lib/cases";
import { ImportPage } from "@/components/ImportPage";
import { UserSettings } from "@/components/UserSettings";
import { useRoute, readRoute, navigate, goBack } from "@/lib/route";
import { loadAllUsers } from "@/lib/users";

type View =
  | { kind: "dashboard" }
  | { kind: "ai" }
  | { kind: "tasks" }
  | { kind: "import" }
  | { kind: "list"; objectType: string }
  | { kind: "d2d" }
  | { kind: "d2dbuilder" }
  | { kind: "nummerbyten" }
  | { kind: "cases"; filter: CaseFilter }
  | { kind: "case"; id: string }
  | { kind: "m365" };

/** URL → vy. Okänt/tomt → översikten. */
function viewFromSegs(segs: string[]): View {
  switch (segs[0]) {
    case "ai": return { kind: "ai" };
    case "tasks": return { kind: "tasks" };
    case "import": return { kind: "import" };
    case "d2d": return { kind: "d2d" };
    case "d2dbuilder": return { kind: "d2dbuilder" };
    case "nummerbyten": return { kind: "nummerbyten" };
    case "arenden": return { kind: "cases", filter: (CASE_FILTERS.includes(segs[1] as CaseFilter) ? segs[1] : "open") as CaseFilter };
    case "arende": if (segs[1]) return { kind: "case", id: segs[1] }; break;
    case "m365": return { kind: "m365" };
    case "list": if (segs[1]) return { kind: "list", objectType: segs[1] }; break;
  }
  return { kind: "dashboard" };
}

const CASE_FILTERS: CaseFilter[] = ["open", "all", "new", "mine", "unassigned", "in_progress", "waiting_customer",
  "waiting_internal", "waiting_contractor", "resolved", "closed", "overdue"];

const segsFromView = (v: View): string[] =>
  v.kind === "list" ? ["list", v.objectType]
  : v.kind === "cases" ? (v.filter === "open" ? ["arenden"] : ["arenden", v.filter])
  : v.kind === "case" ? ["arende", v.id]
  : [v.kind];

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [objects, setObjects] = useState<ObjectDef[] | null>(null);
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSeller, setIsSeller] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  // Var man är i appen ligger i URL:en (#/…) så att man stannar kvar på
  // samma sida vid omladdning — se src/lib/route.ts.
  const route = useRoute();
  const [metaReady, setMetaReady] = useState(false);

  // ── Öppna post som redigerbart kort ─────────────────────────────────
  const openRecordId = route.query.get("post");
  const setOpenRecordId = (id: string | null) => navigate(readRoute().segs, { post: id });
  const setView = (v: View) => navigate(segsFromView(v));
  const [listReloadKey, setListReloadKey] = useState(0);
  const [visaInstallningar, setVisaInstallningar] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unassignedCases, setUnassignedCases] = useState(0);
  const { theme } = useTheme();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    loadAllUsers(); // användarnamn i cachen direkt, så användarfält visar namn
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBranding(res.tenant ?? null);
        setIsAdmin(!!res.isAdmin);
        setIsSeller(!!res.isSeller);
        setMustChangePassword(!!res.mustChangePassword);
        // Ren dörrsäljare (ingen admin-roll också) hålls alltid i
        // säljarvyn — enklare för dem, och de har inget annat de
        // behöver i CRM:et. Alla andra hamnar där URL:en pekar
        // (översikten om den är tom), så en omladdning byter inte sida.
        const canCases = res.objects.some((o) => o.key === "case");
        if (res.isSeller && !res.isAdmin && !canCases && readRoute().segs[0] !== "d2d") {
          navigate(["d2d"], undefined, true);
        }
        setMetaReady(true);
      })
      .catch((e) => setMetaError(e.message ?? "Kunde inte hämta metadata."));
  }, [session]);

  // Antal otilldelade ärenden i menyn — uppdateras varje minut.
  useEffect(() => {
    if (!metaReady || !objects?.some((o) => o.key === "case")) return;
    let on = true;
    const tick = () => getCaseSummary().then((s) => { if (on && s) setUnassignedCases(s.today.unassigned); });
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { on = false; window.clearInterval(t); };
  }, [metaReady, objects]);

  /** Ladda om metadata (t.ex. efter fältändringar eller ändrad branding).
   *  OBS: måste ligga före alla villkorliga return-satser — hooks får
   *  aldrig hoppas över mellan renderingar. */
  const reloadMetadata = useCallback(() => {
    getMetadata()
      .then((res) => {
        setObjects(res.objects);
        setBranding(res.tenant ?? null);
        setIsAdmin(!!res.isAdmin);
        setIsSeller(!!res.isSeller);
        setMustChangePassword(!!res.mustChangePassword);
      })
      .catch(() => { /* tyst — behåll befintlig data */ });
  }, []);

  const canCases = !!objects?.some((o) => o.key === "case");
  const sellerOnly = isSeller && !isAdmin && !canCases;
  const view: View | null = !metaReady ? null
    : sellerOnly && route.segs[0] !== "d2d" ? { kind: "d2d" }
    : viewFromSegs(route.segs);

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

  // D2D-läge: helt separat vy. Rena dörrsäljare (ingen admin-roll) får
  // ingen väg tillbaka till CRM:et — de ska bara se säljarvyn, temaväxlaren
  // och logga ut, för enkelhetens skull.
  if (view?.kind === "d2d") {
    return (
      <D2DSellerApp onExitD2D={sellerOnly ? undefined : () => setView({ kind: "dashboard" })} />
    );
  }

  const objectDefFor = (key: string) => objects.find((o) => o.key === key);

  const tenantName = branding?.name || "ConnectEstate";
  const listDef = view?.kind === "list" ? objectDefFor(view.objectType) : undefined;
  const subtitle =
    listDef ? `Alla ${listDef.labelPlural.toLowerCase()} i ${tenantName}`
    : view?.kind === "dashboard" ? `${tenantName} · ${new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" })}`
    : view?.kind === "cases" ? "Följ upp kundernas ärenden"
    : view?.kind === "case" ? "Ärende från kundtjänst"
    : view?.kind === "tasks" ? "Dina uppgifter i alla moduler"
    : view?.kind === "ai" ? "Fråga om allt i CRM:et"
    : view?.kind === "import" ? "Läs in data från fil"
    : view?.kind === "d2dbuilder" ? "Projekt, adresser och tilldelning"
    : view?.kind === "nummerbyten" ? "Portering och tillfälliga nummer"
    : view?.kind === "m365" ? "Kopplingen till e-postlådan och e-postsignatur"
    : tenantName;

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
        canCases={canCases}
        isAdmin={isAdmin}
        unassignedCases={unassignedCases}
        user={{ id: session.user.id, email: session.user.email ?? "", role: isAdmin ? "Administratör" : isSeller ? "Säljare" : "Användare" }}
        onOpenSettings={() => setVisaInstallningar(true)}
        onSignOut={() => supabase.auth.signOut()}
        activeKey={
          view?.kind === "list" ? view.objectType
          : view?.kind === "dashboard" ? "__dashboard__"
          : view?.kind === "ai" ? "__ai__"
          : view?.kind === "tasks" ? "__tasks__"
          : view?.kind === "import" ? "__import__"
          : view?.kind === "d2dbuilder" ? "__d2dbuilder__"
          : view?.kind === "nummerbyten" ? "nummerbyte"
          : view?.kind === "cases" ? (view.filter === "unassigned" ? "__cases_unassigned__" : "__cases__")
          : view?.kind === "case" ? "__cases__"
          : view?.kind === "m365" ? "__m365__"
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
            : key === "nummerbyte" ? { kind: "nummerbyten" }
            : key === "__cases__" ? { kind: "cases", filter: "open" }
            : key === "__cases_unassigned__" ? { kind: "cases", filter: "unassigned" }
            : key === "__m365__" ? { kind: "m365" }
            : { kind: "list", objectType: key }
          )
        }
      />
      <div className="app-shell__content">
        <div className={`topbar${openRecordId ? " topbar--detail" : ""}`}>
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
            <div className="topbar__titles">
            <h1>
              {view?.kind === "list" ? objectDefFor(view.objectType)?.labelPlural
                : view?.kind === "dashboard" ? "Översikt"
                : view?.kind === "ai" ? "AI-assistent"
                : view?.kind === "tasks" ? "Mina uppgifter"
                : view?.kind === "import" ? "Import"
                : view?.kind === "d2dbuilder" ? "D2D – Projekt"
                : view?.kind === "nummerbyten" ? "Nummerbyten"
                : view?.kind === "cases" ? "Ärenden"
                : view?.kind === "case" ? "Ärende"
                : view?.kind === "m365" ? "Microsoft 365"
                : ""}
            </h1>
            <div className="topbar__sub">{subtitle}</div>
            </div>
          </div>
          <div className="topbar__user">
            {/* Sidans egna åtgärder (sök + primärknapp) portas hit, se PageChrome. */}
            <div className="topbar__actions" id="topbar-actions" />
            <GlobalSearch objects={objects} onOpenRecord={openRecord} />
            <ThemeToggle />
          </div>
        </div>

        <div className="view-host" hidden={!!openRecordId}>

        {view?.kind === "dashboard" && (
          <DashboardPage
            onOpenCases={canCases ? (f) => setView({ kind: "cases", filter: f as CaseFilter }) : undefined}
            onOpenObject={(key) => setView({ kind: "list", objectType: key })}
            onOpenRecord={openRecord}
            onOpenCase={(id) => setView({ kind: "case", id })}
            objects={objects}
          />
        )}

        {view?.kind === "ai" && <AiChatPage />}

        {view?.kind === "tasks" && <MyTasksPage onOpenRecord={openRecord} />}

        {view?.kind === "import" && <ImportPage />}

        {view?.kind === "d2dbuilder" && <D2DProjectBuilder />}

        {view?.kind === "nummerbyten" && <NummerbytenPage />}

        {view?.kind === "cases" && (
          <CasesPage
            filter={view.filter}
            statuses={objectDefFor("case")?.statuses ?? []}
            onFilter={(f) => navigate(segsFromView({ kind: "cases", filter: f }), undefined, true)}
            onOpenCase={(id) => setView({ kind: "case", id })}
          />
        )}

        {view?.kind === "case" && (
          <CaseView
            key={view.id}
            caseId={view.id}
            statuses={objectDefFor("case")?.statuses ?? []}
            onBack={() => goBack(() => setView({ kind: "cases", filter: "open" }))}
            onOpenCase={(id) => setView({ kind: "case", id })}
          />
        )}

        {view?.kind === "m365" && isAdmin && <M365StatusPage />}

        {view?.kind === "list" && objectDefFor(view.objectType) && (
          <ObjectListPage
            key={view.objectType}
            reloadKey={listReloadKey}
            objectDef={objectDefFor(view.objectType)!}
            onOpenRecord={openRecord}
            onMetadataChanged={reloadMetadata}
          />
        )}
        </div>

        {/* Posten som egen sida (brödsmulor, rubrik, flikar) — vyn bakom
         *  ligger kvar monterad men dold, så lista/filter/sida är oförändrade
         *  när man går tillbaka. */}
        {openRecordId && (
          <RecordDrawer
            key={openRecordId}
            variant="page"
            objectDef={objects[0]}
            recordId={openRecordId}
            objectDefFor={objectDefFor}
            onClose={() => goBack(() => setOpenRecordId(null))}
            onOpenList={(key) => navigate(["list", key])}
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

      {visaInstallningar && (
        <UserSettings
          session={session}
          branding={branding}
          isAdmin={isAdmin}
          onBrandingChanged={reloadMetadata}
          onClose={() => setVisaInstallningar(false)}
        />
      )}

    </div>
  );
}
