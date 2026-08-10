import { parse as parseYaml } from "yaml";
import {
  interpolateDeploymentEnvironment,
  parseDeploymentEnvironment
} from "./deploymentEnvironment.js";

export function inspectImagesFromCompose(
  composeYaml: string,
  environment?: string | Map<string, string>
) {
  const parsedEnvironment = typeof environment === "string"
    ? parseDeploymentEnvironment(environment)
    : environment;
  const parsed = parseYaml(composeYaml, { merge: true }) as {
    services?: Record<string, { image?: unknown } | null>;
  } | null;
  const images = new Set<string>();
  let unresolved = false;
  for (const service of Object.values(parsed?.services ?? {})) {
    if (!service || typeof service.image !== "string") continue;
    const image = parsedEnvironment
      ? interpolateDeploymentEnvironment(service.image, parsedEnvironment)
      : resolveImageDefaults(service.image);
    // Without a bound environment, unresolved references cannot safely be
    // passed to the Docker registry-reference parser.
    if (image.includes("$")) {
      unresolved = true;
      continue;
    }
    if (image) images.add(image);
  }
  return { images: [...images], unresolved };
}

export function extractImagesFromCompose(
  composeYaml: string,
  environment?: string | Map<string, string>
) {
  return inspectImagesFromCompose(composeYaml, environment).images;
}

/**
 * Compose permits `image: registry/app:${TAG:-latest}`. A literal fallback can
 * still locate saved credentials before an environment has been supplied.
 */
function resolveImageDefaults(image: string) {
  return image.replace(
    /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-)([^${}]*)\}/g,
    "$1"
  );
}
