export type HostTerminalPhase = "warning" | "connecting" | "ready" | "closed" | "error";

export function terminalPhaseLabel(phase: HostTerminalPhase, hostName: string) {
  if (phase === "connecting") return `Connecting to ${hostName}`;
  if (phase === "ready") return `Connected to ${hostName}`;
  if (phase === "closed") return `Terminal disconnected from ${hostName}`;
  if (phase === "error") return `Terminal connection error for ${hostName}`;
  return "Terminal confirmation required";
}
