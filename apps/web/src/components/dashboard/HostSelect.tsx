import type { DockerHost } from "@composebastion/shared";

export function HostSelect({ hosts, value, onChange }: { hosts: DockerHost[]; value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} required>
      <option value="">Select host</option>
      {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
    </select>
  );
}
