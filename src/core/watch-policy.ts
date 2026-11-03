import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import picomatch from "picomatch";
import treeKill from "tree-kill";

import type { WatchRule } from "../types";
import { logger } from "../utils/logger";
import { loadEnvFile } from "../utils/env";

export class WatchPolicyDispatcher {
  private readonly rules: Array<{ rule: WatchRule; matches: (file: string) => boolean }>;
  private readonly commandTimers = new Map<number, NodeJS.Timeout>();
  private readonly commandChildren = new Set<ChildProcess>();
  private stopped = false;

  constructor(
    private readonly root: string,
    rules: WatchRule[],
    private readonly debounceMs: number,
    private readonly reloadPreview: () => void
  ) {
    this.rules = rules.map((rule) => ({
      rule,
      matches: picomatch(rule.pattern, { dot: true })
    }));
  }

  dispatch(file: string, restart: () => void): void {
    if (this.stopped) return;
    const relativePath = path.relative(this.root, path.resolve(file)).split(path.sep).join("/");
    const matchedRule = this.rules.find(({ matches }) => matches(relativePath));
    if (!matchedRule) {
      restart();
      return;
    }

    const { rule } = matchedRule;
    switch (rule.action) {
      case "ignore":
        return;
      case "restart":
        restart();
        return;
      case "preview-reload":
        this.reloadPreview();
        return;
      case "command":
        this.scheduleCommand(this.rules.indexOf(matchedRule), rule, file);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.commandTimers.values()) clearTimeout(timer);
    this.commandTimers.clear();
    await Promise.all([...this.commandChildren].map((child) => this.stopCommand(child)));
  }

  private scheduleCommand(index: number, rule: WatchRule, file: string): void {
    const previousTimer = this.commandTimers.get(index);
    if (previousTimer) clearTimeout(previousTimer);
    this.commandTimers.set(index, setTimeout(() => {
      this.commandTimers.delete(index);
      if (this.stopped) return;
      const cwd = rule.cwd ? path.resolve(this.root, rule.cwd) : this.root;
      logger.info(`Running watch command for ${path.relative(this.root, file)}`);
      void loadEnvFile(path.join(this.root, ".env")).then((env) => {
        if (this.stopped) return;
        const child = spawn(rule.command!, rule.args ?? [], {
          cwd,
          env: { ...process.env, ...env },
          stdio: "inherit",
          shell: rule.shell ?? false,
          windowsHide: true
        });
        this.commandChildren.add(child);
        child.once("close", () => this.commandChildren.delete(child));
        child.once("error", () => this.commandChildren.delete(child));
        child.once("error", (error) => logger.error(`Watch command failed: ${error.message}`));
        child.once("close", (code, signal) => {
          if (!this.stopped && code !== 0) logger.error(`Watch command exited | Code: ${code} | Signal: ${signal ?? "none"}`);
        });
      }).catch((error: unknown) => {
        logger.error(error instanceof Error ? error.message : String(error));
      });
    }, this.debounceMs));
  }

  private async stopCommand(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      treeKill(child.pid!, "SIGTERM", (error) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          logger.warn(`Watch command termination: ${error.message}`);
        }
        resolve();
      });
    });
    if (await this.waitForCommandExit(child, 1000)) return;

    await new Promise<void>((resolve) => {
      treeKill(child.pid!, "SIGKILL", () => resolve());
    });
    await this.waitForCommandExit(child, 1000);
  }

  private async waitForCommandExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;

    return new Promise<boolean>((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("close", onClose);
        resolve(false);
      }, timeoutMs);
      child.once("close", onClose);
    });
  }
}
