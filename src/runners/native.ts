import path from "node:path";
import type { RunnerDefinition } from "../types";

function nativeRunner(
  file: string,
  cwd: string,
  compiler: string,
  standard: string
): RunnerDefinition {
  return {
    command: "{{artifact}}",
    args: [],
    cwd,
    build: {
      command: compiler,
      args: [standard, path.resolve(file), "-o", "{{artifact}}"],
      cwd,
      artifact: true
    }
  };
}

export function cRunner(file: string, cwd = process.cwd()): RunnerDefinition {
  return nativeRunner(file, cwd, process.env.CC || "cc", "-std=c17");
}

export function cppRunner(file: string, cwd = process.cwd()): RunnerDefinition {
  return nativeRunner(file, cwd, process.env.CXX || "c++", "-std=c++20");
}
