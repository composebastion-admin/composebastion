export function remoteBaseName(value: string) {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? "/";
}

export function remoteDirName(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return `/${parts.slice(0, -1).join("/")}`;
}

export function remoteJoin(directory: string, name: string) {
  return `${directory.replace(/\/+$/, "") || "/"}/${name}`.replace(/\/+/g, "/");
}

export function defaultHostDirectory(host: { username: string }) {
  return `/home/${host.username}`;
}
