import path from "node:path";

export function resolvePath(input: string): string {
  return path.resolve(process.cwd(), input);
}

export function getExtension(file: string): string {
  return path.extname(file).toLowerCase();
}

export function isSupportedExtension(extension: string, supported: string[]): boolean {
  return supported.includes(extension);
}
