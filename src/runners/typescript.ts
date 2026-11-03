import fs from "node:fs";
import path from "node:path";
import type { RunnerDefinition } from "../types";

function findTsConfig(directory: string): string | null {
  let current = path.resolve(directory);
  while (true) {
    const candidate = path.join(current, "tsconfig.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findTypeRoots(file: string, nodeTypesEntry: string): string[] {
  const roots = new Set<string>();
  let directory = path.dirname(path.resolve(file));
  while (true) {
    const typeRoot = path.join(directory, "node_modules", "@types");
    if (fs.existsSync(typeRoot) && fs.statSync(typeRoot).isDirectory()) roots.add(typeRoot);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  roots.add(path.resolve(path.dirname(nodeTypesEntry), ".."));
  return [...roots];
}

export function typescriptRunner(file: string, cwd = process.cwd()): RunnerDefinition {
  const resolvePaths = [cwd, __dirname];
  const tsxCli = require.resolve("tsx/cli", { paths: resolvePaths });
  const typescriptEntry = require.resolve("typescript", { paths: resolvePaths });
  const nodeTypesEntry = require.resolve("@types/node/package.json", { paths: resolvePaths });
  const tscCli = path.resolve(path.dirname(typescriptEntry), "../bin/tsc");
  if (!fs.existsSync(tscCli)) throw new Error(`TypeScript compiler not found: ${tscCli}`);
  const tsConfig = findTsConfig(path.dirname(path.resolve(file))) ?? findTsConfig(cwd);
  const typeRoots = findTypeRoots(file, nodeTypesEntry);

  return {
    command: process.execPath,
    args: [tsxCli, file],
    cwd,
    build: {
      command: process.execPath,
      args: tsConfig
        ? [tscCli, "--noEmit", "--pretty", "false", "--project", tsConfig]
        : [tscCli, "--noEmit", "--pretty", "false", "--target", "ES2022", "--module", "commonjs", "--jsx", "preserve", "--typeRoots", typeRoots.join(","), "--types", "node", file]
    }
  };
}
