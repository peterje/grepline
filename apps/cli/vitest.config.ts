import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    setupFiles: ["../../vitest.setup.ts"],
    pool: "forks",
  },
})
