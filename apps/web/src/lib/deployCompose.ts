export type SingleImageComposeInput = {
  image: string;
  serviceName: string;
  restartPolicy: string;
  ports: string;
  env: string;
  volumes: string;
  command: string;
  alwaysPullLatest: boolean;
};

export function imageWithDefaultLatest(value: string) {
  const image = value.trim();
  if (!image || image.includes("@")) return image;
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image : `${image}:latest`;
}

export function imageBaseName(value: string) {
  const image = imageWithDefaultLatest(value).split("@")[0] ?? "";
  const slash = image.lastIndexOf("/");
  const nameWithTag = slash >= 0 ? image.slice(slash + 1) : image;
  const colon = nameWithTag.lastIndexOf(":");
  return (colon >= 0 ? nameWithTag.slice(0, colon) : nameWithTag) || "app";
}

export function normalizeComposeServiceName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 80) || "app";
}

function nonEmptyLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function quoteYaml(value: string) {
  return JSON.stringify(value);
}

export function generateSingleImageCompose(input: SingleImageComposeInput) {
  const serviceName = normalizeComposeServiceName(input.serviceName || imageBaseName(input.image));
  const lines = [
    "services:",
    `  ${serviceName}:`,
    `    image: ${quoteYaml(imageWithDefaultLatest(input.image))}`
  ];
  if (input.alwaysPullLatest) lines.push("    pull_policy: always");
  if (input.restartPolicy && input.restartPolicy !== "no") lines.push(`    restart: ${quoteYaml(input.restartPolicy)}`);
  const ports = nonEmptyLines(input.ports);
  if (ports.length > 0) {
    lines.push("    ports:");
    for (const port of ports) lines.push(`      - ${quoteYaml(port)}`);
  }
  const env = nonEmptyLines(input.env);
  if (env.length > 0) {
    lines.push("    environment:");
    for (const item of env) lines.push(`      - ${quoteYaml(item)}`);
  }
  const volumes = nonEmptyLines(input.volumes);
  if (volumes.length > 0) {
    lines.push("    volumes:");
    for (const volume of volumes) lines.push(`      - ${quoteYaml(volume)}`);
  }
  if (input.command.trim()) lines.push(`    command: ${quoteYaml(input.command.trim())}`);
  return `${lines.join("\n")}\n`;
}
