import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Separate from the unit tests: the evaluation calls a real model and takes minutes.
export default defineConfig(({ mode }) => ({
  test: {
    include: ["eval/**/*.eval.ts"],
    environment: "node",
    // VITE_LLM_* for LM Studio; EVAL_LLM_* (optional) for a hosted API. EVAL_* never reaches the page bundle,
    // since Vite only exposes VITE_* variables to it.
    env: loadEnv(mode, process.cwd(), ["VITE_LLM_", "EVAL_LLM_"]),
    reporters: ["default"],
    // Show console output as it happens.
    disableConsoleIntercept: true,
  },
}));
