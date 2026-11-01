import type { ReloadConfig } from "../types";

export const defaultConfig: ReloadConfig = {
  debounceMs: 150,
  previewPort: 8888,
  ignore: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/__pycache__/**",
    "**/.next/**",
    "**/vendor/**"
  ]
};
