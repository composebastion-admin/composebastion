import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      "e2e-live/**",
      "playwright-report/**",
      "test-results/**"
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "../../coverage/web",
      reportOnFailure: true,
      thresholds: {
        statements: 13,
        branches: 11,
        functions: 8,
        lines: 13
      }
    }
  }
});
