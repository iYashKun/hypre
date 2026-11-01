import fs from "node:fs";
import path from "node:path";
import type { RunnerDefinition } from "../types";

export function typescriptRunner(file: string): RunnerDefinition {
  const resolvePaths = [process.cwd(), __dirname];
  const tsxCli = require.resolve("tsx/cli", { paths: resolvePaths });
  const tscCli = require.resolve("typescript/bin/tsc", { paths: resolvePaths });
  const hasTsConfig = fs.existsSync(path.resolve(process.cwd(), "tsconfig.json"));

  return {
    command: process.execPath,
    args: [tsxCli, file],
    build: {
      command: process.execPath,
      args: hasTsConfig
        ? [tscCli, "--noEmit", "--pretty", "false", "--project", path.resolve(process.cwd(), "tsconfig.json")]
        : [tscCli, "--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "commonjs", file]
    }
  };
}
