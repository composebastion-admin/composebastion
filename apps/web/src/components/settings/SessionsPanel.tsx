import { useCallback, useEffect, useState } from "react";
import { LogOut, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { Session } from "@composebastion/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { describeUserAgent } from "../../lib/userAgent.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { useConfirm } from "../ConfirmProvider.js";
import { ButtonRow } from "../ui/primitives.js";

function relativeActivity(value: string | null) {
  if (!value) return "activity pending";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "active just now";
  if (seconds < 3600) return `active ${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `active ${Math.round(seconds / 3600)}h ago`;
  return `active ${Math.round(seconds / 86_400)}d ago`;
}

export function SessionsPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const { busy, error, run } = useAsyncAction();
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    const result = await api<{ sessions: Session[] }>("/api/auth/sessions");
    setSessions(result.sessions);
  }, []);

  useEffect(() => {
    void run(load).catch(() => undefined);
  }, [load, run]);

  async function revoke(session: Session) {
    const confirmed = await confirm({
      title: "Revoke session",
      message: `Revoke ${describeUserAgent(session.userAgent)}? That browser will need to sign in again.`,
      confirmLabel: "Revoke",
      tone: "danger"
    });
    if (!confirmed) return;
    await run(async () => {
      await deleteJson(`/api/auth/sessions/${session.id}`);
      await load();
    });
  }

  async function logoutEverywhere() {
    const confirmed = await confirm({
      title: "Log out everywhere",
      message: "This will end every active session for your account, including this browser.",
      confirmLabel: "Log out everywhere",
      tone: "danger"
    });
    if (!confirmed) return;
    await run(async () => {
      await postJson("/api/auth/logout-all", {});
      window.location.reload();
    });
  }

  return (
    <div className="subPanel">
      <div className="panelHeader">
        <h3>Active Sessions</h3>
        <ButtonRow>
          <button type="button" onClick={() => void run(load).catch(() => undefined)} disabled={busy}><RefreshCw size={16} />Refresh</button>
          <button type="button" className="danger" onClick={() => void logoutEverywhere().catch(() => undefined)} disabled={busy}><LogOut size={16} />Log out everywhere</button>
        </ButtonRow>
      </div>
      <div className="sessionList">
        {sessions.map((session) => (
          <div className="sessionRow" key={session.id}>
            <div className="sessionIcon"><ShieldCheck size={18} /></div>
            <div className="sessionDetails">
              <div className="sessionTitle">
                <strong>{describeUserAgent(session.userAgent)}</strong>
                {session.current && <span className="sessionBadge">This device</span>}
              </div>
              <div className="sessionMeta">
                <span>{session.ipAddress ?? "Unknown IP"}</span>
                <span>{relativeActivity(session.lastSeenAt ?? session.createdAt)}</span>
                <span>Created {formatDate(session.createdAt)}</span>
              </div>
            </div>
            <ButtonRow>
              {!session.current && (
                <button type="button" className="danger" onClick={() => void revoke(session).catch(() => undefined)} disabled={busy}>
                  <Trash2 size={16} />
                  Revoke
                </button>
              )}
            </ButtonRow>
          </div>
        ))}
        {sessions.length === 0 && <div className="formHint">No active sessions found.</div>}
      </div>
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
