import path from "node:path";
import type { RunnerDefinition } from "../types";

import { pythonRunner } from "./python";
import { javascriptRunner } from "./javascript";
import { typescriptRunner } from "./typescript";
import { rubyRunner } from "./ruby";
import { goRunner } from "./go";

const runners: Record<string, (file: string) => RunnerDefinition> = {
  ".py": pythonRunner,
  ".js": javascriptRunner,
  ".ts": typescriptRunner,
  ".tsx": typescriptRunner,
  ".rb": rubyRunner,
  ".go": goRunner
};

export function getRunner(file: string): RunnerDefinition {
  const extension = path.extname(file).toLowerCase();
  const runner = runners[extension];
  
  if (!runner) { throw new Error(`Unsupported file extension: ${extension}`); }
  return runner(file);
}

export function getSupportedExtensions(): string[] {
  return Object.keys(runners);
}
