import type { ChildProcess } from "node:child_process";

export interface RunnerDefinition {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  build?: {
    command: string;
    args: string[];
  };
}

export interface ReloadConfig {
  debounceMs: number;
  ignore: string[];
  previewPort: number;
  startupGraceMs: number;
  shutdownTimeoutMs: number;
  restartOnCrash: boolean;
  restartLoopLimit: number;
  restartLoopWindowMs: number;
  proxy: {
    enabled: boolean;
    port: number;
    healthPath: string;
    readinessTimeoutMs: number;
  };
}

export interface EngineState {
  child: ChildProcess | null;
  shuttingDown: boolean;
}
