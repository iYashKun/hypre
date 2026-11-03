import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import picomatch from "picomatch";

import type { WatchRule } from "../types";
import { logger } from "../utils/logger";
import { loadEnvFile } from "../utils/env";
import { signalProcessTree } from "../utils/process";

export class WatchPolicyDispatcher {
  private readonly rules: Array<{ rule: WatchRule; matches: (file: string) => boolean }>;
  private readonly commandTimers = new Map<number, NodeJS.Timeout>();
  private readonly commandRuns = new Map<number, Promise<void>>();
  private readonly pendingCommands = new Map<number, { rule: WatchRule; file: string }>();
  private readonly commandChildren = new Map<number, ChildProcess>();
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
    this.pendingCommands.clear();
    await Promise.all([...this.commandChildren.values()].map((child) => this.stopCommand(child)));
    await Promise.all(this.commandRuns.values());
  }

  private scheduleCommand(index: number, rule: WatchRule, file: string): void {
    const previousTimer = this.commandTimers.get(index);
    if (previousTimer) clearTimeout(previousTimer);
    this.commandTimers.set(index, setTimeout(() => {
      this.commandTimers.delete(index);
      if (this.stopped) return;
      if (this.commandRuns.has(index)) {
        this.pendingCommands.set(index, { rule, file });
        return;
      }

      const run = this.runCommand(index, rule, file);
      this.commandRuns.set(index, run);
      const finish = () => {
        if (this.commandRuns.get(index) !== run) return;
        this.commandRuns.delete(index);
        const pending = this.pendingCommands.get(index);
        this.pendingCommands.delete(index);
        if (pending && !this.stopped) this.scheduleCommand(index, pending.rule, pending.file);
      };
      void run.then(finish, finish);
    }, this.debounceMs));
  }

  private async runCommand(index: number, rule: WatchRule, file: string): Promise<void> {
    try {
      const env = await loadEnvFile(path.join(this.root, ".env"));
      if (this.stopped) return;
      const cwd = rule.cwd ? path.resolve(this.root, rule.cwd) : this.root;
      const args = rule.args ?? [];
      const shell = rule.shell ?? false;
      const command = shell ? [rule.command!, ...args].join(" ") : rule.command!;
      logger.info(`Running watch command for ${path.relative(this.root, file)}`);
      await new Promise<void>((resolve) => {
        const child = spawn(command, shell ? [] : args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: "inherit",
          shell,
          detached: process.platform !== "win32",
          windowsHide: true
        });
        this.commandChildren.set(index, child);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (this.commandChildren.get(index) === child) this.commandChildren.delete(index);
          resolve();
        };
        child.once("error", (error) => {
          logger.error(`Watch command failed: ${error.message}`);
          finish();
        });
        child.once("close", (code, signal) => {
          if (!this.stopped && code !== 0) logger.error(`Watch command exited | Code: ${code} | Signal: ${signal ?? "none"}`);
          finish();
        });
      });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
    }
  }

  private async stopCommand(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

    await signalProcessTree(child.pid, "SIGTERM").catch((error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) {
        logger.warn(`Watch command termination: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (await this.waitForCommandExit(child, 1000)) return;

    await signalProcessTree(child.pid, "SIGKILL").catch(() => {});
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
