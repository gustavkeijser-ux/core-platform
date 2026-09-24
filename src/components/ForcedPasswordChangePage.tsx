import { useState } from "react";
import { completePasswordChange, DataError } from "@/lib/data";
import { ThemeToggle } from "@/lib/theme";

/**
 * Visas i stället för resten av appen när get_metadata().mustChangePassword
 * är true (konto skapat med delat/temporärt lösenord — se
 * 0018_forced_password_change.sql). Går inte att stänga eller navigera
 * förbi; enda vägen vidare är att sätta ett eget lösenord.
 */
export function ForcedPasswordChangePage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Lösenordet måste vara minst 8 tecken.");
      return;
    }
    if (password !== confirm) {
      setError("Lösenorden matchar inte.");
      return;
    }
    setBusy(true);
    try {
      await completePasswordChange(password);
      onDone();
    } catch (e) {
      setError(e instanceof DataError ? e.message : "Kunde inte byta lösenord.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div style={{ position: "absolute", top: 20, right: 20 }}><ThemeToggle /></div>
      <div className="login-card">
        <h1>Byt lösenord</h1>
        <p>Du loggade in med ett tillfälligt lösenord. Sätt ett eget innan du fortsätter.</p>
        <form onSubmit={submit}>
          <div className="formfield">
            <label className="label" htmlFor="new-password">Nytt lösenord</label>
            <input
              id="new-password" className="input" type="password" autoFocus
              value={password} onChange={(e) => setPassword(e.target.value)} required
            />
          </div>
          <div className="formfield">
            <label className="label" htmlFor="confirm-password">Bekräfta lösenord</label>
            <input
              id="confirm-password" className="input" type="password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} required
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button className="btn btn--brand" type="submit" disabled={busy}>
            {busy ? "Sparar…" : "Byt lösenord och fortsätt"}
          </button>
        </form>
      </div>
    </div>
  );
}
