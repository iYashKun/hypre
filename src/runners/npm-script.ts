import type { RunnerDefinition } from "../types";

export function npmScriptRunner(script: string): RunnerDefinition {
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", script],
    shell: process.platform === "win32"
  };
}
