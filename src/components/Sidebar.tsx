import { Fragment, useState } from "react";
import type { ObjectDef, TenantBranding } from "@/lib/data";
import { useUserName } from "@/lib/users";
import { AiMascot } from "./AiAssistant";

type Props = {
  objects: ObjectDef[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Varumärkesfärg/logotyp för tenanten. Saknas branding helt (laddar
   *  fortfarande) faller menyn tillbaka till standardutseendet. */
  branding?: TenantBranding | null;
  /** Mobilt läge (< 860px): menyn ligger annars dold utanför skärmen och
   *  fälls ut som ett överlägg via hamburgerknappen i toppfältet. */
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
  /** Kundservice: visas när användaren får läsa ärenden. */
  canCases?: boolean;
  isAdmin?: boolean;
  /** Antal per färdig ärendevy (märken i menyn), räknat inom användarens behörighet. */
  caseCounts?: Partial<Record<string, number>>;
  /** Inloggad användare (kortet längst ner i menyn). */
  user?: { id: string; email: string; role: string };
  onOpenSettings?: () => void;
  onSignOut?: () => void;
  /** Öppna AI-panelen (ikonen ovanför Import). */
  onOpenAi?: () => void;
  aiOpen?: boolean;
  /** Antal nya (ohanterade) feedback, visas som siffra vid menyvalet. */
  newFeedback?: number;
  /** Säljarfeedback från Blitz (D2D). Sätts bara för granskaren (Lukas):
   *  då visas menyvalet Door to door → Säljarfeedback med antal som väntar. */
  d2dFeedback?: { vantar: number };
};

function initialer(namn: string) {
  const delar = namn.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((delar[0]?.[0] ?? "") + (delar[1]?.[0] ?? "")).toUpperCase() || "?";
}

/* ── Menygrupper ─────────────────────────────────────────────────────── */

type MenuGroup = {
  id: string;
  label: string;
  icon: JSX.Element;
  /** Objektnycklar som hör till gruppen (i ordning) */
  keys: string[];
};

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "salj",
    label: "Säljprocess",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12l4-4 3 3 5-6" />
        <path d="M10 5h4v4" />
      </svg>
    ),
    keys: [
      "forvaltningsbolag", "koncernmoder", "direktagt_bolag", "property", "deal", "__fmo__", "uppstartsmote", "hyresforhandling",
    ],
  },
  {
    id: "leverans",
    label: "Leveransprocess",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 3h9v7H1z" />
        <path d="M10 6h3l2 3v4h-5" />
        <circle cx="4" cy="13" r="1.5" />
        <circle cx="12" cy="13" r="1.5" />
      </svg>
    ),
    keys: ["onboarding", "delivery", "flit_sdu", "appleverans"],
  },
  {
    id: "d2d",
    label: "Door to door",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6l5-4 5 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V6z" />
        <path d="M6.5 14V10h3v4" />
      </svg>
    ),
    keys: ["__d2dutfall__", "__d2davtal__", "d2d_projekt", "d2d_fastighet", "d2d_lagenhet", "nummerbyte"],
  },
];

/** Register (Förslag B punkt 6): kunder, kontakter, avtal och partners —
 *  det man slår upp, skilt från det man arbetar med. */
const REGISTER_KEYS = ["customer", "contact", "agreement", "partner"];

/** Nycklar som inte grupperas utan visas fristående */
const GROUPED_KEYS = new Set([...MENU_GROUPS.flatMap((g) => g.keys), ...REGISTER_KEYS]);

/** Färdiga ärendevyer överst i menyn (ÄRENDEN). Märket visar antal. */
const CASE_VIEWS: Array<{ key: string; label: string; count?: string; alert?: boolean }> = [
  { key: "mine", label: "Mina ärenden", count: "mine" },
  { key: "open", label: "Alla ärenden" },
  { key: "new", label: "Nya", count: "new" },
  { key: "overdue", label: "Försenade", count: "overdue", alert: true },
  { key: "waiting", label: "Väntar på svar", count: "waiting" },
  { key: "unassigned", label: "Ej tilldelade", count: "unassigned" },
];
/** Ärenden har egen inkorg under Kundservice (inte den generiska listan). */
const OWN_VIEW = new Set(["case"]);

/* ── Inline SVG-ikoner (16 × 16, currentColor) ───────────────────────── */

const ICONS: Record<string, JSX.Element> = {
  __dashboard__: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </svg>
  ),
  __tasks__: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2" width="11" height="12.5" rx="1.5" />
      <path d="M5.5 6.5l1.2 1.2 2.3-2.3" />
      <line x1="5.5" y1="10.5" x2="10.5" y2="10.5" />
    </svg>
  ),
  __feedback__: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13.5" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  __import__: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5v7" />
      <path d="M5 6l3 3 3-3" />
      <path d="M2.5 11v2a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2" />
    </svg>
  ),
  customer: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" />
    </svg>
  ),
  deal: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13V5l4-3 4 3v8" />
      <path d="M1 13h14" />
      <path d="M6.5 13V9.5h3V13" />
    </svg>
  ),
  property: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="11" rx="1" />
      <line x1="2" y1="7" x2="14" y2="7" />
      <line x1="6" y1="3" x2="6" y2="14" />
      <line x1="10" y1="3" x2="10" y2="14" />
      <line x1="2" y1="11" x2="14" y2="11" />
    </svg>
  ),
  delivery: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 3h9v7H1z" />
      <path d="M10 6h3l2 3v4h-5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="13" r="1.5" />
    </svg>
  ),
  flit_sdu: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 13c3 0 3-10 6-10s3 10 6 10" />
      <circle cx="2" cy="13" r="1" />
      <circle cx="14" cy="13" r="1" />
    </svg>
  ),
  task: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <path d="M5 8l2 2 4-4" />
    </svg>
  ),
  agreement: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1h6l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" />
      <path d="M10 1v4h4" />
      <line x1="5.5" y1="8" x2="10.5" y2="8" />
      <line x1="5.5" y1="11" x2="9" y2="11" />
    </svg>
  ),
  contact: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5.5" r="2" />
      <path d="M4 13c0-2.21 1.79-4 4-4s4 1.79 4 4" />
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
    </svg>
  ),
  mail: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
      <path d="M2 4l6 5 6-5" />
    </svg>
  ),
  partner: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5.5" cy="5.5" r="2" />
      <circle cx="11" cy="6.5" r="1.7" />
      <path d="M1.5 13c0-2.2 1.8-4 4-4s4 1.8 4 4" />
      <path d="M10 9.2c2 0 4.5 1 4.5 3.8" />
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  support_case: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h12a1 1 0 011 1v6a1 1 0 01-1 1H5l-3 3V4a1 1 0 011-1z" />
      <circle cx="5.5" cy="7.5" r=".6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="7.5" r=".6" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.5" r=".6" fill="currentColor" stroke="none" />
    </svg>
  ),
};

function fallbackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5" x2="8" y2="8.5" />
      <line x1="8" y1="8.5" x2="10.5" y2="10" />
    </svg>
  );
}

/* ── Chevron ─────────────────────────────────────────────────────────── */

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`sidebar__chevron${open ? " sidebar__chevron--open" : ""}`}
    >
      <path d="M4 4.5L6 6.5L8 4.5" />
    </svg>
  );
}

/* ── Sidebar ─────────────────────────────────────────────────────────── */

export function Sidebar({ objects, activeKey, onSelect, branding, mobileOpen, onCloseMobile, canCases, isAdmin, caseCounts, user, onOpenSettings, onSignOut, onOpenAi, aiOpen, newFeedback, d2dFeedback }: Props) {
  /** Navigera och stäng den mobila menyn (no-op på desktop, där
   *  onCloseMobile inte är satt). */
  const hamtatNamn = useUserName(user?.id);
  const userName = hamtatNamn && hamtatNamn !== "…" && hamtatNamn !== user?.id.slice(0, 8) ? hamtatNamn : user?.email ?? "";
  function selectAndClose(key: string) {
    onSelect(key);
    onCloseMobile?.();
  }
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    // Alla grupper stängda som standard
    const init: Record<string, boolean> = {};
    MENU_GROUPS.forEach((g) => { init[g.id] = false; });
    return init;
  });

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  // Objektmap för snabb lookup
  const objMap = new Map(objects.map((o) => [o.key, o]));

  // Fristående objekt (inte i någon grupp eller i Register)
  const standalone = objects.filter((o) => !GROUPED_KEYS.has(o.key) && !OWN_VIEW.has(o.key));
  const registerItems = REGISTER_KEYS.map((k) => objMap.get(k)).filter(Boolean) as ObjectDef[];

  // Om activeKey finns i en grupp, se till att den gruppen är expanderad
  // (vid mount och vid navigation)
  const activeGroup = MENU_GROUPS.find((g) => g.keys.includes(activeKey ?? ""));
  if (activeGroup && !expanded[activeGroup.id]) {
    // Vi sätter direkt utan setState för att undvika loop
    expanded[activeGroup.id] = true;
  }

  const item = (key: string, label: string, icon?: JSX.Element, badge?: { n?: number; alert?: boolean }) => (
    <button key={key} className="sidebar__item" aria-current={activeKey === key} onClick={() => selectAndClose(key)}>
      {icon}
      <span className="sidebar__label">{label}</span>
      {!!badge?.n && <span className={`sidebar__badge${badge.alert ? " sidebar__badge--alert" : ""}`}>{badge.n}</span>}
    </button>
  );

  return (
    <>
      {/* Skärm bakom menyn i mobilt läge — klick stänger, som en vanlig
       *  off-canvas-meny. Osynlig och overksam på desktop (ingen mobileOpen). */}
      {mobileOpen && <div className="sidebar-scrim" onClick={onCloseMobile} />}

      <aside
        className={`sidebar${mobileOpen ? " sidebar--mobile-open" : ""}`}
      >
        <div className="sidebar__brand">
          {branding?.logoUrl ? (
            <img className="sidebar__logo" src={branding.logoUrl} alt={branding.name || "Logotyp"} />
          ) : (
            <>
              <span className="sidebar__mark">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 11l9-8 9 8" />
                  <path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" />
                </svg>
              </span>
              ConnectEstate
            </>
          )}
          <button
            className="sidebar__close-btn"
            aria-label="Stäng meny"
            onClick={onCloseMobile}
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        {/* Organisationen man arbetar i — som i förvaltarpanelen. */}
        <div className="sidebar__org">
          <span className="sidebar__org-name">{branding?.name || "ConnectEstate"}</span>
        </div>
        <nav className="sidebar__nav">
        {item("__dashboard__", "Översikt", ICONS.__dashboard__)}
        {item("__tasks__", "Mina uppgifter", ICONS.__tasks__)}

        <div className="sidebar__section-label">Moduler</div>

        {/* ÄRENDEN — allt som är arbete, överst under Översikt (Förslag B, punkt 6).
         *  Fälls ut/ihop som övriga moduler. */}
        {canCases && (() => {
          const caseActive = (activeKey ?? "").startsWith("__cases_") || activeKey === "__newcase__";
          const isOpen = !!expanded.arenden || caseActive;
          const forsenade = caseCounts?.overdue ?? 0;
          return (
            <div className="sidebar__group">
              <button
                className="sidebar__item sidebar__item--group"
                aria-expanded={isOpen}
                onClick={() => toggle("arenden")}
              >
                {ICONS.support_case}
                <span className="sidebar__label">Ärenden</span>
                {!isOpen && forsenade > 0 && <span className="sidebar__badge sidebar__badge--alert" title="Försenade">{forsenade}</span>}
                <Chevron open={isOpen} />
              </button>
              {isOpen && (
                <div className="sidebar__children">
                  {CASE_VIEWS.map((v) => {
                    const n = v.count ? caseCounts?.[v.count] : undefined;
                    return (
                      <button key={v.key} className="sidebar__item sidebar__item--child"
                        aria-current={activeKey === `__cases_${v.key}__`}
                        onClick={() => selectAndClose(`__cases_${v.key}__`)}>
                        <span className="sidebar__label">{v.label}</span>
                        {!!n && <span className={`sidebar__badge${v.alert ? " sidebar__badge--alert" : ""}`}>{n}</span>}
                      </button>
                    );
                  })}
                  <button className="sidebar__item sidebar__item--child sidebar__item--create" aria-current={activeKey === "__newcase__"}
                    onClick={() => selectAndClose("__newcase__")}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                    <span className="sidebar__label">Skapa ärende</span>
                  </button>
                </div>
              )}
            </div>
          );
        })()}


        {/* Grupperade sektioner */}
        {MENU_GROUPS.map((group) => {
          const isOpen = !!expanded[group.id];
          const groupObjects = group.keys
            .map((k) => objMap.get(k))
            .filter(Boolean) as ObjectDef[];
          const hasActive = group.keys.includes(activeKey ?? "") || (group.id === "d2d" && ["__d2dbuilder__", "__d2d__", "__d2dfeedback__"].includes(activeKey ?? ""));

          // Hoppa över om inga objekt i gruppen finns
          if (groupObjects.length === 0) return null;

          return (
            <div key={group.id} className="sidebar__group">
              <button
                className="sidebar__item sidebar__item--group"
                aria-expanded={isOpen}
                aria-current={hasActive && !isOpen ? true : undefined}
                onClick={() => toggle(group.id)}
              >
                {group.icon}
                <span className="sidebar__label">{group.label}</span>
                {group.id === "d2d" && !isOpen && !!d2dFeedback?.vantar && (
                  <span className="sidebar__badge" title="Säljarfeedback som väntar">{d2dFeedback.vantar}</span>
                )}
                <Chevron open={isOpen} />
              </button>

              {isOpen && (
                <div className="sidebar__children">
                  {/* D2D-gruppen: projektbyggaren och Blitz (säljarnas vy) först */}
                  {group.id === "d2d" && (
                    <>
                      <button
                        className="sidebar__item sidebar__item--child"
                        aria-current={activeKey === "__d2dbuilder__"}
                        onClick={() => selectAndClose("__d2dbuilder__")}
                      >
                        Projekt
                      </button>
                      <button
                        className="sidebar__item sidebar__item--child"
                        aria-current={activeKey === "__d2d__"}
                        onClick={() => selectAndClose("__d2d__")}
                      >
                        Blitz
                      </button>
                      {/* Säljarfeedback från Blitz — bara granskaren (Lukas) */}
                      {d2dFeedback && (
                        <button
                          className="sidebar__item sidebar__item--child"
                          aria-current={activeKey === "__d2dfeedback__"}
                          onClick={() => selectAndClose("__d2dfeedback__")}
                        >
                          Säljarfeedback
                          {!!d2dFeedback.vantar && <span className="sidebar__badge">{d2dFeedback.vantar}</span>}
                        </button>
                      )}
                      <button
                        className="sidebar__item sidebar__item--child"
                        aria-current={activeKey === "__d2davtal__"}
                        onClick={() => selectAndClose("__d2davtal__")}
                      >
                        Avtal
                      </button>
                      {isAdmin && (
                        <button
                          className="sidebar__item sidebar__item--child"
                          aria-current={activeKey === "__d2dutfall__"}
                          onClick={() => selectAndClose("__d2dutfall__")}
                        >
                          Utfall
                        </button>
                      )}
                    </>
                  )}

                  {groupObjects.map((o) => (
                    <Fragment key={o.key}>
                      <button
                        className="sidebar__item sidebar__item--child"
                        aria-current={o.key === activeKey}
                        onClick={() => selectAndClose(o.key)}
                      >
                        {o.labelPlural}
                      </button>
                      {/* FMO-check direkt under Affärer (administratörer) */}
                      {o.key === "deal" && isAdmin && (
                        <button
                          className="sidebar__item sidebar__item--child"
                          aria-current={activeKey === "__fmo__"}
                          onClick={() => selectAndClose("__fmo__")}
                        >
                          FMO-check
                        </button>
                      )}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* REGISTER — kunder, kontakter, avtal och partners. */}
        {(registerItems.length > 0 || standalone.length > 0) && <div className="sidebar__section-label">Register</div>}
        {registerItems.map((o) => item(o.key, o.labelPlural, ICONS[o.key] ?? ICONS.contact))}
        {standalone.map((o) => item(o.key, o.labelPlural, ICONS[o.key] ?? fallbackIcon()))}

        {/* ADMINISTRATION */}
        <div className="sidebar__section-label">Administration</div>
        {isAdmin && item("__feedback__", "Feedback", ICONS.__feedback__, { n: newFeedback })}
        {item("__settings__", "Inställningar", ICONS.settings)}
      </nav>
      <div className="sidebar__bottom">
        {/* AI-assistenten öppnas som en panel nere till vänster (AiPanel). */}
        {onOpenAi && (
          <button
            className="sidebar__item sidebar__item--ai"
            aria-pressed={!!aiOpen}
            onClick={() => { onOpenAi(); onCloseMobile?.(); }}
            title="Fråga AI-assistenten om allt i CRM:et"
          >
            <AiMascot size={22} />
            AI-assistent
          </button>
        )}
        {user && (
          <div className="sidebar__user">
            <button
              className="sidebar__user-main"
              onClick={() => { onOpenSettings?.(); onCloseMobile?.(); }}
              title="Inställningar och lösenord"
            >
              <span className="avatar">{initialer(userName)}</span>
              <span className="sidebar__user-text">
                <span className="sidebar__user-name">{userName}</span>
                <span className="sidebar__user-role">{user.role}</span>
              </span>
            </button>
            <button className="sidebar__logout" onClick={onSignOut} aria-label="Logga ut" title="Logga ut">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </div>
        )}
      </div>
      </aside>
    </>
  );
}
