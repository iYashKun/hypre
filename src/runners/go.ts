import type { RunnerDefinition } from "../types";

export function goRunner(file: string): RunnerDefinition {
  return {
    command: "go",
    args: ["run", file]
  };
}
