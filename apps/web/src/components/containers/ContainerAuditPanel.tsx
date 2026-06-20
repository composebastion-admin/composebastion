import { useEffect, useState } from "react";
import type { DockerHost, ResourceSnapshot } from "@dockermender/shared";
import { api } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { DataTable, Panel } from "../ui/primitives.js";

export function ContainerAuditPanel({ host, container, onClose }: { host: DockerHost; container: ResourceSnapshot; onClose: () => void }) {
  const data = container.data as any;
  const details = {
    host: host.name,
    container: data.Names ?? container.name,
    id: container.externalId,
    image: data.Image ?? "",
    state: data.State ?? "",
    ports: data.Ports ?? "",
    size: data.Size ?? "",
    synced: formatDate(container.updatedAt)
  };

  return (
    <div className="drawer">
      <div className="panelHeader">
        <h3>Container Audit</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <div className="statGrid">
        {Object.entries(details).map(([key, value]) => <span key={key}><strong>{key}</strong>{String(value)}</span>)}
      </div>
    </div>
  );
}
