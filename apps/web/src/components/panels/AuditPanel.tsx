import { useCallback, useEffect, useState } from "react";
import type { AuditEvent } from "@dockermender/shared";
import { api } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { Panel, VirtualDataTable } from "../ui/primitives.js";

export function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[]>([]);

  const load = useCallback(async () => {
    const result = await api<{ events: AuditEvent[] }>("/api/audit?limit=200");
    setEvents(result.events);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel title="Audit Log" count={events.length}>
      <VirtualDataTable
        rows={events}
        columns={["Time", "Action", "Target", "Details"]}
        render={(event) => [
          formatDate(event.createdAt),
          event.action,
          [event.targetKind, event.targetId].filter(Boolean).join(" / "),
          <code key="details">{JSON.stringify(event.details)}</code>
        ]}
      />
    </Panel>
  );
}
