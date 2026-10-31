import type { RunnerDefinition } from "../types";

export function pythonRunner(file: string): RunnerDefinition {
  return {
    command: process.platform === "win32" ? "python" : "python3",
    args: [file]
  };
}
