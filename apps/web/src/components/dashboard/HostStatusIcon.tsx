import { Wifi, WifiOff } from "lucide-react";
import type { DockerHost } from "@dockermender/shared";

export function HostStatusIcon({ status }: { status: DockerHost["lastStatus"] }) {
  if (status === "online") return <Wifi size={16} className="ok" />;
  if (status === "offline") return <WifiOff size={16} className="danger" />;
  return <Wifi size={16} className="warn" />;
}
