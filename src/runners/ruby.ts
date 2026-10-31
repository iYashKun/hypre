import type { RunnerDefinition } from "../types";

export function rubyRunner(file: string): RunnerDefinition {
  return {
    command: "ruby",
    args: [file]
  };
}
