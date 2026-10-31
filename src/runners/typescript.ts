import path from "node:path";
import type { RunnerDefinition } from "../types";

export function typescriptRunner(file: string): RunnerDefinition {
  const tsxCli = require.resolve("tsx/cli", { paths: [process.cwd(), __dirname] });
  return {
    command: process.execPath,
    args: [tsxCli, file]
  };
}
