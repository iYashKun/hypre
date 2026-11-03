import fs from "node:fs";
import path from "node:path";

import type { RunnerDefinition } from "../types";

function findCargoManifest(file: string): string {
  let directory = path.dirname(path.resolve(file));

  while (true) {
    const manifest = path.join(directory, "Cargo.toml");
    if (fs.existsSync(manifest)) return manifest;

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Cargo.toml not found for Rust entry: ${file}`);
    }
    directory = parent;
  }
}

export function rustRunner(file: string): RunnerDefinition {
  const manifest = findCargoManifest(file);
  const args = ["run", "--manifest-path", manifest];
  const relativeFile = path.relative(path.dirname(manifest), path.resolve(file));
  const segments = relativeFile.split(path.sep);

  if (segments[0] === "src" && segments[1] === "bin") {
    const binaryPath = segments.slice(2);
    const binaryName = binaryPath.length === 1
      ? path.basename(file, ".rs")
      : binaryPath.length === 2 && binaryPath[1] === "main.rs"
        ? binaryPath[0]
        : undefined;
    if (binaryName) args.push("--bin", binaryName);
  }

  return {
    command: "cargo",
    args
  };
}
