import type { RunnerDefinition } from "../types";

export function phpRunner(file: string): RunnerDefinition {
  return {
    command: "php",
    args: [file]
  };
}