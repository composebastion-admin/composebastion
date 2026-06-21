import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../../package.json") as { version?: string };

export const APP_VERSION = process.env.COMPOSEBASTION_VERSION
  || process.env.npm_package_version
  || packageJson.version
  || "unknown";

export function runtimeVersionMetadata() {
  return {
    version: APP_VERSION,
    revision: process.env.COMPOSEBASTION_REVISION || null,
    buildDate: process.env.COMPOSEBASTION_BUILD_DATE || null
  };
}
