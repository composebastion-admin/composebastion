import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { v4 as uuid } from "uuid";
import type { ImageScanResult } from "@composebastion/shared";
import { query } from "../db/pool.js";

const execFileAsync = promisify(execFile);

let cachedTrivyAvailable: boolean | null = null;
export function isTrivyAvailable(): boolean {
  if (cachedTrivyAvailable !== null) return cachedTrivyAvailable;
  try {
    execSync("trivy --version", { stdio: "ignore" });
    cachedTrivyAvailable = true;
  } catch {
    cachedTrivyAvailable = false;
  }
  return cachedTrivyAvailable;
}

export type SeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

export type ScanOutput = {
  scanner: string;
  severityCounts: SeverityCounts;
  raw: Record<string, unknown>;
};

export interface ImageScannerProvider {
  readonly name: string;
  scan(imageReference: string): Promise<ScanOutput>;
}

export class MockImageScannerProvider implements ImageScannerProvider {
  readonly name = "mock";

  async scan(imageReference: string): Promise<ScanOutput> {
    const risky = /latest|nightly|dev/i.test(imageReference);
    return {
      scanner: this.name,
      severityCounts: risky
        ? { critical: 0, high: 1, medium: 2, low: 3 }
        : { critical: 0, high: 0, medium: 0, low: 1 },
      raw: {
        image: imageReference,
        provider: "mock",
        note: risky ? "Mutable tag heuristic flagged elevated risk." : "Mock scan completed."
      }
    };
  }
}

export class TrivyImageScannerProvider implements ImageScannerProvider {
  readonly name = "trivy";

  async scan(imageReference: string): Promise<ScanOutput> {
    try {
      const { stdout } = await execFileAsync("trivy", ["image", "--quiet", "--format", "json", imageReference], {
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024
      });
      const raw = JSON.parse(stdout) as { Results?: Array<{ Vulnerabilities?: Array<{ Severity?: string }> }> };
      const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const result of raw.Results ?? []) {
        for (const vulnerability of result.Vulnerabilities ?? []) {
          const severity = String(vulnerability.Severity ?? "").toLowerCase();
          if (severity === "critical") counts.critical += 1;
          else if (severity === "high") counts.high += 1;
          else if (severity === "medium") counts.medium += 1;
          else if (severity === "low") counts.low += 1;
        }
      }
      return { scanner: this.name, severityCounts: counts, raw };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        throw new Error("Trivy is not installed on the ComposeBastion host");
      }
      throw error;
    }
  }
}

export function createImageScannerProvider(preferred: "auto" | "mock" | "trivy" = "auto"): ImageScannerProvider {
  if (preferred === "mock") return new MockImageScannerProvider();
  if (preferred === "trivy") return new TrivyImageScannerProvider();
  if (isTrivyAvailable()) {
    return new TrivyImageScannerProvider();
  }
  console.warn("Trivy is not available on this host. Falling back to MockImageScannerProvider.");
  return new MockImageScannerProvider();
}

export async function getImageScannerStatus(preferred: "auto" | "mock" | "trivy" = "auto") {
  let trivyVersion: string | null = null;
  let error: string | null = null;
  try {
    const { stdout } = await execFileAsync("trivy", ["--version"], { timeout: 10_000, maxBuffer: 256 * 1024 });
    trivyVersion = stdout.split(/\r?\n/).find(Boolean) ?? null;
    cachedTrivyAvailable = true;
  } catch (err) {
    cachedTrivyAvailable = false;
    error = err instanceof Error ? err.message : String(err);
  }
  const effectiveProvider = preferred === "mock" || (preferred === "auto" && !trivyVersion) ? "mock" : "trivy";
  return {
    provider: preferred,
    effectiveProvider,
    available: effectiveProvider === "mock" || Boolean(trivyVersion),
    trivyVersion,
    error,
    guidance: trivyVersion
      ? "Trivy is available for real image vulnerability scans."
      : "Install Trivy on the ComposeBastion server or set IMAGE_SCANNER_PROVIDER=mock for simulated scan results."
  };
}

export async function scanImageReference(
  hostId: string,
  imageReference: string,
  provider: ImageScannerProvider = new MockImageScannerProvider()
) {
  const output = await provider.scan(imageReference);
  const id = uuid();
  const result = await query(
    `INSERT INTO image_scan_results (id, host_id, image_reference, image_digest, scanner, severity_counts, raw)
     VALUES ($1, $2, $3, NULL, $4, $5, $6)
     RETURNING *`,
    [id, hostId, imageReference, output.scanner, output.severityCounts, output.raw]
  );
  return mapScanResult(result.rows[0]);
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function mapScanResult(row: any): ImageScanResult {
  return {
    id: row.id,
    hostId: row.host_id,
    imageReference: row.image_reference,
    imageDigest: row.image_digest ?? null,
    scanner: row.scanner,
    severityCounts: row.severity_counts ?? { critical: 0, high: 0, medium: 0, low: 0 },
    generatedAt: iso(row.generated_at)!
  };
}

export async function listLatestScans(hostId?: string) {
  const result = hostId
    ? await query(
      `SELECT DISTINCT ON (image_reference) *
       FROM image_scan_results
       WHERE host_id = $1
       ORDER BY image_reference, generated_at DESC`,
      [hostId]
    )
    : await query(
      `SELECT DISTINCT ON (host_id, image_reference) *
       FROM image_scan_results
       ORDER BY host_id, image_reference, generated_at DESC`
    );
  return result.rows.map(mapScanResult);
}
