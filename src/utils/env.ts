import { readFile } from "node:fs/promises";
import { parse } from "dotenv";

export async function loadEnvFile(file: string): Promise<NodeJS.ProcessEnv> {
  try {
    const parsed = parse(await readFile(file, "utf8"));
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => process.env[key] === undefined)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read environment file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
