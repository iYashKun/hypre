import type { ReloadConfig } from "../types";

export const defaultConfig: ReloadConfig = {
  debounceMs: 150,
  previewPort: 8888,
  startupGraceMs: 1000,
  shutdownTimeoutMs: 5000,
  restartOnCrash: true,
  restartLoopLimit: 5,
  restartLoopWindowMs: 30000,
  proxy: {
    enabled: false,
    port: 3000,
    readinessTimeoutMs: 10000,
    healthPath: "/"
  },
  ignore: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/coverage/**",
    "**/__pycache__/**",
    "**/.next/**",
    "**/vendor/**"
  ]
};
