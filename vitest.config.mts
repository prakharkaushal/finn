import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Unit tests must never touch the network; providers are tested on captured fixtures.
    env: { FINN_CACHE_DIR: fileURLToPath(new URL("./.cache/test", import.meta.url)) },
  },
});
