import { logger } from "../utils/logger";

export interface Stoppable {
  stop(): Promise<void>;
}

export async function runCleanupSteps(steps: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "One or more shutdown steps failed");
}

export function registerShutdown(watcher: Stoppable, cleanup: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      process.exit(exitCode || 1);
    }
    shuttingDown = true;
    logger.warn("Shutting down hypre...");
    try {
      await runCleanupSteps([() => watcher.stop(), cleanup]);
      logger.success("hypre stopped.");
      process.exit(exitCode);
    } catch (error) {
      logger.error(
        error instanceof Error ? error.message : String(error)
      );

      process.exit(1);
    }
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGHUP", () => { void shutdown(); });
  process.on("uncaughtException", (error) => {
    logger.error(error instanceof Error ? error.stack || error.message : String(error));
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(reason instanceof Error ? reason.stack || reason.message : String(reason));
    void shutdown(1);
  });
}
