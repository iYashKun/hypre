#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { getRunner } from "./runners";
import { defaultConfig } from "./config/default";
import type { ReloadConfig } from "./types";

import { ProcessManager } from "./core/process-manager";
import { RestartManager } from "./core/restart-manager";
import { FileWatcher } from "./core/watcher";
import { registerShutdown } from "./core/shutdown";

import { logger } from "./utils/logger";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entryArg = args[0];
  const watchArg = args[1];

  if (!entryArg || entryArg.startsWith("--")) {
    console.error("Usage: hypre <entry> [watch-directory]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const entry = path.resolve(cwd, entryArg);

  if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
    logger.error(`Entry file not found: ${entry}`);
    process.exit(1);
  }

  const configPath = path.join(cwd, "hypre.config.json");
  let config: ReloadConfig = { ...defaultConfig };

  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(
        fs.readFileSync(configPath, "utf8")
      ) as Partial<ReloadConfig>;

      config = {
        debounceMs:
          typeof userConfig.debounceMs === "number" &&
          Number.isFinite(userConfig.debounceMs) &&
          userConfig.debounceMs >= 0
            ? userConfig.debounceMs
            : defaultConfig.debounceMs,

        ignore: Array.isArray(userConfig.ignore) &&
          userConfig.ignore.every(
            (item): item is string => typeof item === "string"
          )
            ? userConfig.ignore
            : defaultConfig.ignore
      };
    } catch (error) {
      logger.error(
        `Invalid configuration: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
  }

  const watchDir = path.resolve(
    cwd,
    watchArg || path.dirname(entry)
  );

  if (!fs.existsSync(watchDir) || !fs.statSync(watchDir).isDirectory()) {
    logger.error(`Watch directory not found: ${watchDir}`);
    process.exit(1);
  }

  let runner;

  try {
    runner = getRunner(entry);
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
    return;
  }

  console.log("");
  console.log(`Entry       : ${entry}`);
  console.log(`Watch       : ${watchDir}`);
  console.log(`Debounce    : ${config.debounceMs}ms`);
  console.log(`Extensions  : ${path.extname(entry)}`);
  console.log("");

  const processManager = new ProcessManager(watchDir);
  const restartManager = new RestartManager(processManager, runner, config.debounceMs);
  const watcher = new FileWatcher(watchDir, config, () => restartManager.schedule());

  registerShutdown(watcher, restartManager);

  await watcher.start();
  await restartManager.start();
}

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exit(1);
});
