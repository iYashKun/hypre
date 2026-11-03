import fs from "node:fs";
import path from "node:path";
import type { RunnerDefinition } from "../types";

export function typescriptRunner(file: string, cwd = process.cwd()): RunnerDefinition {
  const resolvePaths = [cwd, __dirname];
  const tsxCli = require.resolve("tsx/cli", { paths: resolvePaths });
  const typescriptEntry = require.resolve("typescript", { paths: resolvePaths });
  const tscCli = path.resolve(path.dirname(typescriptEntry), "../bin/tsc");
  if (!fs.existsSync(tscCli)) throw new Error(`TypeScript compiler not found: ${tscCli}`);
  const tsConfig = path.resolve(cwd, "tsconfig.json");
  const hasTsConfig = fs.existsSync(tsConfig);

  return {
    command: process.execPath,
    args: [tsxCli, file],
    cwd,
    build: {
      command: process.execPath,
      args: hasTsConfig
        ? [tscCli, "--noEmit", "--pretty", "false", "--project", tsConfig]
        : [tscCli, "--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "commonjs", "--jsx", "preserve", file]
    }
  };
}
