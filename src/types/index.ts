export interface RunnerDefinition {
  command: string;
  args: string[];
  cwd?: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  build?: {
    command: string;
    args: string[];
    cwd?: string;
    artifact?: boolean;
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
    readinessTimeoutMs: number;
  };
}

export type WatchRuleAction = "ignore" | "restart" | "preview-reload" | "command";

export interface WatchRule {
  pattern: string;
  action: WatchRuleAction;
  command?: string;
  args?: string[];
  cwd?: string;
  shell?: boolean;
}

export interface ServiceConfig {
  entry?: string;
  script?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  watch?: string[];
  dependsOn?: string[];
  readyUrl?: string;
  readinessTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

export interface ProjectConfig extends ReloadConfig {
  watchRules: WatchRule[];
  services?: Record<string, ServiceConfig>;
}

export interface EngineStatus {
  active: boolean;
  pid: number | null;
  uptimeMs: number | null;
  lastSuccessfulRestartAt: string | null;
  restartLoopPaused: boolean;
  restartFailures: number;
  services?: Record<string, EngineStatus>;
}
