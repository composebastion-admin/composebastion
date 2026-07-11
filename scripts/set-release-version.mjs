import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isStrictSemVer } from "./release-semver.mjs";

const nextVersion = process.argv[2];
if (!isStrictSemVer(nextVersion)) {
  throw new Error("Usage: npm run release:set-version -- X.Y.Z[-prerelease.N]");
}

const workspacePaths = ["apps/api", "apps/agent", "apps/web", "packages/shared"];
function updateJson(file, update) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  update(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

updateJson("package.json", (value) => { value.version = nextVersion; });
for (const workspace of workspacePaths) {
  updateJson(`${workspace}/package.json`, (value) => { value.version = nextVersion; });
}
updateJson("package-lock.json", (value) => {
  value.version = nextVersion;
  for (const workspace of ["", ...workspacePaths]) value.packages[workspace].version = nextVersion;
});

execFileSync("npm", ["run", "openapi:write", "--workspace", "@composebastion/api"], { stdio: "inherit" });
execFileSync("npm", ["run", "notices:write"], { stdio: "inherit" });
execFileSync("npm", ["run", "check:release-version"], { stdio: "inherit" });
