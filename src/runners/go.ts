import path from "node:path";
import type { RunnerDefinition } from "../types";

export function goRunner(file: string): RunnerDefinition {
  return {
    command: "go",
    args: ["run", "."],
    cwd: path.dirname(path.resolve(file))
  };
}
