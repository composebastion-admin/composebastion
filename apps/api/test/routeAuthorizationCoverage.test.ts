import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/routes");
const publicRoutes = [
  "auth.ts:app.get(\"/api/auth/setup-state\"",
  "auth.ts:app.post(\"/api/auth/setup\"",
  "auth.ts:app.post(\"/api/auth/login\"",
  "auth.ts:app.post(\"/api/auth/logout\""
] as const;
const manuallyAuthenticatedRoutes = [
  "auth.ts:app.post(\"/api/auth/logout-all\"",
  "auth.ts:app.get(\"/api/auth/sessions\"",
  "auth.ts:app.delete(\"/api/auth/sessions/:id\"",
  "auth.ts:app.get(\"/api/auth/me\""
] as const;

function routeKey(file: string, line: string) {
  const normalized = line.trim().replace(/\s+/g, " ");
  return `${file}:${normalized}`;
}

function routeBlocks(source: string) {
  const lines = source.split("\n");
  const blocks: Array<{ line: string; block: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!/\bapp\.(get|post|put|patch|delete)\s*\(/.test(line)) continue;
    blocks.push({
      line,
      block: lines.slice(index, index + 12).join("\n")
    });
  }
  return blocks;
}

describe("route authorization coverage", () => {
  it("requires every API route to declare RBAC, manual auth, or a public exception", async () => {
    const files = (await readdir(routesDir)).filter((file) => file.endsWith(".ts")).sort();
    const uncovered: string[] = [];

    for (const file of files) {
      const source = await readFile(path.join(routesDir, file), "utf8");
      for (const block of routeBlocks(source)) {
        const key = routeKey(file, block.line);
        if (publicRoutes.some((route) => key.startsWith(route))) continue;
        if (manuallyAuthenticatedRoutes.some((route) => key.startsWith(route)) && block.block.includes("readSession(request)")) continue;
        if (block.block.includes("preHandler:")) continue;
        uncovered.push(key);
      }
    }

    expect(uncovered).toEqual([]);
  });
});
