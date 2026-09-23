import { useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { updateTenantBranding, uploadTenantLogo, DataError, type TenantBranding } from "@/lib/data";

type Props = {
  session: Session;
  onClose: () => void;
  /** Nuvarande varumärkesbranding, om den redan är inläst i appen. */
  branding?: TenantBranding | null;
  /** Från servern (is_admin()), inte JWT:ets app_metadata.role — den visade
   *  sig opålitlig (saknades för admin-användare, se kommentaren nedan). */
  isAdmin?: boolean;
  /** Anropas efter en lyckad ändring så att sidomenyn uppdateras direkt. */
  onBrandingChanged?: () => void;
};

const DEFAULT_BRAND_COLOR = "#2f6fed";

export function UserSettings({ session, onClose, branding, isAdmin, onBrandingChanged }: Props) {
  const [changingPw, setChangingPw] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState(false);

  // ── Utseende: varumärkesfärg + logotyp ──────────────────────────────────
  const [brandColor, setBrandColor] = useState(branding?.brandColor ?? DEFAULT_BRAND_COLOR);
  const [customColor, setCustomColor] = useState(!!branding?.brandColor);
  const [savingBrand, setSavingBrand] = useState(false);
  const [brandMsg, setBrandMsg] = useState<string | null>(null);
  const [brandErr, setBrandErr] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  async function saveBrandColor() {
    setSavingBrand(true);
    setBrandMsg(null);
    try {
      await updateTenantBranding(customColor ? brandColor : null, branding?.logoUrl ?? null);
      setBrandMsg("Sparat.");
      setBrandErr(false);
      onBrandingChanged?.();
    } catch (e) {
      setBrandMsg(e instanceof DataError ? e.message : "Kunde inte spara färgen.");
      setBrandErr(true);
    } finally {
      setSavingBrand(false);
    }
  }

  async function handleLogoFile(file: File) {
    setUploadingLogo(true);
    setBrandMsg(null);
    try {
      const url = await uploadTenantLogo(file);
      await updateTenantBranding(customColor ? brandColor : (branding?.brandColor ?? null), url);
      setBrandMsg("Logotyp uppladdad.");
      setBrandErr(false);
      onBrandingChanged?.();
    } catch (e) {
      setBrandMsg(e instanceof DataError ? e.message : "Kunde inte ladda upp logotypen.");
      setBrandErr(true);
    } finally {
      setUploadingLogo(false);
    }
  }

  async function removeLogo() {
    setSavingBrand(true);
    setBrandMsg(null);
    try {
      await updateTenantBranding(customColor ? brandColor : null, null);
      setBrandMsg("Logotyp borttagen.");
      setBrandErr(false);
      onBrandingChanged?.();
    } catch (e) {
      setBrandMsg(e instanceof DataError ? e.message : "Kunde inte ta bort logotypen.");
      setBrandErr(true);
    } finally {
      setSavingBrand(false);
    }
  }

  async function changePassword() {
    if (newPw.length < 8) { setPwMsg("Lösenordet måste vara minst 8 tecken."); setPwErr(true); return; }
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw });
      if (error) { setPwMsg(error.message); setPwErr(true); }
      else { setPwMsg("Lösenordet uppdaterat!"); setPwErr(false); setNewPw(""); setChangingPw(false); }
    } catch { setPwMsg("Något gick fel."); setPwErr(true); }
  }

  const meta = session.user.app_metadata ?? {};

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__header">
          <h2>Inställningar</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="settings-section">
          <div className="section-title">Profil</div>
          <dl className="field-list">
            <div>
              <dt>E-post</dt>
              <dd>{session.user.email}</dd>
            </div>
            <div>
              <dt>Användar-ID</dt>
              <dd style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>{session.user.id}</dd>
            </div>
            {meta.tenant_id && (
              <div>
                <dt>Tenant</dt>
                <dd style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>{meta.tenant_id}</dd>
              </div>
            )}
            {/* Nyckeln i app_metadata heter 'role'. 'role_key' fanns aldrig,
                så rollen visades aldrig — behålls som reserv. */}
            {(meta.role ?? meta.role_key) && (
              <div>
                <dt>Roll</dt>
                <dd>{String(meta.role ?? meta.role_key)}</dd>
              </div>
            )}
            {(meta.department ?? meta.department_key) && (
              <div>
                <dt>Avdelning</dt>
                <dd>{String(meta.department ?? meta.department_key)}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="settings-section">
          <div className="section-title">Säkerhet</div>
          {!changingPw ? (
            <button className="btn btn--ghost" onClick={() => setChangingPw(true)}>Byt lösenord</button>
          ) : (
            <div className="form-grid" style={{ maxWidth: 360 }}>
              <div className="formfield formfield--wide">
                <label className="label" htmlFor="new-pw">Nytt lösenord</label>
                <input
                  id="new-pw"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="Minst 8 tecken"
                />
              </div>
              <div className="formfield formfield--wide" style={{ flexDirection: "row", gap: "var(--sp-3)" }}>
                <button className="btn btn--brand btn--sm" onClick={changePassword} disabled={!newPw}>Spara</button>
                <button className="btn btn--ghost btn--sm" onClick={() => { setChangingPw(false); setNewPw(""); setPwMsg(null); }}>Avbryt</button>
              </div>
            </div>
          )}
          {pwMsg && <div className={pwErr ? "formfield__error" : "formfield__help"} style={{ marginTop: "var(--sp-2)" }}>{pwMsg}</div>}
        </div>

        {isAdmin && (
          <div className="settings-section">
            <div className="section-title">Utseende</div>
            <p className="formfield__help" style={{ marginBottom: "var(--sp-3)" }}>
              Anpassa sidomenyns färg och logotyp till era varumärkesfärger. Gäller för
              alla användare i organisationen.
            </p>

            <div className="form-grid" style={{ maxWidth: 420 }}>
              <div className="formfield">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={customColor}
                    onChange={(e) => setCustomColor(e.target.checked)}
                  />
                  <span className="switch__track" aria-hidden="true" />
                  <span className="switch__label">Anpassad menyfärg</span>
                </label>
              </div>

              {customColor && (
                <div className="formfield" style={{ flexDirection: "row", alignItems: "center", gap: "var(--sp-3)" }}>
                  <input
                    type="color"
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    style={{ width: 44, height: 32, padding: 0, border: "1px solid var(--border)", borderRadius: "var(--r-sm)", cursor: "pointer" }}
                  />
                  <input
                    className="input"
                    style={{ maxWidth: 120, fontFamily: "var(--font-mono)" }}
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    placeholder="#2f6fed"
                  />
                </div>
              )}

              <div className="formfield formfield--wide" style={{ flexDirection: "row", gap: "var(--sp-3)" }}>
                <button className="btn btn--brand btn--sm" onClick={saveBrandColor} disabled={savingBrand}>
                  {savingBrand ? "Sparar…" : "Spara färg"}
                </button>
              </div>

              <div className="formfield formfield--wide">
                <label className="label" htmlFor="logo-upload">Logotyp</label>
                {branding?.logoUrl && (
                  <div style={{ marginBottom: "var(--sp-2)" }}>
                    <img src={branding.logoUrl} alt="Nuvarande logotyp" style={{ maxHeight: 40, maxWidth: 200, objectFit: "contain" }} />
                  </div>
                )}
                <input
                  id="logo-upload"
                  className="input"
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  disabled={uploadingLogo}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleLogoFile(file);
                    e.target.value = "";
                  }}
                />
                <div className="formfield__help">
                  Ersätter texten "ConnectEstate" högst upp i sidomenyn. PNG, JPG, SVG eller WebP.
                </div>
                {branding?.logoUrl && (
                  <button className="btn btn--ghost btn--sm" style={{ marginTop: "var(--sp-2)" }} onClick={removeLogo} disabled={savingBrand}>
                    Ta bort logotyp
                  </button>
                )}
              </div>
            </div>

            {brandMsg && <div className={brandErr ? "formfield__error" : "formfield__help"} style={{ marginTop: "var(--sp-2)" }}>{brandMsg}</div>}
          </div>
        )}

        <div className="settings-section">
          <div className="section-title">Om</div>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--ink-muted)" }}>
            ConnectEstate Core Platform v0.2<br />
            Metadata-driven CRM · Supabase + React
          </p>
        </div>
      </div>
    </div>
  );
}
