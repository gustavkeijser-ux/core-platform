import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import "./tokens.css";
import "./app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      {import.meta.env.VITE_MILJO === "test" && (
        // Testmiljön (test.crm.connectestate.se): tydlig markering så ingen tror att det är riktiga CRM:et.
        <div role="note" style={{ position: "sticky", top: 0, zIndex: 1000, padding: "var(--sp-1) var(--sp-3)", textAlign: "center",
          fontSize: "var(--text-xs)", fontWeight: 700, background: "var(--warn-soft)", color: "var(--warn-ink)" }}>
          TESTMILJÖ – ändringar här påverkar inte riktiga CRM:et
        </div>
      )}
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
