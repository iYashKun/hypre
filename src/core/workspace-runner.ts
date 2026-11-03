import path from "node:path";
import picomatch from "picomatch";

import type { EngineStatus, ReloadConfig } from "../types";
import { logger } from "../utils/logger";
import { FileWatcher } from "./watcher";
import { WatchPolicyDispatcher } from "./watch-policy";
import { RestartManager } from "./restart-manager";

export interface WorkspaceServiceRuntime {
  name: string;
  manager: RestartManager;
  watch: string[];
  dependsOn: string[];
}

interface CompiledService extends WorkspaceServiceRuntime {
  matches: Array<(file: string) => boolean>;
}

export class WorkspaceRunner {
  private readonly services = new Map<string, CompiledService>();
  private readonly startOrder: CompiledService[];
  private readonly watcher: FileWatcher;

  constructor(
    private readonly root: string,
    config: ReloadConfig,
    services: WorkspaceServiceRuntime[],
    private readonly policies: WatchPolicyDispatcher
  ) {
    for (const service of services) {
      if (this.services.has(service.name)) throw new Error(`Duplicate service name: ${service.name}`);
      this.services.set(service.name, {
        ...service,
        matches: service.watch.map((pattern) => picomatch(pattern, { dot: true }))
      });
    }
    this.startOrder = this.resolveStartOrder();
    this.watcher = new FileWatcher(
      root,
      config,
      (file) => this.policies.dispatch(file, () => this.restartAffected(file)),
      [],
      [],
      true
    );
  }

  async start(): Promise<void> {
    await this.watcher.start();
    for (const service of this.startOrder) {
      logger.info(`Starting service: ${service.name}`);
      await service.manager.start();
    }
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
    await this.policies.stop();
  }

  async shutdown(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.watcher.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.policies.stop();
    } catch (error) {
      errors.push(error);
    }
    for (const service of [...this.startOrder].reverse()) {
      try {
        await service.manager.shutdown();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "One or more workspace services failed to shut down");
  }

  async restartNow(serviceName?: string): Promise<void> {
    if (serviceName) {
      const service = this.services.get(serviceName);
      if (!service) throw new Error(`Unknown service: ${serviceName}`);
      await service.manager.restartNow();
      return;
    }
    const errors: unknown[] = [];
    for (const service of this.startOrder) {
      try {
        await service.manager.restartNow();
      } catch (error) {
        errors.push(new Error(`Could not restart service ${service.name}`, { cause: error }));
      }
    }
    if (errors.length) throw new AggregateError(errors, "One or more workspace services failed to restart");
  }

  getStatus(): EngineStatus {
    const services = Object.fromEntries(this.startOrder.map((service) => [service.name, service.manager.getStatus()]));
    const statuses = Object.values(services);
    const restartTimes = statuses
      .map((status) => status.lastSuccessfulRestartAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      active: statuses.some((status) => status.active),
      pid: null,
      uptimeMs: null,
      lastSuccessfulRestartAt: restartTimes.at(-1) ?? null,
      restartLoopPaused: statuses.some((status) => status.restartLoopPaused),
      restartFailures: statuses.reduce((total, status) => total + status.restartFailures, 0),
      services
    };
  }

  private restartAffected(file: string): void {
    const relativePath = path.relative(this.root, path.resolve(file)).split(path.sep).join("/");
    const isEnvFile = relativePath === ".env";
    for (const service of this.startOrder) {
      if (isEnvFile || service.matches.some((matches) => matches(relativePath))) service.manager.schedule();
    }
  }

  private resolveStartOrder(): CompiledService[] {
    const resolved = new Set<string>();
    const visiting = new Set<string>();
    const order: CompiledService[] = [];

    const visit = (name: string): void => {
      const service = this.services.get(name);
      if (!service) throw new Error(`Unknown service dependency: ${name}`);
      if (resolved.has(name)) return;
      if (visiting.has(name)) throw new Error(`Service dependency cycle detected at: ${name}`);
      visiting.add(name);
      for (const dependency of service.dependsOn) visit(dependency);
      visiting.delete(name);
      resolved.add(name);
      order.push(service);
    };

    for (const name of this.services.keys()) visit(name);
    return order;
  }
}
