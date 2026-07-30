import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(apiRoot, "src");

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(location);
    return entry.isFile() && entry.name.endsWith(".ts") ? [location] : [];
  }));
  return nested.flat();
}

describe("audit writer boundary", () => {
  it("is the only API source allowed to insert audit rows directly", async () => {
    const directWriters = [];
    for (const file of await typescriptFiles(sourceRoot)) {
      if ((await readFile(file, "utf8")).includes("INSERT INTO audit_events")) {
        directWriters.push(path.relative(apiRoot, file));
      }
    }
    expect(directWriters).toEqual(["src/services/audit.ts"]);
  });
});
