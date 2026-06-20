import { statusClassName } from "../../lib/dockerMetrics.js";

export function ContainerStatePill({ state }: { state: string }) {
  return <span className={`statePill ${statusClassName(state)}`}>{state}</span>;
}
