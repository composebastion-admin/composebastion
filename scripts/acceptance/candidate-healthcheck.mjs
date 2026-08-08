import assert from "node:assert/strict";

export function renderCandidateHealthcheckProgram(candidateVersion, options = {}) {
  assert(typeof candidateVersion === "string" && candidateVersion.length > 0,
    "candidate healthcheck version is required");
  const packagePath = options.packagePath ?? "/app/package.json";
  const markerPath = options.markerPath ?? "/acceptance-runtime/force-candidate-unhealthy";
  const healthUrl = options.healthUrl ?? "http://127.0.0.1:8080/api/health";
  for (const [label, value] of Object.entries({ packagePath, markerPath, healthUrl })) {
    assert(typeof value === "string" && value.length > 0,
      `candidate healthcheck ${label} is required`);
  }

  return [
    "const fs=require('node:fs');",
    `const version=require(${JSON.stringify(packagePath)}).version;`,
    `if(version===${JSON.stringify(candidateVersion)}&&fs.existsSync(${JSON.stringify(markerPath)}))process.exit(1);`,
    `fetch(${JSON.stringify(healthUrl)}).then(async r=>{if(!r.ok)process.exit(1);const health=await r.json();process.exit(health?.ok===true?0:1)}).catch(()=>process.exit(1));`
  ].join("");
}
