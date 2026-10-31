import type { RunnerDefinition } from "../types";
import { ProcessManager } from "./process-manager";
import { logger } from "../utils/logger";

export class RestartManager {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(
    private readonly processManager: ProcessManager,
    private readonly runner: RunnerDefinition,
    private readonly debounceMs: number
  ) {}

  schedule(): void {
    if (this.shuttingDown) return;
    if (this.timer) { clearTimeout(this.timer); }

    this.timer = setTimeout(() => {
      this.queue = this.queue
        .then(async () => {
          if (this.shuttingDown) return;
          logger.warn("Restarting application...");

          await this.processManager.restart(this.runner);
        })
        .catch((error: unknown) => {
          logger.error(
            error instanceof Error ? error.message : String(error)
          );
        });
    }, this.debounceMs);
  }

  async start(): Promise<void> { await this.processManager.start(this.runner); }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.queue;
    await this.processManager.stop();
  }
}
