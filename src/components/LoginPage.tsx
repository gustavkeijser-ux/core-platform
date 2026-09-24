import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ThemeToggle } from "@/lib/theme";

/**
 * Konton som skapas med ett delat temporärt lösenord (t.ex. onboarding av
 * flera dörrsäljare på en gång) skapas medvetet med obekräftad e-post
 * (auth.users.email_confirmed_at = null). Supabase Auth vägrar då logga in
 * dem — signInWithPassword svarar med felkoden "email_not_confirmed" i
 * stället för att ge en session. Vi fångar det felet här och byter till ett
 * kod-flöde: resend() skickar en ny bekräftelsekod till mailen, verifyOtp()
 * kvitterar den och loggar in användaren i samma anrop (ingen ny
 * signInWithPassword behövs efteråt — verifyOtp ger en riktig session).
 *
 * OBS: för att koden faktiskt ska synas i mailet måste Supabase-projektets
 * mailmall "Confirm signup" innehålla {{ .Token }} (inte bara
 * bekräftelselänken). Det är en engångsinställning i Supabase Dashboard →
 * Authentication → Email Templates, inte något som går att sätta via SQL.
 */
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [needsVerification, setNeedsVerification] = useState(false);
  const [code, setCode] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  function isUnconfirmedError(err: { code?: string; message: string }): boolean {
    return err.code === "email_not_confirmed" || /not confirmed/i.test(err.message);
  }

  async function sendCode() {
    setResendMsg(null); setVerifyError(null);
    const { error: resendErr } = await supabase.auth.resend({ type: "signup", email });
    if (resendErr) {
      setVerifyError(resendErr.message);
    } else {
      setResendMsg("Vi har skickat en ny kod till din mail.");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) {
      if (isUnconfirmedError(signInErr)) {
        setNeedsVerification(true);
        await sendCode();
      } else {
        setError(signInErr.message);
      }
    }
    setBusy(false);
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setVerifyBusy(true);
    setVerifyError(null);
    const { error: verifyErr } = await supabase.auth.verifyOtp({
      email, token: code.trim(), type: "signup",
    });
    if (verifyErr) setVerifyError(verifyErr.message);
    // Vid lyckad verifiering sätter Supabase en session direkt — App.tsx
    // plockar upp den via onAuthStateChange, ingen ny inloggning behövs.
    setVerifyBusy(false);
  }

  if (needsVerification) {
    return (
      <div className="login-shell">
        <div style={{ position: "absolute", top: 20, right: 20 }}><ThemeToggle /></div>
        <div className="login-card">
          <h1>Bekräfta din e-post</h1>
          <p>Vi har skickat en kod till <strong>{email}</strong>. Ange den nedan för att fortsätta.</p>
          <form onSubmit={submitCode}>
            <div className="formfield">
              <label className="label" htmlFor="code">Kod</label>
              <input
                id="code" className="input" inputMode="numeric" autoFocus
                value={code} onChange={(e) => setCode(e.target.value)} required
              />
            </div>
            {verifyError && <div className="login-error">{verifyError}</div>}
            {resendMsg && <div className="d2d-save-ok">✓ {resendMsg}</div>}
            <button className="btn btn--brand" type="submit" disabled={verifyBusy}>
              {verifyBusy ? "Bekräftar…" : "Bekräfta"}
            </button>
          </form>
          <button className="btn btn--ghost btn--sm" onClick={sendCode} style={{ marginTop: 12 }}>
            Skicka koden igen
          </button>
          <button
            className="btn btn--ghost btn--sm"
            style={{ marginTop: 4 }}
            onClick={() => { setNeedsVerification(false); setCode(""); setVerifyError(null); setResendMsg(null); }}
          >
            ← Tillbaka
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-shell">
      <div style={{ position: "absolute", top: 20, right: 20 }}><ThemeToggle /></div>
      <div className="login-card">
        <h1>Logga in</h1>
        <p>Core Platform — ConnectEstate</p>
        <form onSubmit={submit}>
          <div className="formfield">
            <label className="label" htmlFor="email">E-post</label>
            <input id="email" className="input" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="formfield">
            <label className="label" htmlFor="password">Lösenord</label>
            <input id="password" className="input" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn--brand" type="submit" disabled={busy}>
            {busy ? "Loggar in…" : "Logga in"}
          </button>
        </form>
      </div>
    </div>
  );
}
