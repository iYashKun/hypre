import type { EngineStatus, ReloadConfig, RunnerDefinition } from "../types";
import { loadEnvFile } from "../utils/env";
import { logger } from "../utils/logger";
import { ProcessManager, type ProcessStartOptions } from "./process-manager";
import { LiveProxyServer } from "./live-proxy";

export class RestartManager {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private started = false;
  private pendingRestart = false;
  private paused = false;
  private failures: number[] = [];
  private readonly errorGroups = new Map<string, number>();

  constructor(
    private readonly processManager: ProcessManager,
    private readonly runner: RunnerDefinition,
    private readonly config: ReloadConfig,
    private readonly envFile: string,
    private readonly proxy: LiveProxyServer | null = null
  ) {}

  getStatus(): EngineStatus {
    this.trimFailures();
    return {
      ...this.processManager.getStatus(),
      restartLoopPaused: this.paused,
      restartFailures: this.failures.length
    };
  }

  schedule(): void {
    if (this.shuttingDown) return;
    if (this.paused) {
      this.paused = false;
      this.failures = [];
      logger.info("Source changed; resuming automatic restarts");
    }
    this.scheduleRestart(this.config.debounceMs);
  }

  async restartNow(): Promise<void> {
    if (this.shuttingDown) return;
    this.paused = false;
    this.failures = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) {
      this.pendingRestart = true;
      return;
    }
    await this.queueRestart();
  }

  async start(): Promise<void> {
    this.processManager.setCrashHandler(() => this.handleCrash());
    this.started = true;
    try {
      await this.processManager.start(this.runner, await this.startOptions());
      this.errorGroups.clear();
    } catch (error) {
      this.reportFailure(error);
    }
    if (this.pendingRestart) {
      this.pendingRestart = false;
      this.scheduleRestart(0);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.processManager.stop(this.config.shutdownTimeoutMs);
    await this.queue;
    await this.processManager.stop(this.config.shutdownTimeoutMs);
  }

  private async startOptions(): Promise<ProcessStartOptions> {
    const env = await loadEnvFile(this.envFile);
    for (const key of Object.keys(this.runner.env ?? {})) delete env[key];

    const options: ProcessStartOptions = {
      startupGraceMs: this.config.startupGraceMs,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      env
    };

    if (this.config.proxy.enabled) {
      if (!this.proxy) throw new Error("Proxy mode is enabled but the proxy server is unavailable");
      const port = await this.proxy.reserveCandidatePort();
      options.env = { ...options.env, PORT: String(port) };
      options.waitUntilReady = () => this.proxy!.waitUntilReady(port);
      options.onPromote = () => this.proxy!.promote(port);
    }

    return options;
  }

  private scheduleRestart(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.started) {
        this.pendingRestart = true;
        return;
      }
      void this.queueRestart();
    }, delayMs);
  }

  private queueRestart(): Promise<void> {
    const operation = this.queue.then(() => this.performRestart());
    this.queue = operation.catch((error: unknown) => {
      if (!this.shuttingDown) this.reportFailure(error);
    });
    return operation;
  }

  private async performRestart(): Promise<void> {
    if (this.shuttingDown || this.paused) return;
    this.trimFailures();
    if (this.failures.length >= this.config.restartLoopLimit) {
      this.paused = true;
      logger.error(`Restart loop detected (${this.failures.length} failures); automatic restarts paused. Run "hypre restart" to retry.`);
      return;
    }

    logger.warn("Restarting application...");
    await this.processManager.restart(this.runner, await this.startOptions());
    this.errorGroups.clear();
  }

  private handleCrash(): void {
    if (this.shuttingDown || !this.config.restartOnCrash) return;
    this.recordFailure("process crash");
    logger.error("Application crashed unexpectedly");
    if (this.failures.length >= this.config.restartLoopLimit) {
      this.paused = true;
      logger.error(`Restart loop detected; automatic restarts paused. Run "hypre restart" to retry.`);
      return;
    }
    this.scheduleRestart(Math.min(1000 * this.failures.length, 5000));
  }

  private reportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const key = message.trim() || "Unknown restart failure";
    const group = this.errorGroups.get(key) ?? 0;
    this.errorGroups.set(key, group + 1);
    this.recordFailure(key);

    logger.error(group === 0 ? message : `Repeated restart failure (${group + 1}): ${key}`);
    logger.status(this.processManager.hasActiveProcess()
      ? "Previous process still running; last successful build remains active"
      : "No successful process is currently active");

    if (this.failures.length >= this.config.restartLoopLimit) {
      this.paused = true;
      logger.error(`Restart loop detected (${this.failures.length} failures); automatic restarts paused. Run "hypre restart" to retry.`);
    }
  }

  private recordFailure(_reason: string): void {
    this.failures.push(Date.now());
    this.trimFailures();
  }

  private trimFailures(): void {
    const cutoff = Date.now() - this.config.restartLoopWindowMs;
    this.failures = this.failures.filter((timestamp) => timestamp >= cutoff);
  }
}
