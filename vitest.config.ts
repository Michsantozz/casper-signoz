import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

// Vitest multi-project, hermetic-by-default. Layers by naming:
// unit/*.test.ts (node) · component/*.test.tsx (jsdom) ·
// integration/*.integration.test.ts (node, serial).
export default defineConfig({
  test: {
    // Cap worker processes so the suite fits in WSL's RAM budget. Each fork
    // carries jsdom + the Next module graph; two workers keep peak memory
    // bounded. Raise if the host gets more RAM.
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
          setupFiles: ["tests/setup.ts"],
          clearMocks: true,
          restoreMocks: true,
        },
      },
      {
        // Component layer — render React in jsdom with Testing Library. The
        // react() plugin is scoped here (the node-env projects neither need nor
        // want the JSX transform). Covers Client Components + synchronous Server
        // Components; async Server Components stay in the Playwright e2e suite.
        extends: true,
        plugins: [react()],
        test: {
          name: "component",
          environment: "jsdom",
          include: ["tests/component/**/*.test.tsx"],
          setupFiles: ["tests/setup.component.ts"],
          clearMocks: true,
          restoreMocks: true,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.integration.test.ts"],
          setupFiles: ["tests/setup.ts"],
          clearMocks: true,
          restoreMocks: true,
          // Integration suites hit shared resources (Casper Testnet node, a
          // Postgres/LibSQL store, an Inngest dev server). Serialize so each
          // file owns those for its window instead of contending.
          fileParallelism: false,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // server/* files carry `import "server-only"`; stub it so the node test
      // env can import them without Next's build-time guard throwing.
      "server-only": path.resolve(__dirname, "./tests/stubs/server-only.ts"),
    },
  },
})
