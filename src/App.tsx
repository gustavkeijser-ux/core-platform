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
import { AiPanel } from "@/components/AiAssistant";
import { FeedbackButton } from "@/components/FeedbackButton";
import { FeedbackPage } from "@/components/FeedbackPage";
import { ObjectListPage } from "@/components/ObjectListPage";
import { D2DLagenheterPage } from "@/components/D2DLagenheterPage";
import { RecordDrawer } from "@/components/RecordDrawer";
import { D2DSellerApp } from "@/components/D2DSellerApp";
import { D2DProjectBuilder } from "@/components/D2DProjectBuilder";
import { D2DUtfallPage } from "@/components/D2DUtfallPage";
import { D2DAvtalPage } from "@/components/D2DAvtalPage";
import { D2DFeedbackGranskning, d2dFeedbackAntalVantar, d2dFeedbackArGranskare } from "@/components/D2DFeedback";
import { MyTasksPage } from "@/components/MyTasksPage";
import { NummerbytenPage } from "@/components/NummerbytenPage";
import { CasesPage } from "@/components/CasesPage";
import { CaseView } from "@/components/CaseView";
import { type CaseFilter, type CaseCounts, listArenden } from "@/lib/cases";
import { SkapaArendePage } from "@/components/SkapaArende";
import { FmoPage } from "@/components/FmoPage";
import { arFmo } from "@/lib/fmo";
import { SettingsPage, isSettingsTab, SETTINGS_TABS, type SettingsTab } from "@/components/SettingsPage";
import { useRoute, readRoute, navigate, goBack } from "@/lib/route";
import { loadAllUsers, useUserName } from "@/lib/users";

type View =
  | { kind: "dashboard" }
  | { kind: "tasks" }
  | { kind: "list"; objectType: string }
  | { kind: "d2d" }
  | { kind: "d2dbuilder" }
  | { kind: "d2dutfall" }
  | { kind: "d2davtal" }
  | { kind: "d2dfeedback" }
  | { kind: "nummerbyten" }
  | { kind: "cases"; filter: CaseFilter }
  | { kind: "case"; id: string }
  | { kind: "newcase" }
  | { kind: "feedback" }
  | { kind: "settings"; tab: SettingsTab }
  | { kind: "fmo" };

/** URL → vy. Okänt/tomt → översikten. */
function viewFromSegs(segs: string[]): View {
  switch (segs[0]) {
    case "tasks": return { kind: "tasks" };
    case "installningar": return { kind: "settings", tab: isSettingsTab(segs[1]) ? segs[1] : "profil" };
    // Gamla adresser → motsvarande flik under Inställningar.
    case "import": return { kind: "settings", tab: "import" };
    case "m365": return { kind: "settings", tab: "m365" };
    case "d2dpriser": return { kind: "settings", tab: "priser" };
    case "anvandare": return { kind: "settings", tab: "anvandare" };
    case "d2d": return { kind: "d2d" };
    case "d2dbuilder": return { kind: "d2dbuilder" };
    case "d2dutfall": return { kind: "d2dutfall" };
    case "d2davtal": return { kind: "d2davtal" };
    case "d2dfeedback": return { kind: "d2dfeedback" };
    case "nummerbyten": return { kind: "nummerbyten" };
    case "arenden": return { kind: "cases", filter: (CASE_FILTERS.includes(segs[1] as CaseFilter) ? segs[1] : "open") as CaseFilter };
    case "arende": if (segs[1]) return { kind: "case", id: segs[1] }; break;
    case "nytt-arende": return { kind: "newcase" };
    case "feedback": return { kind: "feedback" };
    case "fmo": return { kind: "fmo" };
    case "list": if (segs[1]) return { kind: "list", objectType: segs[1] }; break;
  }
  return { kind: "dashboard" };
}

const CASE_FILTERS: CaseFilter[] = ["open", "all", "new", "mine", "unassigned", "in_progress", "waiting_customer",
  "waiting_internal", "waiting_contractor", "resolved", "closed", "overdue", "waiting"];

const segsFromView = (v: View): string[] =>
  v.kind === "list" ? ["list", v.objectType]
  : v.kind === "cases" ? (v.filter === "open" ? ["arenden"] : ["arenden", v.filter])
  : v.kind === "case" ? ["arende", v.id]
  : v.kind === "newcase" ? ["nytt-arende"]
  : v.kind === "settings" ? ["installningar", v.tab]
  : [v.kind];

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [objects, setObjects] = useState<ObjectDef[] | null>(null);
  const [branding, setBranding] = useState<TenantBranding | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSeller, setIsSeller] = useState(false);
  // Rollen "FMO (Telia)": egen inloggning som bara ser FMO-checken.
  const [isFmo, setIsFmo] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  // Var man är i appen ligger i URL:en (#/…) så att man stannar kvar på
  // samma sida vid omladdning — se src/lib/route.ts.
  const route = useRoute();
  const [metaReady, setMetaReady] = useState(false);

  // ── Öppna post som redigerbart kort ─────────────────────────────────
  const openRecordId = route.query.get("post");
  // Övriga parametrar (t.ex. valt D2D-projekt) ligger kvar när en post öppnas/stängs.
  const setOpenRecordId = (id: string | null) => {
    const r = readRoute();
    navigate(r.segs, { ...Object.fromEntries(r.query), post: id });
  };
  const setView = (v: View) => navigate(segsFromView(v));
  const [listReloadKey, setListReloadKey] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [caseCounts, setCaseCounts] = useState<CaseCounts>({});
  const [newFeedback, setNewFeedback] = useState(0);
  const [d2dGranskare, setD2dGranskare] = useState(false);
  const [d2dFeedbackVantar, setD2dFeedbackVantar] = useState(0);
  // AI-assistenten: panel nere till vänster, öppnas från ikonen ovanför Import.
  const [aiOpen, setAiOpen] = useState(false);
  const myName = useUserName(session?.user.id);
  const { theme } = useTheme();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    loadAllUsers(); // användarnamn i cachen direkt, så användarfält visar namn
    Promise.all([getMetadata(), arFmo()])
      .then(([res, fmo]) => {
        setIsFmo(fmo);
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

  // Antal per färdig ärendevy i menyn (Mina, Nya, Försenade …) — uppdateras
  // varje minut och när man byter sida.
  useEffect(() => {
    if (!metaReady || !objects?.some((o) => o.key === "case")) return;
    let on = true;
    const tick = () => listArenden("open", "", {}, 1, 0).then((r) => { if (on) setCaseCounts(r.counts ?? {}); }).catch(() => {});
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { on = false; window.clearInterval(t); };
  }, [metaReady, objects, route.segs[0]]);

  // Antal nya feedback (siffran vid Övrigt → Feedback, bara för administratörer).
  useEffect(() => {
    if (!metaReady || !isAdmin) return;
    let on = true;
    const tick = () => supabase.from("feedback").select("id", { count: "exact", head: true }).eq("status", "new")
      .then(({ count }) => { if (on) setNewFeedback(count ?? 0); });
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { on = false; window.clearInterval(t); };
  }, [metaReady, isAdmin, route.segs[0]]);

  // Säljarfeedback från Blitz: bara granskaren (Lukas, d2d_feedback_granskare)
  // ser menyvalet, med antal som väntar som siffra (uppdateras varje minut).
  useEffect(() => {
    if (!metaReady) return;
    let on = true;
    d2dFeedbackArGranskare().then((g) => { if (on) setD2dGranskare(g); });
    return () => { on = false; };
  }, [metaReady]);
  useEffect(() => {
    if (!metaReady || !d2dGranskare) return;
    let on = true;
    const tick = () => d2dFeedbackAntalVantar().then((n) => { if (on) setD2dFeedbackVantar(n); });
    tick();
    const t = window.setInterval(tick, 60_000);
    return () => { on = false; window.clearInterval(t); };
  }, [metaReady, d2dGranskare, route.segs[0]]);

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
  if (mustChangePassword) {
    return <ForcedPasswordChangePage onDone={() => setMustChangePassword(false)} />;
  }
  // Telia (FMO) ser bara sin lista: exportera, svara, importera.
  if (isFmo && !isAdmin) {
    return <FmoPage fristaende />;
  }
  if (objects.length === 0) {
    return <div className="loading-shell">Inga objekttyper är konfigurerade för din tenant ännu.</div>;
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
    : view?.kind === "newcase" ? "För ärenden som kommer in per telefon, personligt eller internt"
    : view?.kind === "tasks" ? "Dina uppgifter i alla moduler"
    : view?.kind === "d2dbuilder" ? "Projekt, adresser och tilldelning"
    : view?.kind === "d2dutfall" ? "Utfall, merförsäljning och bindningstider"
    : view?.kind === "d2davtal" ? "Avtal signerade med Scrive i D2D-vyn"
    : view?.kind === "d2dfeedback" ? "Feedback från säljarna i Blitz — granskas innan den skickas vidare"
    : view?.kind === "nummerbyten" ? "Portering och tillfälliga nummer"
    : view?.kind === "feedback" ? "Fel, idéer och önskemål från användarna"
    : view?.kind === "settings" ? (SETTINGS_TABS.find((t) => t.key === view.tab)?.sub ?? "")
    : view?.kind === "fmo" ? "Fastigheter som skickats på FMO-check"
    : tenantName;

  // Feedbackknappen: menyns moduler, och den man står i (förval).
  const fbModules = Array.from(new Set([
    "Översikt", "Mina uppgifter",
    ...objects.filter((o) => o.key !== "case").map((o) => o.labelPlural),
    "Door2Door", ...(canCases ? ["Ärenden", "Microsoft 365"] : []),
    "Import", "Inställningar", "AI-assistent", "Annat",
  ]));
  const fbCurrent =
    view?.kind === "list" ? (listDef?.labelPlural ?? "Annat")
    : view?.kind === "dashboard" ? "Översikt"
    : view?.kind === "tasks" ? "Mina uppgifter"
    : view?.kind === "settings" ? (view.tab === "import" ? "Import" : view.tab === "m365" ? "Microsoft 365" : view.tab === "priser" ? "Door2Door" : "Inställningar")
    : view?.kind === "d2dbuilder" || view?.kind === "d2dutfall" || view?.kind === "d2davtal" || view?.kind === "d2dfeedback" ? "Door2Door"
    : view?.kind === "nummerbyten" ? (objectDefFor("nummerbyte")?.labelPlural ?? "Annat")
    : view?.kind === "cases" || view?.kind === "case" || view?.kind === "newcase" ? "Ärenden"
    : "Annat";

  // Vad användaren tittar på — skickas med till AI-assistenten.
  const aiContext = openRecordId
    ? `en post (recordId ${openRecordId}) — hämta den med get_record om frågan gäller "den här posten"`
    : view?.kind === "list" ? `listan ${listDef?.labelPlural ?? view.objectType} (objectType ${view.objectType})`
    : view?.kind === "case" ? `ärendet med caseId ${view.id}`
    : view?.kind === "cases" ? `ärendelistan (filter ${view.filter})`
    : view?.kind ?? "";

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
        caseCounts={caseCounts}
        newFeedback={newFeedback}
        d2dFeedback={d2dGranskare ? { vantar: d2dFeedbackVantar } : undefined}
        user={{ id: session.user.id, email: session.user.email ?? "", role: isAdmin ? "Administratör" : isSeller ? "Säljare" : "Användare" }}
        onOpenSettings={() => setView({ kind: "settings", tab: "profil" })}
        onSignOut={() => supabase.auth.signOut()}
        onOpenAi={() => setAiOpen((o) => !o)}
        aiOpen={aiOpen}
        activeKey={
          view?.kind === "list" ? view.objectType
          : view?.kind === "dashboard" ? "__dashboard__"
          : view?.kind === "tasks" ? "__tasks__"
          : view?.kind === "d2dbuilder" ? "__d2dbuilder__"
          : view?.kind === "d2dutfall" ? "__d2dutfall__"
          : view?.kind === "d2davtal" ? "__d2davtal__"
          : view?.kind === "d2dfeedback" ? "__d2dfeedback__"
          : view?.kind === "nummerbyten" ? "nummerbyte"
          : view?.kind === "cases" ? `__cases_${view.filter}__`
          : view?.kind === "case" ? null
          : view?.kind === "newcase" ? "__newcase__"
          : view?.kind === "feedback" ? "__feedback__"
          : view?.kind === "settings" ? "__settings__"
          : view?.kind === "fmo" ? "__fmo__"
          : null
        }
        onSelect={(key) =>
          setView(
            key === "__dashboard__" ? { kind: "dashboard" }
            : key === "__tasks__" ? { kind: "tasks" }
            : key === "__settings__" ? { kind: "settings", tab: "profil" }
            : key === "__d2d__" ? { kind: "d2d" }
            : key === "__d2dbuilder__" ? { kind: "d2dbuilder" }
            : key === "__d2dutfall__" ? { kind: "d2dutfall" }
            : key === "__d2davtal__" ? { kind: "d2davtal" }
            : key === "__d2dfeedback__" ? { kind: "d2dfeedback" }
            : key === "nummerbyte" ? { kind: "nummerbyten" }
            : key === "__newcase__" ? { kind: "newcase" }
            : key.startsWith("__cases_") ? { kind: "cases", filter: key.slice(8, -2) as CaseFilter }
            : key === "__feedback__" ? { kind: "feedback" }
            : key === "__fmo__" ? { kind: "fmo" }
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
                : view?.kind === "tasks" ? "Mina uppgifter"
                : view?.kind === "d2dbuilder" ? "D2D – Projekt"
                : view?.kind === "d2dutfall" ? "D2D – Utfall"
                : view?.kind === "d2davtal" ? "D2D – Avtal"
                : view?.kind === "d2dfeedback" ? "Säljarfeedback"
                : view?.kind === "nummerbyten" ? "Nummerbyten"
                : view?.kind === "cases" ? "Ärenden"
                : view?.kind === "case" ? "Ärende"
                : view?.kind === "newcase" ? "Skapa ärende"
                : view?.kind === "feedback" ? "Feedback"
                : view?.kind === "settings" ? "Inställningar"
                : view?.kind === "fmo" ? "FMO-check"
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

        {view?.kind === "tasks" && <MyTasksPage onOpenRecord={openRecord} />}

        {view?.kind === "d2dbuilder" && <D2DProjectBuilder objectDefFor={objectDefFor} onOpenRecord={openRecord} />}
        {view?.kind === "d2dutfall" && <D2DUtfallPage onOpenRecord={openRecord} />}
        {view?.kind === "d2davtal" && <D2DAvtalPage onOpenRecord={openRecord} lagFields={objectDefFor("d2d_lagenhet")?.fields ?? []} />}
        {view?.kind === "d2dfeedback" && (d2dGranskare
          ? <D2DFeedbackGranskning onAntalAndrat={() => d2dFeedbackAntalVantar().then(setD2dFeedbackVantar)} />
          : <div className="page"><p className="formfield__help">Bara granskaren av säljarfeedback kan se den här sidan.</p></div>)}

        {view?.kind === "nummerbyten" && <NummerbytenPage />}

        {view?.kind === "cases" && (
          <CasesPage
            filter={view.filter}
            statuses={objectDefFor("case")?.statuses ?? []}
            onFilter={(f) => navigate(segsFromView({ kind: "cases", filter: f }), undefined, true)}
            onOpenCase={(id) => setView({ kind: "case", id })}
            onCreate={() => setView({ kind: "newcase" })}
          />
        )}

        {view?.kind === "newcase" && (
          <SkapaArendePage
            onCancel={() => goBack(() => setView({ kind: "cases", filter: "open" }))}
            onCreated={(id) => navigate(["arende", id], undefined, true)}
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

        {view?.kind === "feedback" && <FeedbackPage isAdmin={isAdmin} />}
        {view?.kind === "settings" && (
          <SettingsPage
            tab={view.tab}
            onTab={(t) => setView({ kind: "settings", tab: t })}
            session={session}
            isAdmin={isAdmin}
            canCases={canCases}
            branding={branding}
            onBrandingChanged={reloadMetadata}
            lagFields={objectDefFor("d2d_lagenhet")?.fields ?? []}
          />
        )}
        {view?.kind === "fmo" && <FmoPage />}

        {view?.kind === "list" && view.objectType === "d2d_lagenhet" && objectDefFor(view.objectType) && (
          <D2DLagenheterPage
            key={view.objectType}
            reloadKey={listReloadKey}
            objectDef={objectDefFor(view.objectType)!}
            projektDef={objectDefFor("d2d_projekt")}
            onOpenRecord={openRecord}
            onMetadataChanged={reloadMetadata}
          />
        )}

        {view?.kind === "list" && view.objectType !== "d2d_lagenhet" && objectDefFor(view.objectType) && (
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
            isAdmin={isAdmin}
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

      <FeedbackButton modules={fbModules} currentModule={fbCurrent} />

      <AiPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        userName={myName && myName !== "…" && myName !== session.user.id.slice(0, 8) ? myName : ""}
        context={aiContext}
        hasOpenRecord={!!openRecordId || view?.kind === "case"}
      />

    </div>
  );
}
