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

  if (segments.length === 3 && segments[0] === "src" && segments[1] === "bin") {
    args.push("--bin", path.basename(file, ".rs"));
  }

  return {
    command: "cargo",
    args
  };
}