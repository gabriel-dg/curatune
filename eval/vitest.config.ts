import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Separate from the unit tests: the evaluation calls a real model and takes minutes.
export default defineConfig(({ mode }) => ({
  test: {
    include: ["eval/**/*.eval.ts"],
    environment: "node",
    env: loadEnv(mode, process.cwd(), "VITE_LLM_"),
    reporters: ["default"],
    // Show console output as it happens.
    disableConsoleIntercept: true,
  },
}));
