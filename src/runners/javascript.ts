import type { RunnerDefinition } from "../types";

export function javascriptRunner(file: string): RunnerDefinition {
  return {
    command: process.execPath,
    args: [file]
  };
}
