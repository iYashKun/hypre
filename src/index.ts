#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { defaultConfig } from "./config/default";
import { ControlServer, requestRestart, requestStatus } from "./core/control-server";
import { IPreviewServer } from "./core/preview-server";
import { ProcessManager } from "./core/process-manager";
import { LiveProxyServer } from "./core/live-proxy";
import { RestartManager } from "./core/restart-manager";
import { registerShutdown } from "./core/shutdown";
import { FileWatcher } from "./core/watcher";
import { getRunner, getSupportedExtensions } from "./runners";
import { npmScriptRunner } from "./runners/npm-script";
import type { ProjectConfig, ReloadConfig, RunnerDefinition, ServiceConfig, WatchRule, WatchRuleAction } from "./types";
import { logger } from "./utils/logger";
import { WatchPolicyDispatcher } from "./core/watch-policy";
import { WorkspaceRunner, type WorkspaceServiceRuntime } from "./core/workspace-runner";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWatchRules(value: unknown): WatchRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid configuration: watchRules must be an array");

  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.pattern !== "string" || !item.pattern) {
      throw new Error(`Invalid configuration: watchRules[${index}] requires a pattern`);
    }
    const actions: WatchRuleAction[] = ["ignore", "restart", "preview-reload", "command"];
    if (!actions.includes(item.action as WatchRuleAction)) {
      throw new Error(`Invalid configuration: watchRules[${index}].action is unsupported`);
    }
    if (item.action === "command" && (typeof item.command !== "string" || !item.command)) {
      throw new Error(`Invalid configuration: watchRules[${index}] command action requires a command`);
    }
    if (item.args !== undefined && (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === "string"))) {
      throw new Error(`Invalid configuration: watchRules[${index}].args must be an array of strings`);
    }
    if (item.cwd !== undefined && typeof item.cwd !== "string") {
      throw new Error(`Invalid configuration: watchRules[${index}].cwd must be a string`);
    }
    if (item.shell !== undefined && typeof item.shell !== "boolean") {
      throw new Error(`Invalid configuration: watchRules[${index}].shell must be a boolean`);
    }
    return item as unknown as WatchRule;
  });
}

function parseServices(value: unknown): Record<string, ServiceConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid configuration: services must be an object");

  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    if (!name || !isRecord(item)) throw new Error(`Invalid configuration: service ${name || "<empty>"} must be an object`);
    const launchFields = ["entry", "script", "command"].filter((key) => typeof item[key] === "string" && item[key]);
    if (launchFields.length !== 1) {
      throw new Error(`Invalid configuration: service ${name} requires exactly one of entry, script, or command`);
    }
    for (const key of ["watch", "dependsOn", "args"] as const) {
      if (item[key] !== undefined && (!Array.isArray(item[key]) || !item[key].every((part) => typeof part === "string"))) {
        throw new Error(`Invalid configuration: service ${name}.${key} must be an array of strings`);
      }
    }
    if (item.cwd !== undefined && typeof item.cwd !== "string") {
      throw new Error(`Invalid configuration: service ${name}.cwd must be a string`);
    }
    if (item.shell !== undefined && typeof item.shell !== "boolean") {
      throw new Error(`Invalid configuration: service ${name}.shell must be a boolean`);
    }
    if (item.env !== undefined && (!isRecord(item.env) || Object.values(item.env).some((entry) => entry !== undefined && typeof entry !== "string"))) {
      throw new Error(`Invalid configuration: service ${name}.env must contain string values`);
    }
    return [name, item as unknown as ServiceConfig];
  }));
}

function loadConfig(cwd: string): ProjectConfig {
  const configPath = path.join(cwd, "hypre.config.json");
  if (!fs.existsSync(configPath)) return { ...defaultConfig, proxy: { ...defaultConfig.proxy }, watchRules: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("Invalid configuration: expected a JSON object");

  const proxy = isRecord(parsed.proxy) ? parsed.proxy : {};
  const services = parseServices(parsed.services);
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
        ? proxy.readinessTimeoutMs : defaultConfig.proxy.readinessTimeoutMs,
      healthPath: typeof proxy.healthPath === "string" && proxy.healthPath.startsWith("/")
        ? proxy.healthPath : defaultConfig.proxy.healthPath
    },
    watchRules: parseWatchRules(parsed.watchRules),
    ...(services ? { services } : {})
  };
}

function printUsage(): void {
  console.log(`Usage:
  hypre <entry-file> [watch-directory]
  hypre run <npm-script> [watch-directory]
  hypre dev
  hypre restart [service]
  hypre status
  hypre init
  hypre --v
  hypre --help`);
}

function printVersion(): void {
  const packagePath = path.resolve(__dirname, "../package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version: string };
  console.log(packageJson.version);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return days > 0
    ? `${days}d ${hours}h ${minutes}m ${seconds}s`
    : hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : `${minutes}m ${seconds}s`;
}

async function printStatus(cwd: string): Promise<void> {
  const status = await requestStatus(cwd);
  if (status.services) {
    console.log("Workspace services:");
    for (const [name, service] of Object.entries(status.services)) {
      console.log(`  ${name}: ${service.active ? `running (PID ${service.pid ?? "-"}, ${formatDuration(service.uptimeMs ?? 0)})` : "stopped"}`);
      console.log(`    Last restart: ${service.lastSuccessfulRestartAt ? new Date(service.lastSuccessfulRestartAt).toLocaleString() : "Never"}`);
      console.log(`    Restart loop: ${service.restartLoopPaused ? "PAUSED" : "active"} (${service.restartFailures} recent failures)`);
    }
    return;
  }
  console.log(`Process       : ${status.active ? "running" : "stopped"}`);
  console.log(`PID           : ${status.pid ?? "-"}`);
  console.log(`Uptime        : ${status.uptimeMs === null ? "-" : formatDuration(status.uptimeMs)}`);
  console.log(`Last restart  : ${status.lastSuccessfulRestartAt ? new Date(status.lastSuccessfulRestartAt).toLocaleString() : "Never"}`);
  console.log(`Restart loop  : ${status.restartLoopPaused ? "PAUSED" : "active"} (${status.restartFailures} recent failures)`);
}

function ensureNpmScript(cwd: string, scriptName: string): void {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) throw new Error("hypre run requires a package.json in the current directory");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    throw new Error(`npm script not found: ${scriptName}`);
  }
}

function createWorkspaceServices(cwd: string, config: ProjectConfig): WorkspaceServiceRuntime[] {
  if (!config.services || Object.keys(config.services).length === 0) {
    throw new Error('hypre dev requires a non-empty "services" object in hypre.config.json');
  }
  if (config.proxy.enabled) {
    throw new Error("Workspace mode does not support the single-service proxy; configure service ports in each service instead");
  }

  const envFile = path.join(cwd, ".env");
  return Object.entries(config.services).map(([name, service]) => {
    const serviceCwd = path.resolve(cwd, service.cwd || ".");
    if (!fs.existsSync(serviceCwd) || !fs.statSync(serviceCwd).isDirectory()) {
      throw new Error(`Service ${name} working directory not found: ${serviceCwd}`);
    }

    let runner: RunnerDefinition;
    if (service.entry) {
      const entry = path.resolve(serviceCwd, service.entry);
      if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
        throw new Error(`Service ${name} entry file not found: ${entry}`);
      }
      runner = getRunner(entry, serviceCwd);
    } else if (service.script) {
      ensureNpmScript(serviceCwd, service.script);
      runner = npmScriptRunner(service.script);
    } else {
      runner = {
        command: service.command!,
        args: service.args ?? [],
        shell: service.shell,
        env: service.env
      };
    }
    if (service.env) {
      runner = { ...runner, env: { ...runner.env, ...service.env } };
    }

    const relativeCwd = path.relative(cwd, serviceCwd).split(path.sep).join("/");
    const watchPrefix = relativeCwd ? `${relativeCwd}/` : "";
    const defaultWatch = [`${watchPrefix}**/*`];
    const processManager = new ProcessManager(serviceCwd);
    return {
      name,
      manager: new RestartManager(processManager, runner, config, envFile),
      watch: service.watch ?? defaultWatch,
      dependsOn: service.dependsOn ?? []
    };
  });
}

async function runWorkspace(cwd: string, config: ProjectConfig): Promise<void> {
  const policies = new WatchPolicyDispatcher(cwd, config.watchRules, config.debounceMs, () => {});
  const workspace = new WorkspaceRunner(cwd, config, createWorkspaceServices(cwd, config), policies);
  const controlServer = new ControlServer(cwd, (service) => workspace.restartNow(service), () => workspace.getStatus());

  registerShutdown(workspace, async () => {
    await controlServer.stop();
    await workspace.shutdown();
  });

  try {
    await workspace.start();
    await controlServer.start();
  } catch (error) {
    await controlServer.stop();
    await workspace.shutdown();
    throw error;
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
    await requestRestart(cwd, args[1]);
    logger.success(args[1] ? `Restart request completed for ${args[1]}` : "Restart request completed");
    return;
  }
  if (command === "status") {
    await printStatus(cwd);
    return;
  }
  if (command === "dev") {
    await runWorkspace(cwd, loadConfig(cwd));
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
    if (!isHtmlEntry) runner = getRunner(entry, watchDir);
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
  const envFile = path.join(cwd, ".env");
  const proxyServer = runner && config.proxy.enabled
    ? new LiveProxyServer(config.proxy.port, config.proxy.readinessTimeoutMs, config.proxy.healthPath, config.shutdownTimeoutMs)
    : null;
  const restartManager = processManager && runner
    ? new RestartManager(processManager, runner, config, envFile, proxyServer)
    : null;
  const previewServer = isHtmlEntry
    ? new IPreviewServer(path.dirname(entry), path.basename(entry), config.previewPort)
    : null;
  const watchedExtensions = [
    ...getSupportedExtensions(),
    ...(runScript ? [".json"] : [])
  ];
  const policies = new WatchPolicyDispatcher(cwd, config.watchRules, config.debounceMs, () => previewServer?.reload());
  const watcher = new FileWatcher(
    watchDir,
    config,
    (file) => policies.dispatch(file, () => {
      if (path.resolve(file) === envFile) {
        restartManager?.schedule();
      } else if (previewServer) {
        previewServer.reload();
      } else {
        restartManager?.schedule();
      }
    }),
    previewServer ? [".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"] : watchedExtensions,
    runner ? [envFile] : [],
    Boolean(runner) || config.watchRules.length > 0
  );
  const controlServer = restartManager
    ? new ControlServer(cwd, (service) => {
      if (service) throw new Error(`Unknown service: ${service}`);
      return restartManager.restartNow();
    }, () => restartManager.getStatus())
    : null;

  registerShutdown(watcher, async () => {
    await controlServer?.stop();
    await policies.stop();
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
    await policies.stop();
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
