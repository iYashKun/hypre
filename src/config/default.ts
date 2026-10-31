import type { ReloadConfig } from "../types";

export const defaultConfig: ReloadConfig = {
  debounceMs: 150,
  ignore: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/__pycache__/**",
    "**/.next/**",
    "**/vendor/**"
  ]
};
