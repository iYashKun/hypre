import { logger } from "../utils/logger";
import { FileWatcher } from "./watcher";

export function registerShutdown(watcher: FileWatcher, cleanup: () => Promise<void>): void {
  let shuttingDown = false;
  
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn("Shutting down hypre...");
    try {
      await watcher.stop();
      await cleanup();

      logger.success("hypre stopped.");
      process.exit(0);
    } catch (error) {
      logger.error(
        error instanceof Error ? error.message : String(error)
      );

      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
