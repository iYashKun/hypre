import type { FSWatcher } from "chokidar" with { "resolution-mode": "import" };
import path from "node:path";
import picomatch from "picomatch";

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
    private readonly extensions: string[] = getSupportedExtensions(),
    private readonly additionalFiles: string[] = [],
    private readonly watchAllFiles = false
  ) {}

  async start(): Promise<void> {
    const { default: chokidar } = await import("chokidar");
    const watchPaths = [this.directory, ...new Set(this.additionalFiles.map((file) => path.dirname(file)))];
    const ignoredMatchers = this.config.ignore.map((pattern) => picomatch(pattern, { dot: true }));
    this.watcher = chokidar.watch(watchPaths, {
      ignored: (file) => {
        const relative = path.relative(path.resolve(this.directory), path.resolve(file)).split(path.sep).join("/");
        return ignoredMatchers.some((matches) => matches(relative));
      },
      ignoreInitial: true,
      persistent: true
    });

    this.watcher.on("all", (event, file) => {
      if (event === "addDir" || event === "unlinkDir") return;
      const absoluteFile = path.resolve(file);
      const absoluteDirectory = path.resolve(this.directory);
      const relativeFile = path.relative(absoluteDirectory, absoluteFile);
      const isInDirectory = relativeFile === "" || (relativeFile !== ".." && !relativeFile.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeFile));
      const isAdditionalFile = this.additionalFiles.includes(absoluteFile);
      const extension = getExtension(file);

      if ((!isInDirectory || (!this.watchAllFiles && !this.extensions.includes(extension))) && !isAdditionalFile) return;
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
