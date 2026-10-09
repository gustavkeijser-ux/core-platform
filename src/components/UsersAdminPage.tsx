import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fmtDateTime, relTime } from "@/lib/cases";
import { EmptyState, PlusIcon, SearchField, SkeletonRows, TopbarActions } from "./PageChrome";

/* =============================================================================
   Administration → Användare. Bara administratörer.
   Lista över alla användare i företaget med roller och senaste inloggning,
   skapa ny användare (tillfälligt lösenord eller inbjudan per e-post) och
   ändra roller direkt i raden. Allt går via edge function `admin-users`.
   ========================================================================== */

type Role = { id: string; key: string; name: string };
type User = {
  id: string; email: string; fullName: string; isActive: boolean; mustChangePassword: boolean;
  createdAt: string; lastSignInAt: string | null; roles: Role[];
};

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("admin-users", { body });
  if (error) {
    let detail = error.message ?? "Något gick fel.";
    try {
      const b = await (error as { context?: Response }).context?.json();
      if (b?.error) detail = b.error;
    } catch { /* inte JSON */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

function initials(name: string) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
}

export function UsersAdminPage({ meId }: { meId: string }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftRoles, setDraftRoles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await call<{ users: User[]; roles: Role[] }>({ action: "list" });
      setUsers(r.users); setRoles(r.roles); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Kunde inte hämta användarna."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users ?? []).filter((u) => !q || [u.fullName, u.email, ...u.roles.map((r) => r.name)].some((s) => s.toLowerCase().includes(q)));
  }, [users, search]);

  function startEdit(u: User) { setEditing(u.id); setDraftRoles(u.roles.map((r) => r.key)); }

  async function saveRoles(u: User) {
    setBusy(true);
    try {
      await call({ action: "set_roles", userId: u.id, roleKeys: draftRoles });
      setEditing(null); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Kunde inte spara rollerna."); }
    finally { setBusy(false); }
  }

  return (
    <div className="page usr">
      <TopbarActions>
        <SearchField value={search} onChange={setSearch} placeholder="Sök användare…" />
        <button className="btn btn--brand" onClick={() => setShowNew(true)}><PlusIcon /><span className="btn__label">Ny användare</span></button>
      </TopbarActions>

      {error && <div className="formfield__error">{error}</div>}

      <div className="card usr__list">
        {users == null ? <SkeletonRows rows={5} />
          : shown.length === 0 ? (
            <EmptyState kind={search ? "filtered" : "empty"} title={users.length === 0 ? "Inga användare" : "Ingen matchar"} />
          ) : shown.map((u) => {
            const isEditing = editing === u.id;
            return (
              <article key={u.id} className={`usr__row${u.isActive ? "" : " usr__row--off"}`}>
                <div className="usr__who">
                  <span className="avatar">{initials(u.fullName || u.email)}</span>
                  <div className="usr__who-text">
                    <div className="usr__name">{u.fullName || "—"}{u.id === meId && <span className="usr__me">du</span>}</div>
                    <div className="usr__email">{u.email}</div>
                  </div>
                </div>

                <div className="usr__roles">
                  {isEditing ? (
                    <div className="chips">
                      {roles.map((r) => {
                        const on = draftRoles.includes(r.key);
                        return (
                          <button key={r.key} type="button" className="chip" aria-pressed={on}
                            onClick={() => setDraftRoles((d) => on ? d.filter((k) => k !== r.key) : [...d, r.key])}>
                            {r.name}
                          </button>
                        );
                      })}
                    </div>
                  ) : u.roles.length === 0 ? <span className="usr__norole">Ingen roll</span>
                    : u.roles.map((r) => <span key={r.key} className={`usr__role${r.key === "admin" ? " usr__role--admin" : ""}`}>{r.name}</span>)}
                  <div className="usr__meta">
                    {u.lastSignInAt
                      ? <span title={fmtDateTime(u.lastSignInAt, { withYear: true })}>Inloggad {relTime(u.lastSignInAt)}</span>
                      : <span>Har aldrig loggat in</span>}
                    {u.mustChangePassword && <span className="usr__flag">Byter lösenord vid nästa inloggning</span>}
                  </div>
                </div>

                <div className="usr__side">
                  {isEditing ? (
                    <>
                      <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setEditing(null)}>Avbryt</button>
                      <button className="btn btn--sm btn--brand" disabled={busy} onClick={() => void saveRoles(u)}>{busy ? "Sparar…" : "Spara"}</button>
                    </>
                  ) : (
                    <button className="btn btn--sm btn--ghost" onClick={() => startEdit(u)}>Ändra roller</button>
                  )}
                </div>
              </article>
            );
          })}
      </div>

      {showNew && <NewUserDialog roles={roles} onClose={() => setShowNew(false)} onCreated={() => void load()} />}
    </div>
  );
}

/* ── Ny användare ─────────────────────────────────────────────────────── */

function NewUserDialog({ roles, onClose, onCreated }: { roles: Role[]; onClose: () => void; onCreated: () => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"password" | "invite">("password");
  const [password, setPassword] = useState("");
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ password: string | null; mode: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setSaving(true); setError(null);
    try {
      const r = await call<{ password: string | null; mode: string }>({ action: "create", email, fullName, mode, password, roleKeys });
      setDone(r); onCreated();
    } catch (e) { setError(e instanceof Error ? e.message : "Kunde inte skapa användaren."); }
    finally { setSaving(false); }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 2000); } catch { /* */ }
  }

  return (
    <div className="overlay overlay--above" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="deal-dialog usr-dlg">
        <div className="deal-dialog__header">
          <h2>{done ? "Användaren är skapad" : "Ny användare"}</h2>
          <button className="close-btn" onClick={onClose} disabled={saving} aria-label="Stäng">×</button>
        </div>

        {done ? (
          <div className="deal-dialog__body usr-dlg__body">
            {done.mode === "invite" ? (
              <p className="usr-dlg__text">En inbjudan har skickats till <strong>{email}</strong>. Länken i mejlet loggar in användaren, som sedan får välja ett eget lösenord.</p>
            ) : (
              <>
                <p className="usr-dlg__text">Ge <strong>{fullName}</strong> det tillfälliga lösenordet nedan. Det visas bara nu, och användaren måste byta det vid första inloggningen.</p>
                <div className="usr-dlg__pw">
                  <code>{done.password}</code>
                  <button className="btn btn--sm btn--ghost" onClick={() => void copy(done.password ?? "")}>{copied ? "Kopierat" : "Kopiera"}</button>
                </div>
                <p className="formfield__help">Inloggning: {email}</p>
              </>
            )}
            <div className="drawer__footer"><button className="btn btn--brand" onClick={onClose}>Klart</button></div>
          </div>
        ) : (
          <form className="deal-dialog__body usr-dlg__body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="formfield">
              <label className="label" htmlFor="usr-name">Namn</label>
              <input id="usr-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus required placeholder="Förnamn Efternamn" />
            </div>
            <div className="formfield">
              <label className="label" htmlFor="usr-email">E-post</label>
              <input id="usr-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="namn@connectestate.se" autoComplete="off" />
            </div>

            <div className="formfield">
              <span className="label">Roller</span>
              <div className="chips">
                {roles.map((r) => {
                  const on = roleKeys.includes(r.key);
                  return (
                    <button key={r.key} type="button" className="chip" aria-pressed={on}
                      onClick={() => setRoleKeys((d) => on ? d.filter((k) => k !== r.key) : [...d, r.key])}>
                      {r.name}
                    </button>
                  );
                })}
              </div>
              <div className="formfield__help">Dörrsäljare utan andra roller ser bara D2D-sälj. Administratör ser allt.</div>
            </div>

            <div className="formfield">
              <span className="label">Inloggning</span>
              <label className="usr-dlg__radio">
                <input type="radio" name="usr-mode" checked={mode === "password"} onChange={() => setMode("password")} />
                <span><strong>Tillfälligt lösenord</strong> — visas för dig när kontot skapats; användaren byter vid första inloggningen.</span>
              </label>
              <label className="usr-dlg__radio">
                <input type="radio" name="usr-mode" checked={mode === "invite"} onChange={() => setMode("invite")} />
                <span><strong>Inbjudan per e-post</strong> — användaren får en länk och väljer eget lösenord.</span>
              </label>
            </div>
            {mode === "password" && (
              <div className="formfield">
                <label className="label" htmlFor="usr-pw">Tillfälligt lösenord <span className="usr-dlg__opt">(valfritt — annars skapas ett)</span></label>
                <input id="usr-pw" className="input" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="Minst 8 tecken" autoComplete="new-password" />
              </div>
            )}

            {error && <div className="formfield__error">{error}</div>}
            <div className="drawer__footer">
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>Avbryt</button>
              <button type="submit" className="btn btn--brand" disabled={saving}>{saving ? "Skapar…" : mode === "invite" ? "Skicka inbjudan" : "Skapa användare"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
