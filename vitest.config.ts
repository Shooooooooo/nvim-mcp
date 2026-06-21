import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests spawn real Neovim processes and talk to them over RPC, so they
    // need generous timeouts and must not run in parallel against a shared
    // socket. Each test file gets its own Neovim instance, but we keep the
    // pool single-threaded to avoid resource contention in CI.
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
