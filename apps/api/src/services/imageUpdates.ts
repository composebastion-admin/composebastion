import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import {
  canonicalizeDockerRegistryAuthority,
  normalizeSavedRegistryOrigin,
  type ImageUpdateCheck,
  type ImageUpdatePreview
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import { isDemoHostId } from "./demo.js";
import { listLatestScans } from "./imageScanner.js";
import { decryptSecret } from "./crypto.js";
import {
  fetchRegistryManifestDigests,
  isDanglingImageReference,
  parseImageReference,
  RegistryLookupError
} from "./registryManifest.js";

const CHECK_CONCURRENCY = 4;

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function mutableTagRisk(imageReference: string) {
  if (/:(latest|main|master|nightly|edge|dev)$/i.test(imageReference.trim())) {
    return "Mutable tags like latest can change without warning. Prefer pinned digests for production.";
  }
  return null;
}

function registryTargetFromUrl(url: string, insecure: boolean) {
  try {
    const origin = normalizeSavedRegistryOrigin(url, {
      defaultProtocol: insecure ? "http" : "https"
    });
    const parsed = new URL(origin);
    return {
      host: canonicalizeDockerRegistryAuthority(parsed.host),
      origin,
      insecure: parsed.protocol === "http:"
    };
  } catch {
    return null;
  }
}

export async function findRegistryAuthForReference(imageReference: string) {
  const parsed = parseImageReference(imageReference);
  const referenceHost = canonicalizeDockerRegistryAuthority(parsed.registry);
  const result = await query<any>("SELECT * FROM registries ORDER BY name ASC");
  for (const row of result.rows) {
    const target = registryTargetFromUrl(String(row.url), Boolean(row.insecure));
    if (!target) continue;
    if (target.host !== referenceHost) continue;
    return {
      id: row.id as string,
      // Docker CLI login expects the server authority, while HTTP policy uses
      // the exact normalized origin below.
      url: new URL(target.origin).host,
      username: row.username as string | null,
      password: row.password_encrypted ? decryptSecret(row.password_encrypted) : null,
      insecure: target.insecure,
      trustedOrigin: target.origin
    };
  }
  return null;
}

type LookupOutcome = {
  remoteDigest: string | null;
  status: ImageUpdateCheck["status"];
  riskNote: string | null;
};

export function resolveImageUpdateOutcome(input: {
  currentDigest: string | null;
  remoteDigest: string | null;
  remoteEquivalentDigests?: string[];
  mutableRisk: string | null;
  lookupError: RegistryLookupError | Error | null;
  hasStoredAuth: boolean;
}): LookupOutcome {
  const { currentDigest, remoteDigest, remoteEquivalentDigests = [], mutableRisk, lookupError, hasStoredAuth } = input;

  if (lookupError) {
    const reason = lookupError instanceof RegistryLookupError ? lookupError.reason : "network";
    // Anonymous lookups that come back not-found/unauthorized mean the registry has
    // no public image by this name: almost always an image built on the host. That
    // is normal, not an error. Rejected stored credentials stay a real error.
    if (!hasStoredAuth && (reason === "not_found" || reason === "unauthorized")) {
      return {
        remoteDigest: null,
        status: "local",
        riskNote: "Not in a public image registry; likely built on this host. If it belongs to a private image registry, add registry credentials under Settings → Registries to track updates."
      };
    }
    if (reason === "unauthorized") {
      return {
        remoteDigest: null,
        status: "error",
        riskNote: `${lookupError.message}. Check the credentials saved under Settings → Registries.`
      };
    }
    return { remoteDigest: null, status: "error", riskNote: lookupError.message };
  }

  if (remoteDigest && currentDigest) {
    const normalizedCurrentDigest = normalizeLocalDigest(currentDigest);
    const normalizedRemoteDigest = normalizeLocalDigest(remoteDigest);
    const equivalentDigest = remoteEquivalentDigests
      .map(normalizeLocalDigest)
      .find((digest) => Boolean(digest) && digest === normalizedCurrentDigest);
    return normalizedRemoteDigest !== normalizedCurrentDigest && !equivalentDigest
      ? { remoteDigest, status: "update_available", riskNote: mutableRisk }
      : { remoteDigest: equivalentDigest ?? normalizedRemoteDigest ?? remoteDigest, status: "up_to_date", riskNote: mutableRisk };
  }
  if (remoteDigest && !currentDigest) {
    return {
      remoteDigest,
      status: "unknown",
      riskNote: "The registry has this tag, but the local copy has no registry digest (likely built locally). Pull to start tracking updates."
    };
  }
  return { remoteDigest: null, status: mutableRisk ? "unknown" : "up_to_date", riskNote: mutableRisk };
}

export function mapImageUpdateCheck(row: any, severityCounts?: ImageUpdateCheck["severityCounts"]): ImageUpdateCheck {
  return {
    id: row.id,
    hostId: row.host_id,
    imageReference: row.image_reference,
    currentDigest: row.current_digest ?? null,
    remoteDigest: row.remote_digest ?? null,
    status: row.status,
    riskNote: row.risk_note ?? null,
    affectedContainers: row.affected_containers ?? [],
    affectedStacks: row.affected_stacks ?? [],
    lastCheckedAt: iso(row.last_checked_at)!,
    severityCounts
  };
}

export async function listImageUpdateChecks(hostId?: string) {
  const result = hostId
    ? await query(`SELECT * FROM image_update_checks WHERE host_id = $1 ORDER BY image_reference ASC`, [hostId])
    : await query(`SELECT * FROM image_update_checks ORDER BY host_id, image_reference ASC`);
  const scans = await listLatestScans(hostId);
  const scanByImage = new Map(scans.map((scan) => [`${scan.hostId}:${scan.imageReference}`, scan]));
  return result.rows.map((row) => {
    const scan = scanByImage.get(`${row.host_id}:${row.image_reference}`);
    return mapImageUpdateCheck(row, scan?.severityCounts);
  });
}

function credentialHint(update: ImageUpdateCheck | null) {
  const note = update?.riskNote ?? "";
  if (update?.status === "local" && /private|credentials/i.test(note)) {
    return "Add registry credentials if this image belongs to a private repository.";
  }
  if (update?.status === "error" && /credential|unauthorized|authentication/i.test(note)) {
    return "Check or add registry credentials under Settings -> Registries.";
  }
  return null;
}

function safeAction(update: ImageUpdateCheck | null): ImageUpdatePreview["safeAction"] {
  if (!update) return "none";
  if (update.status === "local") return credentialHint(update) ? "add_credentials" : "none";
  if (update.status === "error") return credentialHint(update) ? "add_credentials" : "none";
  if (update.status !== "update_available") return "none";
  if (!update.severityCounts) return "scan_first";
  if (update.affectedContainers.length > 0) return "update_container";
  if (update.affectedStacks.length > 0) return "redeploy_stack";
  return "pull";
}

export function buildImageUpdatePreview(hostId: string, imageReference: string, updates: ImageUpdateCheck[]): ImageUpdatePreview {
  const normalized = imageReference.trim();
  const update = updates.find((item) => item.imageReference === normalized) ?? null;
  return {
    hostId,
    imageReference: normalized,
    status: update?.status ?? "unknown",
    currentDigest: update?.currentDigest ?? null,
    remoteDigest: update?.remoteDigest ?? null,
    riskNote: update?.riskNote ?? mutableTagRisk(normalized),
    credentialHint: credentialHint(update),
    safeAction: safeAction(update),
    affectedContainers: update?.affectedContainers ?? [],
    affectedStacks: update?.affectedStacks ?? [],
    severityCounts: update?.severityCounts
  };
}

export async function getImageUpdatePreview(hostId: string, imageReference: string): Promise<ImageUpdatePreview> {
  return buildImageUpdatePreview(hostId, imageReference, await listImageUpdateChecks(hostId));
}

function normalizeLocalDigest(value: unknown) {
  const digest = String(value ?? "").trim();
  if (!digest || digest === "<none>") return null;
  return digest.replace(/^sha256:/, "");
}

function sameRepository(a: string, b: string) {
  try {
    const left = parseImageReference(a);
    const right = parseImageReference(b);
    return left.registry === right.registry && left.repository === right.repository;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) break;
      await task(item);
    }
  });
  await Promise.all(workers);
}

function simulatedDemoLookup(reference: string, currentDigest: string | null): LookupOutcome {
  const seed = createHash("sha256").update(reference).digest()[0]! % 4;
  const mutableRisk = mutableTagRisk(reference);
  if (seed === 0) {
    const remoteDigest = createHash("sha256").update(`demo-remote:${reference}`).digest("hex");
    return { remoteDigest, status: "update_available", riskNote: mutableRisk };
  }
  return {
    remoteDigest: currentDigest ?? createHash("sha256").update(`demo:${reference}`).digest("hex"),
    status: "up_to_date",
    riskNote: mutableRisk
  };
}

export async function checkImageUpdatesForHost(hostId: string) {
  const [images, containers, stacks, demoHost] = await Promise.all([
    query<any>(`SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'image'`, [hostId]),
    query<any>(`SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container'`, [hostId]),
    query<any>(`SELECT id, name, compose_yaml FROM compose_stacks WHERE host_id = $1`, [hostId]),
    isDemoHostId(hostId)
  ]);

  const uniqueImages = new Map<string, { reference: string; currentDigest: string | null }>();
  for (const row of images.rows) {
    const repository = String(row.data?.Repository ?? "");
    const tag = String(row.data?.Tag ?? "latest");
    const reference = repository === "<none>" ? String(row.name ?? "") : `${repository}:${tag}`;
    // Dangling/intermediate layers have no reference to check against a registry.
    if (!reference || isDanglingImageReference(reference)) continue;
    const digest = normalizeLocalDigest(row.data?.Digest);
    if (!uniqueImages.has(reference)) uniqueImages.set(reference, { reference, currentDigest: digest });
  }

  const results: ImageUpdateCheck[] = [];
  await runWithConcurrency(Array.from(uniqueImages.values()), CHECK_CONCURRENCY, async ({ reference, currentDigest }) => {
    const affectedContainers = containers.rows
      .filter((row) => sameRepository(String(row.data?.Image ?? ""), reference))
      .map((row) => ({ id: row.external_id, name: row.name }));
    const affectedStacks = stacks.rows
      .filter((row) => String(row.compose_yaml).includes(reference.split(":")[0] ?? ""))
      .map((row) => ({ id: row.id, name: row.name }));

    const mutableRisk = mutableTagRisk(reference);
    let outcome: LookupOutcome;
    if (demoHost) {
      outcome = simulatedDemoLookup(reference, currentDigest);
    } else {
      let remoteDigest: string | null = null;
      let remoteEquivalentDigests: string[] = [];
      let lookupError: Error | null = null;
      let hasStoredAuth = false;
      try {
        const auth = await findRegistryAuthForReference(reference);
        hasStoredAuth = Boolean(auth?.username && auth.password);
        const manifest = await fetchRegistryManifestDigests(
          reference,
          auth
            ? {
                username: auth.username,
                password: auth.password,
                insecure: auth.insecure,
                trustedOrigin: auth.trustedOrigin
              }
            : undefined,
          currentDigest
        );
        remoteDigest = manifest.digest;
        remoteEquivalentDigests = manifest.equivalentDigests;
      } catch (error) {
        lookupError = error instanceof Error ? error : new Error(String(error));
      }
      outcome = resolveImageUpdateOutcome({ currentDigest, remoteDigest, remoteEquivalentDigests, mutableRisk, lookupError, hasStoredAuth });
    }

    const saved = await query(
      `INSERT INTO image_update_checks (
         id, host_id, image_reference, current_digest, remote_digest, status, risk_note,
         affected_containers, affected_stacks, last_checked_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
       ON CONFLICT (host_id, image_reference)
       DO UPDATE SET
         current_digest = EXCLUDED.current_digest,
         remote_digest = EXCLUDED.remote_digest,
         status = EXCLUDED.status,
         risk_note = EXCLUDED.risk_note,
         affected_containers = EXCLUDED.affected_containers,
         affected_stacks = EXCLUDED.affected_stacks,
         last_checked_at = now(),
         updated_at = now()
       RETURNING *`,
      [
        uuid(),
        hostId,
        reference,
        currentDigest,
        outcome.remoteDigest,
        outcome.status,
        outcome.riskNote,
        JSON.stringify(affectedContainers),
        JSON.stringify(affectedStacks)
      ]
    );
    results.push(mapImageUpdateCheck(saved.rows[0]));
  });

  // Drop rows for images that no longer exist on the host so stale errors do not linger.
  const liveReferences = Array.from(uniqueImages.keys());
  if (liveReferences.length > 0) {
    await query(
      `DELETE FROM image_update_checks WHERE host_id = $1 AND NOT (image_reference = ANY($2::text[]))`,
      [hostId, liveReferences]
    );
  } else {
    await query(`DELETE FROM image_update_checks WHERE host_id = $1`, [hostId]);
  }

  return results.sort((a, b) => a.imageReference.localeCompare(b.imageReference));
}

export async function getSeverityCountsForImage(hostId: string, imageReference: string) {
  const scans = await listLatestScans(hostId);
  return scans.find((scan) => scan.imageReference === imageReference)?.severityCounts;
}
