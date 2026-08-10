import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEvent } from "@composebastion/shared";
import { api } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { Panel, Toolbar, VirtualDataTable } from "../ui/primitives.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";

export function AuditPanel() {
  const action = useAsyncAction();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const pageSize = 50;

  const load = useCallback(async (nextOffset = 0) => {
    const result = await api<{ events: AuditEvent[]; total?: number }>(`/api/audit?limit=${pageSize}&offset=${nextOffset}`);
    setEvents(result.events);
    setTotal(result.total ?? result.events.length);
    setOffset(nextOffset);
  }, []);

  useEffect(() => {
    void action.run(() => load(0)).catch(() => undefined);
  }, [action.run, load]);

  const filteredEvents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return events;
    return events.filter((event) => [
      event.action,
      event.targetKind ?? "",
      event.targetId ?? "",
      event.hostId ?? "",
      event.userId ?? "",
      JSON.stringify(event.details)
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [events, query]);

  return (
    <Panel title="Audit Log" count={total}>
      <Toolbar className="compactToolbar">
        <label>
          <span className="srOnly">Filter audit events</span>
          <input
            aria-label="Filter audit events"
            placeholder="Filter action, target, host, user, or details"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" disabled={action.busy} onClick={() => void action.run(() => load(offset)).catch(() => undefined)}>Refresh audit</button>
        <span>{filteredEvents.length} shown · {total} total</span>
      </Toolbar>
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
      <VirtualDataTable
        rows={filteredEvents}
        columns={["Time", "Action", "Target", "Details"]}
        render={(event) => [
          formatDate(event.createdAt),
          event.action,
          [event.targetKind, event.targetId].filter(Boolean).join(" / "),
          <details key="details">
            <summary>View redacted details</summary>
            <code>{JSON.stringify(event.details)}</code>
          </details>
        ]}
      />
      {total > pageSize && (
        <Toolbar className="compactToolbar">
          <button
            type="button"
            disabled={action.busy || offset === 0}
            onClick={() => void action.run(() => load(Math.max(0, offset - pageSize))).catch(() => undefined)}
          >
            Newer events
          </button>
          <span>{offset + 1}-{Math.min(offset + events.length, total)} of {total}</span>
          <button
            type="button"
            disabled={action.busy || offset + events.length >= total}
            onClick={() => void action.run(() => load(offset + pageSize)).catch(() => undefined)}
          >
            Older events
          </button>
        </Toolbar>
      )}
    </Panel>
  );
}
