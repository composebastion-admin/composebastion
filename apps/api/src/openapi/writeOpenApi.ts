import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildOpenApiDocument, buildOpenApiMarkdown } from "./document.js";

const root = path.resolve(process.cwd(), "../..");
const docsDir = path.join(root, "docs");
const jsonPath = path.join(docsDir, "openapi.json");
const mdPath = path.join(docsDir, "openapi.md");
const check = process.argv.includes("--check");

const json = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
const markdown = buildOpenApiMarkdown();

if (check) {
  const [currentJson, currentMarkdown] = await Promise.all([
    readFile(jsonPath, "utf8"),
    readFile(mdPath, "utf8")
  ]);
  if (currentJson !== json || currentMarkdown !== markdown) {
    console.error("OpenAPI docs are stale. Run npm run openapi:write --workspace @composebastion/api.");
    process.exitCode = 1;
  }
} else {
  await mkdir(docsDir, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, json),
    writeFile(mdPath, markdown)
  ]);
}
