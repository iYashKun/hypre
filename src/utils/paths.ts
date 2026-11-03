import path from "node:path";

export function getExtension(file: string): string {
  return path.extname(file).toLowerCase();
}
