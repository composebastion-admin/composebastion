import path from "node:path";
import { parse as parseYaml } from "yaml";
import { shQuote } from "./commands.js";

export type GitComposeSourceIntegrity = {
  composePath: string;
  referencedFiles: string[];
  buildContexts: string[];
  runtimePaths: string[];
};

export class GitComposeSourceIntegrityError extends Error {
  readonly code = "GIT_COMPOSE_SOURCE_INTEGRITY";
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "GitComposeSourceIntegrityError";
  }
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceIntegrityError(label: string, detail: string) {
  throw new GitComposeSourceIntegrityError(
    `${label} ${detail} Git deployments only accept source files that are literal, tracked paths inside the analyzed checkout.`
  );
}

function checkoutPath(base: string, value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    sourceIntegrityError(label, "must name a local path.");
  }
  const candidate = value as string;
  if (
    /[\u0000-\u001f\u007f]/.test(candidate)
    || candidate.includes("\\")
    || candidate.includes("$")
    || candidate.startsWith("/")
    || candidate.startsWith("~")
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate)
  ) {
    sourceIntegrityError(label, "cannot be absolute, interpolated, remote, or platform-dependent.");
  }
  const joined = path.posix.normalize(path.posix.join(base, candidate));
  const normalized = joined === "./" ? "." : joined.replace(/\/+$/, "");
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
  ) {
    sourceIntegrityError(label, "cannot escape the repository checkout.");
  }
  return normalized || ".";
}

function pathsOverlap(left: string, right: string) {
  return left === "."
    || right === "."
    || left === right
    || left.startsWith(`${right}/`)
    || right.startsWith(`${left}/`);
}

function normalizedTrackedPath(value: string) {
  if (
    !value
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.includes("\\")
    || value.startsWith("/")
  ) {
    return null;
  }
  const normalized = path.posix.normalize(value);
  return normalized === ".."
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    ? null
    : normalized;
}

function relativeShortBindSource(value: string, label: string) {
  if (value.includes("$")) {
    sourceIntegrityError(label, "must use a literal source and target.");
  }
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const source = value.slice(0, separator);
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../")
    ? source
    : null;
}

function fileEntries(value: unknown, label: string) {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    if (typeof entry === "string") return entry;
    const mapped = record(entry);
    if (mapped && typeof mapped.path === "string") return mapped.path;
    sourceIntegrityError(`${label}${entries.length > 1 ? ` entry ${index + 1}` : ""}`, "must use a literal path.");
  });
}

export function inspectGitComposeSourceIntegrity(
  composeYaml: string,
  composePath: string,
  trackedPaths: Iterable<string> = []
): GitComposeSourceIntegrity {
  const parsed = parseYaml(composeYaml, { merge: true }) as unknown;
  const document = record(parsed);
  if (!document) {
    throw new GitComposeSourceIntegrityError(
      "The analyzed Git Compose definition is not a YAML mapping."
    );
  }
  const normalizedComposePath = checkoutPath(".", composePath, "The Compose file");
  const composeDirectory = path.posix.dirname(normalizedComposePath);
  const referencedFiles = new Set<string>([normalizedComposePath]);
  const buildContexts = new Set<string>();
  const runtimePaths = new Set<string>();

  if (
    document.include !== undefined
    && document.include !== null
    && (!Array.isArray(document.include) || document.include.length > 0)
  ) {
    throw new GitComposeSourceIntegrityError(
      "Compose include is not supported for qualified Git deployment because it can add services outside the analyzed definition."
    );
  }

  const services = record(document.services);
  if (!services) {
    throw new GitComposeSourceIntegrityError(
      "The analyzed Git Compose definition must contain a services mapping."
    );
  }
  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = record(rawService);
    if (!service) continue;
    if (service.extends !== undefined && service.extends !== null) {
      throw new GitComposeSourceIntegrityError(
        `Service '${serviceName}' uses extends, which is not supported for qualified Git deployment because inherited behavior is not represented by the analyzed service ledger.`
      );
    }
    if (service.provider !== undefined && service.provider !== null) {
      throw new GitComposeSourceIntegrityError(
        `Service '${serviceName}' uses an external provider, which is not supported for qualified Git deployment.`
      );
    }

    if (service.build !== undefined && service.build !== null) {
      const build = typeof service.build === "string"
        ? { context: service.build } as Record<string, unknown>
        : record(service.build);
      if (!build) {
        sourceIntegrityError(`Service '${serviceName}' build`, "must be a local path or mapping.");
      }
      const context = checkoutPath(
        composeDirectory,
        build?.context ?? ".",
        `Service '${serviceName}' build context`
      );
      buildContexts.add(context);
      if (
        build?.additional_contexts !== undefined
        && (
          !Array.isArray(build.additional_contexts)
          || build.additional_contexts.length > 0
        )
        && (
          !record(build.additional_contexts)
          || Object.keys(record(build.additional_contexts) ?? {}).length > 0
        )
      ) {
        throw new GitComposeSourceIntegrityError(
          `Service '${serviceName}' uses additional build contexts, which are not supported for qualified Git deployment.`
        );
      }
      if (build?.dockerfile !== undefined) {
        referencedFiles.add(
          checkoutPath(context, build.dockerfile, `Service '${serviceName}' Dockerfile`)
        );
      }
    }

    for (const [field, label] of [
      ["env_file", "environment file"],
      ["label_file", "label file"]
    ] as const) {
      if (service[field] === undefined || service[field] === null) continue;
      for (const entry of fileEntries(service[field], `Service '${serviceName}' ${label}`)) {
        referencedFiles.add(checkoutPath(composeDirectory, entry, `Service '${serviceName}' ${label}`));
      }
    }

    const credentialSpec = record(service.credential_spec);
    if (credentialSpec?.file !== undefined) {
      referencedFiles.add(
        checkoutPath(
          composeDirectory,
          credentialSpec.file,
          `Service '${serviceName}' credential spec`
        )
      );
    }

    if (service.volumes !== undefined && service.volumes !== null) {
      if (!Array.isArray(service.volumes)) {
        sourceIntegrityError(
          `Service '${serviceName}' volumes`,
          "must be a list whose bind sources can be qualified."
        );
      }
      for (const [index, rawVolume] of (service.volumes as unknown[]).entries()) {
        const label = `Service '${serviceName}' volume entry ${index + 1}`;
        if (typeof rawVolume === "string") {
          const source = relativeShortBindSource(rawVolume, label);
          if (source !== null) {
            runtimePaths.add(checkoutPath(composeDirectory, source, `${label} source`));
          }
          continue;
        }
        const volume = record(rawVolume);
        if (!volume) {
          sourceIntegrityError(label, "must use Compose short or long syntax.");
        }
        if (volume?.type !== "bind") continue;
        const bindSource = volume.source ?? volume.src;
        if (
          typeof bindSource === "string"
          && bindSource.startsWith("/")
          && !/[\u0000-\u001f\u007f\\$]/.test(bindSource)
        ) {
          // A literal absolute host path is runtime state outside the checkout.
          // It neither participates in source integrity nor needs a Git status
          // exclusion.
          continue;
        }
        runtimePaths.add(
          checkoutPath(
            composeDirectory,
            bindSource,
            `${label} bind source`
          )
        );
      }
    }
  }

  for (const sectionName of ["configs", "secrets"] as const) {
    const section = record(document[sectionName]);
    if (!section) continue;
    for (const [name, rawDefinition] of Object.entries(section)) {
      const definition = record(rawDefinition);
      if (definition?.file === undefined) continue;
      referencedFiles.add(
        checkoutPath(
          composeDirectory,
          definition.file,
          `Compose ${sectionName.slice(0, -1)} '${name}' file`
        )
      );
    }
  }

  const normalizedTrackedPaths = Array.from(trackedPaths)
    .map(normalizedTrackedPath)
    .filter((value): value is string => value !== null);
  for (const runtimePath of runtimePaths) {
    const referencedOverlap = [...referencedFiles].find((candidate) =>
      pathsOverlap(runtimePath, candidate)
    );
    if (referencedOverlap) {
      throw new GitComposeSourceIntegrityError(
        `Relative bind source '${runtimePath}' overlaps qualified source file '${referencedOverlap}'. Use a named volume or a managed absolute host path outside the checkout.`
      );
    }
    const buildOverlap = [...buildContexts].find((candidate) =>
      pathsOverlap(runtimePath, candidate)
    );
    if (buildOverlap) {
      throw new GitComposeSourceIntegrityError(
        `Relative bind source '${runtimePath}' overlaps build context '${buildOverlap}'. Use a named volume or a managed absolute host path outside the checkout.`
      );
    }
    const trackedOverlap = normalizedTrackedPaths.find((candidate) =>
      pathsOverlap(runtimePath, candidate)
    );
    if (trackedOverlap) {
      throw new GitComposeSourceIntegrityError(
        `Relative bind source '${runtimePath}' overlaps tracked path '${trackedOverlap}'. Runtime bind data must remain untracked and separate from qualified source inputs.`
      );
    }
  }

  return {
    composePath: normalizedComposePath,
    referencedFiles: [...referencedFiles].sort(),
    buildContexts: [...buildContexts].sort(),
    runtimePaths: [...runtimePaths].sort()
  };
}

function runtimePathPrefixes(checkoutRoot: string, relativePath: string) {
  const prefixes: string[] = [];
  let current = checkoutRoot;
  for (const component of relativePath.split("/")) {
    current = path.posix.join(current, component);
    prefixes.push(current);
  }
  return prefixes;
}

/**
 * Returns a single fail-closed sequence: each relative runtime bind source is
 * proven untracked and symlink-free first, then only those exact path trees
 * are excluded from the checkout cleanliness check.
 */
export function gitComposeCheckoutCleanGuardCommands(
  checkoutRoot: string,
  sourceIntegrity: GitComposeSourceIntegrity,
  generatedComposePath?: string
) {
  const extraPaths: string[] = [];
  if (generatedComposePath !== undefined) {
    const generatedPath = checkoutPath(
      ".",
      generatedComposePath,
      "The generated Compose path"
    );
    if (
      generatedPath !== sourceIntegrity.composePath
      || path.posix.basename(generatedPath) !== "composebastion.generated.yaml"
    ) {
      throw new GitComposeSourceIntegrityError(
        "Only the bound composebastion.generated.yaml artifact may be excluded in addition to verified runtime bind paths."
      );
    }
    extraPaths.push(generatedPath);
  }
  const runtimeValidation = sourceIntegrity.runtimePaths.flatMap((relativePath) => {
    const absolutePath = path.posix.join(checkoutRoot, relativePath);
    return [
      `test -z "$(git --literal-pathspecs ls-files -- ${shQuote(relativePath)})"`,
      ...runtimePathPrefixes(checkoutRoot, relativePath).map((candidate) =>
        `test ! -L ${shQuote(candidate)}`
      ),
      `runtime_probe=${shQuote(absolutePath)}`,
      [
        'if test ! -e "$runtime_probe"',
        'then runtime_probe=${runtime_probe%/*}',
        'while test ! -e "$runtime_probe"; do runtime_probe=${runtime_probe%/*}; done',
        'test -d "$runtime_probe"',
        "fi"
      ].join("; "),
      'runtime_real=$(realpath "$runtime_probe")',
      'case "$runtime_real" in "$checkout_real"|"$checkout_real"/*) : ;; *) false ;; esac'
    ];
  });
  const exclusions = [...sourceIntegrity.runtimePaths, ...extraPaths]
    .map((relativePath) => shQuote(`:(exclude,literal)${relativePath}`));
  const pathspec = exclusions.length
    ? ` -- . ${exclusions.join(" ")}`
    : "";
  return [
    'checkout_real=$(pwd -P)',
    'test -n "$checkout_real"',
    ...runtimeValidation,
    `test -z "$(git status --porcelain=v1 --untracked-files=all --ignored=matching${pathspec})"`
  ];
}
