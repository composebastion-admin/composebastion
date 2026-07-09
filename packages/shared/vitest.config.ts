import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "coverage/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "../../coverage/shared",
      reportOnFailure: true,
      thresholds: {
        statements: 79,
        branches: 58,
        functions: 61,
        lines: 82
      }
    }
  }
});
