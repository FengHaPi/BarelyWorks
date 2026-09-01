import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/workflow-v3-minimal-chain-001.live.test.ts"],
    environment: "node",
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
  },
});
