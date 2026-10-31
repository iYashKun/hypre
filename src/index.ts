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
import { IPreviewServer } from "./core/preview-server";

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
            : defaultConfig.ignore,
        previewPort:
          typeof userConfig.previewPort === "number" &&
          Number.isInteger(userConfig.previewPort) &&
          userConfig.previewPort > 0 &&
          userConfig.previewPort <= 65535
            ? userConfig.previewPort
            : defaultConfig.previewPort
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

  const watchDir = path.resolve(cwd, watchArg || ".");

  if (!fs.existsSync(watchDir) || !fs.statSync(watchDir).isDirectory()) {
    logger.error(`Watch directory not found: ${watchDir}`);
    process.exit(1);
  }

  const isHtmlEntry = path.extname(entry).toLowerCase() === ".html";
  let runner: ReturnType<typeof getRunner> | null = null;

  if (!isHtmlEntry) {
    try {
      runner = getRunner(entry);
    } catch (error) {
      logger.error(
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
      return;
    }
  }

  console.log("");
  console.log(`Entry       : ${entry}`);
  console.log(`Watch       : ${watchDir}`);
  console.log(`Debounce    : ${config.debounceMs}ms`);
  console.log(`Extensions  : ${path.extname(entry)}`);
  if (isHtmlEntry) console.log(`Preview     : http://localhost:${config.previewPort}`);
  console.log("");

  const processManager = runner ? new ProcessManager(watchDir) : null;
  const restartManager = processManager && runner
    ? new RestartManager(processManager, runner, config.debounceMs)
    : null;
  const previewServer = isHtmlEntry
    ? new IPreviewServer(path.dirname(entry), path.basename(entry), config.previewPort)
    : null;
  const htmlExtensions = [".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"];
  const watcher = new FileWatcher(
    watchDir,
    config,
    () => previewServer ? previewServer.reload() : restartManager?.schedule(),
    previewServer ? htmlExtensions : undefined
  );

  registerShutdown(watcher, async () => {
    await restartManager?.shutdown();
    await previewServer?.stop();
  });

  await previewServer?.start();
  await watcher.start();
  await restartManager?.start();
}

main().catch((error: unknown) => {
  logger.error(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exit(1);
});
