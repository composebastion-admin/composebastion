import type { FormEvent } from "react";
import { useState } from "react";
import { Moon, ShieldCheck, Sun } from "lucide-react";
import type { AdminUser } from "@composebastion/shared";
import { postJson } from "../api.js";
import { BrandLockup } from "./ui/BrandLockup.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { emptyToUndefined } from "../lib/format.js";
import type { Theme } from "../lib/theme.js";

export function AuthPanel({
  needsSetup,
  theme,
  onToggleTheme,
  onAuthenticated
}: {
  needsSetup: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onAuthenticated: (user: AdminUser) => void;
}) {
  const action = useAsyncAction();
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [includeDemoData, setIncludeDemoData] = useState(true);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const path = needsSetup ? "/api/auth/setup" : "/api/auth/login";
      const result = await postJson<{ user: AdminUser }>(
        path,
        needsSetup ? { username, email: emptyToUndefined(email), password, includeDemoData } : { identifier, password }
      );
      onAuthenticated(result.user);
    });
  }

  return (
    <main className="authShell">
      <button type="button" className="themeButton authThemeButton" onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle theme">
        {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <section className="authPanel">
        <BrandLockup titleAs="h1" />
        <p className="authIntro">{needsSetup ? "Create the first administrator account." : "Sign in to manage your Docker hosts."}</p>
        <form onSubmit={submit} className="stack">
          {needsSetup ? (
            <>
              <label>
                Username
                <input value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={50} required />
              </label>
              <label>
                Email, optional
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
              </label>
            </>
          ) : (
            <label>
              Username or email
              <input value={identifier} onChange={(event) => setIdentifier(event.target.value)} required autoComplete="username" />
            </label>
          )}
          <label>
            Password
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              minLength={needsSetup ? 12 : 1}
              required
              autoComplete={needsSetup ? "new-password" : "current-password"}
            />
          </label>
          {needsSetup && (
            <label className="checkLine">
              <input type="checkbox" checked={includeDemoData} onChange={(event) => setIncludeDemoData(event.target.checked)} />
              Include demo workspace
            </label>
          )}
          {action.error && <div className="notice error" role="alert">{action.error}</div>}
          <button className="primary" type="submit" disabled={action.busy}>
            <ShieldCheck size={18} aria-hidden />
            {needsSetup ? "Create Admin" : "Sign In"}
          </button>
        </form>
      </section>
    </main>
  );
}
