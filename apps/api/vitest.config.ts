import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "coverage/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "../../coverage/api",
      reportOnFailure: true,
      thresholds: {
        statements: 50,
        branches: 41,
        functions: 54,
        lines: 52
      }
    }
  }
});
