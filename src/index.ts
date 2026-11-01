#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { defaultConfig } from "./config/default";
import { ControlServer, requestRestart } from "./core/control-server";
import { IPreviewServer } from "./core/preview-server";
import { ProcessManager } from "./core/process-manager";
import { LiveProxyServer } from "./core/live-proxy";
import { RestartManager } from "./core/restart-manager";
import { registerShutdown } from "./core/shutdown";
import { FileWatcher } from "./core/watcher";
import { getRunner, getSupportedExtensions } from "./runners";
import { npmScriptRunner } from "./runners/npm-script";
import type { ReloadConfig } from "./types";
import { logger } from "./utils/logger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadConfig(cwd: string): ReloadConfig {
  const configPath = path.join(cwd, "hypre.config.json");
  if (!fs.existsSync(configPath)) return { ...defaultConfig, proxy: { ...defaultConfig.proxy } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Invalid configuration: expected a JSON object");

  const proxy = isRecord(parsed.proxy) ? parsed.proxy : {};
  return {
    debounceMs: typeof parsed.debounceMs === "number" && Number.isFinite(parsed.debounceMs) && parsed.debounceMs >= 0
      ? parsed.debounceMs : defaultConfig.debounceMs,
    ignore: Array.isArray(parsed.ignore) && parsed.ignore.every((item) => typeof item === "string")
      ? parsed.ignore as string[] : [...defaultConfig.ignore],
    previewPort: typeof parsed.previewPort === "number" && Number.isInteger(parsed.previewPort) && parsed.previewPort > 0 && parsed.previewPort <= 65535
      ? parsed.previewPort : defaultConfig.previewPort,
    startupGraceMs: typeof parsed.startupGraceMs === "number" && Number.isFinite(parsed.startupGraceMs) && parsed.startupGraceMs >= 0
      ? parsed.startupGraceMs : defaultConfig.startupGraceMs,
    shutdownTimeoutMs: typeof parsed.shutdownTimeoutMs === "number" && Number.isFinite(parsed.shutdownTimeoutMs) && parsed.shutdownTimeoutMs >= 0
      ? parsed.shutdownTimeoutMs : defaultConfig.shutdownTimeoutMs,
    restartOnCrash: typeof parsed.restartOnCrash === "boolean" ? parsed.restartOnCrash : defaultConfig.restartOnCrash,
    restartLoopLimit: typeof parsed.restartLoopLimit === "number" && Number.isInteger(parsed.restartLoopLimit) && parsed.restartLoopLimit > 0
      ? parsed.restartLoopLimit : defaultConfig.restartLoopLimit,
    restartLoopWindowMs: typeof parsed.restartLoopWindowMs === "number" && Number.isFinite(parsed.restartLoopWindowMs) && parsed.restartLoopWindowMs > 0
      ? parsed.restartLoopWindowMs : defaultConfig.restartLoopWindowMs,
    proxy: {
      enabled: typeof proxy.enabled === "boolean" ? proxy.enabled : defaultConfig.proxy.enabled,
      port: typeof proxy.port === "number" && Number.isInteger(proxy.port) && proxy.port > 0 && proxy.port <= 65535
        ? proxy.port : defaultConfig.proxy.port,
      readinessTimeoutMs: typeof proxy.readinessTimeoutMs === "number" && Number.isFinite(proxy.readinessTimeoutMs) && proxy.readinessTimeoutMs > 0
        ? proxy.readinessTimeoutMs : defaultConfig.proxy.readinessTimeoutMs
    }
  };
}

function printUsage(): void {
  console.log(`Usage:
  hypre <entry-file> [watch-directory]
  hypre run <npm-script> [watch-directory]
  hypre restart
  hypre init
  hypre --version
  hypre -h | --help`);
}

function printVersion(): void {
  const packagePath = path.resolve(__dirname, "../package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version: string };
  console.log(packageJson.version);
}

function ensureNpmScript(cwd: string, scriptName: string): void {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) throw new Error("hypre run requires a package.json in the current directory");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    throw new Error(`npm script not found: ${scriptName}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const cwd = process.cwd();

  if (command === "--version" || command === "-v" || command === "--v" || command === "-V") {
    printVersion();
    return;
  }
  if (["--help", "-help", "-h"].includes(command)) {
    printUsage();
    return;
  }
  if (command === "init") {
    const configPath = path.join(cwd, "hypre.config.json");
    if (fs.existsSync(configPath)) throw new Error("hypre.config.json already exists; it was not overwritten");
    fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, { flag: "wx" });
    logger.success(`Created ${configPath}`);
    return;
  }
  if (command === "restart") {
    await requestRestart(cwd);
    logger.success("Restart request completed");
    return;
  }
  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const runScript = command === "run";
  const scriptName = runScript ? args[1] : undefined;
  const entryArg = runScript ? undefined : command;
  const watchArg = runScript ? args[2] : args[1];

  if (runScript && !scriptName) throw new Error("Usage: hypre run <npm-script> [watch-directory]");
  const config = loadConfig(cwd);
  const watchDir = path.resolve(cwd, watchArg || ".");
  if (!fs.existsSync(watchDir) || !fs.statSync(watchDir).isDirectory()) {
    throw new Error(`Watch directory not found: ${watchDir}`);
  }

  let entry = "";
  let isHtmlEntry = false;
  let runner = null as ReturnType<typeof getRunner> | null;
  if (runScript) {
    ensureNpmScript(cwd, scriptName!);
    runner = npmScriptRunner(scriptName!);
    entry = `npm run ${scriptName}`;
  } else {
    entry = path.resolve(cwd, entryArg!);
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
      throw new Error(`Entry file not found: ${entry}`);
    }
    isHtmlEntry = path.extname(entry).toLowerCase() === ".html";
    if (!isHtmlEntry) runner = getRunner(entry);
  }

  if (config.proxy.enabled && !runner) {
    throw new Error("Proxy mode requires a running program; it cannot be used with an HTML entry");
  }

  logger.info(`Entry       : ${entry}`);
  logger.info(`Watch       : ${watchDir}`);
  if (config.proxy.enabled) logger.info(`Proxy       : http://localhost:${config.proxy.port}`);
  if (isHtmlEntry) logger.info(`Preview     : http://localhost:${config.previewPort}`);

  const processCwd = runScript ? cwd : watchDir;
  const processManager = runner ? new ProcessManager(processCwd) : null;
  const proxyServer = runner && config.proxy.enabled
    ? new LiveProxyServer(config.proxy.port, config.proxy.readinessTimeoutMs)
    : null;
  const restartManager = processManager && runner
    ? new RestartManager(processManager, runner, config, proxyServer)
    : null;
  const previewServer = isHtmlEntry
    ? new IPreviewServer(path.dirname(entry), path.basename(entry), config.previewPort)
    : null;
  const watchedExtensions = [
    ...getSupportedExtensions(),
    ...(runScript ? [".json"] : [])
  ];
  const watcher = new FileWatcher(
    watchDir,
    config,
    () => previewServer ? previewServer.reload() : restartManager?.schedule(),
    previewServer ? [".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"] : watchedExtensions
  );
  const controlServer = restartManager ? new ControlServer(cwd, () => restartManager.restartNow()) : null;

  registerShutdown(watcher, async () => {
    await controlServer?.stop();
    await restartManager?.shutdown();
    await proxyServer?.stop();
    await previewServer?.stop();
  });

  try {
    await proxyServer?.start();
    await previewServer?.start();
    await watcher.start();
    await restartManager?.start();
    await controlServer?.start();
  } catch (error) {
    await watcher.stop();
    await controlServer?.stop();
    await restartManager?.shutdown();
    await proxyServer?.stop();
    await previewServer?.stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
