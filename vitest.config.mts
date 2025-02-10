import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
import path from "node:path";

export default defineConfig({
  plugins: [
    // swcrc disabled here so swc does NOT rewrite "@/..." imports itself;
    // vite's alias below resolves them instead (.swcrc paths remain for nest build).
    swc.vite({
      swcrc: false,
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2023",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts", "tests/**/*.e2e-spec.ts"],
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: "forks",
    singleFork: true,
  },
});
