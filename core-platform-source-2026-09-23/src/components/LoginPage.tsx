import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ThemeToggle } from "@/lib/theme";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
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
