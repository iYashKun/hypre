import fs from "node:fs";
import path from "node:path";
import type { RunnerDefinition } from "../types";

function findProject(file: string): string {
  let directory = path.dirname(path.resolve(file));

  while (true) {
    const projects = fs.readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith(".csproj"))
      .map((name) => path.join(directory, name));
    if (projects.length === 1) return projects[0];
    if (projects.length > 1) {
      throw new Error(`Multiple .csproj files found in ${directory}; use a watch rule command to select one`);
    }

    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No .csproj found for C# entry: ${file}`);
    directory = parent;
  }
}

export function csharpRunner(file: string): RunnerDefinition {
  const project = findProject(file);
  return {
    command: "dotnet",
    args: ["run", "--project", project, "--no-launch-profile"],
    cwd: path.dirname(project)
  };
}
