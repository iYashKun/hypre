import type { ChildProcess } from "node:child_process";

export interface RunnerDefinition {
  command: string;
  args: string[];
}

export interface ReloadConfig {
  debounceMs: number;
  ignore: string[];
  previewPort: number;
}

export interface EngineState {
  child: ChildProcess | null;
  shuttingDown: boolean;
}
