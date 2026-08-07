import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { AdminUser } from "@composebastion/shared";
import { api } from "./api.js";
import { AuthPanel } from "./components/AuthPanel.js";
import { ConfirmProvider } from "./components/ConfirmProvider.js";
import { Dashboard } from "./components/Dashboard.js";
import { LoadingBoot } from "./components/LoadingBoot.js";
import { ToastProvider } from "./components/ToastProvider.js";
import { applyTheme, getInitialTheme, watchSystemTheme, type Theme } from "./lib/theme.js";

export function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => watchSystemTheme(setTheme), []);

  const refreshAuth = useCallback(async () => {
    setConnectionError(null);
    try {
      const setup = await api<{ needsSetup: boolean }>("/api/auth/setup-state");
      setNeedsSetup(setup.needsSetup);
      if (!setup.needsSetup) {
        try {
          const me = await api<{ user: AdminUser }>("/api/auth/me");
          setUser(me.user);
        } catch {
          setUser(null);
        }
      }
    } catch (err) {
      // Never leave the app stuck on the boot spinner if the server is unreachable.
      setConnectionError(err instanceof Error ? err.message : "Unable to reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  const toggleTheme = () => setTheme((value) => value === "dark" ? "light" : "dark");

  return (
    <ToastProvider>
      <ConfirmProvider>
        {loading ? (
          <LoadingBoot />
        ) : connectionError && !user ? (
          <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, textAlign: "center" }}>
            <div style={{ maxWidth: 420 }}>
              <h2>Can't reach the server</h2>
              <p style={{ color: "var(--subtle)" }}>{connectionError}</p>
              <button className="primary" onClick={() => { setLoading(true); void refreshAuth(); }}>Retry</button>
            </div>
          </div>
        ) : !user ? (
          <AuthPanel needsSetup={needsSetup} theme={theme} onToggleTheme={toggleTheme} onAuthenticated={setUser} />
        ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route
              path="/:tab"
              element={<Dashboard user={user} theme={theme} onToggleTheme={toggleTheme} onLogout={() => setUser(null)} />}
            />
          </Routes>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}
