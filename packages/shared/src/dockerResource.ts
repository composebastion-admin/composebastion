export type ResourceSnapshotLike = {
  name: string;
  data: Record<string, unknown>;
};

export type ContainerSnapshotData = {
  State?: string;
  Status?: string;
  Names?: string;
  Ports?: string;
  Image?: string;
};

export type ImageSnapshotData = {
  Repository?: string;
  Tag?: string;
};

export type NetworkSnapshotData = {
  Name?: string;
  Driver?: string;
};

export type VolumeSnapshotData = {
  Name?: string;
  Driver?: string;
};

export function containerData(resource: ResourceSnapshotLike): ContainerSnapshotData {
  return (resource.data ?? {}) as ContainerSnapshotData;
}

export function imageData(resource: ResourceSnapshotLike): ImageSnapshotData {
  return (resource.data ?? {}) as ImageSnapshotData;
}

export function containerState(resource: ResourceSnapshotLike) {
  return String(containerData(resource).State ?? "");
}

export function containerStateLabel(state: string) {
  const normalized = state.toLowerCase();
  if (normalized.includes("running")) return "running";
  if (normalized.includes("exited") || normalized.includes("dead")) return "stopped";
  if (normalized.includes("paused")) return "paused";
  if (normalized.includes("restarting")) return "restarting";
  return normalized || "unknown";
}

export function imageReference(resource: ResourceSnapshotLike) {
  const data = imageData(resource);
  if (data.Repository) return `${data.Repository}:${data.Tag ?? "latest"}`;
  return resource.name;
}

export function publishedWebLinks(hostname: string, ports: string) {
  const links: Array<{ port: string; url: string }> = [];
  const seen = new Set<string>();
  const matcher = /(?:^|,\s*)(?:\[?[0-9a-fA-F:.]+\]?:)?(\d+)->\d+\/tcp/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(ports)) !== null) {
    const port = match[1];
    if (!port || seen.has(port)) continue;
    seen.add(port);
    links.push({ port, url: `http://${hostname}:${port}` });
  }
  return links;
}

export function imageRepository(image: string) {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

export function imageTag(image: string) {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(colon + 1) : "latest";
}

export function imageWithTag(image: string, tag: string) {
  return `${imageRepository(image)}:${tag}`;
}
