import chokidar, { type FSWatcher } from "chokidar";

import type { ReloadConfig } from "../types";
import { getSupportedExtensions } from "../runners";
import { getExtension } from "../utils/paths";
import { logger } from "../utils/logger";

export class FileWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly directory: string,
    private readonly config: ReloadConfig,
    private readonly onChange: (file: string) => void,
    private readonly extensions: string[] = getSupportedExtensions()
  ) {}

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.directory, {
      ignored: this.config.ignore,
      ignoreInitial: true,
      persistent: true
    });

    this.watcher.on("all", (event, file) => {
      const extension = getExtension(file);

      if (!this.extensions.includes(extension)) return;
      logger.change(`${event}: ${file}`);
      this.onChange(file);
    });

    this.watcher.on("error", (error) => {
      logger.error(`Watcher error: ${error instanceof Error ? error.message : String(error)}`);
    });
    await new Promise<void>((resolve) => {
      this.watcher!.once("ready", resolve);
    });

    logger.watch(this.directory);
  }

  async stop(): Promise<void> {
    if (!this.watcher) return;

    await this.watcher.close();
    this.watcher = null;
  }
}
