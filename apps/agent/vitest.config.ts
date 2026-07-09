import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "coverage/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "../../coverage/agent",
      reportOnFailure: true,
      thresholds: {
        statements: 46,
        branches: 53,
        functions: 43,
        lines: 51
      }
    }
  }
});
