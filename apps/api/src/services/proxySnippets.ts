import type { ProxySnippet } from "@dockermender/shared";

type ProxyInput = {
  domains: string[];
  exposedService: string | null;
  exposedPort: number | null;
  tlsDesired: boolean;
  projectName: string;
};

export function buildProxySnippets(input: ProxyInput): ProxySnippet {
  const warnings: string[] = [];
  const service = input.exposedService ?? "app";
  const port = input.exposedPort ?? 80;
  const host = input.domains[0] ?? `stack-${input.projectName}.example.com`;

  if (input.domains.length === 0) {
    warnings.push("Add at least one domain before applying reverse-proxy labels.");
  }
  if (!input.exposedService) {
    warnings.push("Exposed service is not set; defaulting to 'app'.");
  }
  if (!input.exposedPort) {
    warnings.push("Exposed port is not set; defaulting to 80.");
  }
  if (input.tlsDesired && input.domains.length === 0) {
    warnings.push("TLS is enabled but no domain is configured.");
  }

  const router = `${input.projectName}-${service}`;
  const traefikLabels = [
    `traefik.enable=true`,
    `traefik.http.routers.${router}.rule=Host(\`${host}\`)`,
    `traefik.http.routers.${router}.entrypoints=web`,
    `traefik.http.services.${router}.loadbalancer.server.port=${port}`
  ];
  if (input.tlsDesired) {
    traefikLabels.push(`traefik.http.routers.${router}.entrypoints=websecure`);
    traefikLabels.push(`traefik.http.routers.${router}.tls=true`);
    traefikLabels.push(`traefik.http.routers.${router}.tls.certresolver=letsencrypt`);
  }

  const caddySnippet = `${host} {
  reverse_proxy ${service}:${port}
}`;

  return { traefikLabels, caddySnippet, warnings };
}

function extractLabelValue(line: string) {
  const match = line.trim().match(/^- ["']?(.+?)["']?$/);
  return match?.[1] ?? line.trim();
}

export function mergeTraefikLabelsIntoCompose(composeYaml: string, serviceName: string, traefikLabels: string[]) {
  const lines = composeYaml.split(/\r?\n/);
  const servicePattern = new RegExp(`^  ${serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);
  const start = lines.findIndex((line) => servicePattern.test(line));
  if (start < 0) throw new Error(`Service '${serviceName}' was not found in compose YAML`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^  \S/.test(line) && !line.startsWith("    ")) {
      end = index;
      break;
    }
  }

  const block = lines.slice(start, end);
  const formatted = traefikLabels.map((label) => `      - "${label.replace(/"/g, '\\"')}"`);
  const labelsIndex = block.findIndex((line) => /^    labels:\s*$/.test(line));

  let nextBlock: string[];
  if (labelsIndex >= 0) {
    let labelsEnd = labelsIndex + 1;
    while (labelsEnd < block.length && /^      - /.test(block[labelsEnd] ?? "")) labelsEnd += 1;
    const existing = new Set(
      block.slice(labelsIndex + 1, labelsEnd).map((line) => extractLabelValue(line.replace(/^      /, "")))
    );
    const merged = formatted.filter((line) => !existing.has(extractLabelValue(line.replace(/^      /, ""))));
    nextBlock = [...block.slice(0, labelsEnd), ...merged, ...block.slice(labelsEnd)];
  } else {
    nextBlock = [...block, "    labels:", ...formatted];
  }

  return [...lines.slice(0, start), ...nextBlock, ...lines.slice(end)].join("\n");
}
