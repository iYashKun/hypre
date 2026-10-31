import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";

import type { RunnerDefinition } from "../types";
import { logger } from "../utils/logger";

export class ProcessManager {
  private child: ChildProcess | null = null;
  constructor(private readonly cwd: string) {}

  async stop(): Promise<void> {
    const oldChild = this.child;
    if (!oldChild?.pid) {
      this.child = null;
      return;
    }

    this.child = null;

    await new Promise<void>((resolve) => {
      treeKill(oldChild.pid!, "SIGTERM", (error) => {
        if (error) { logger.warn(`Process termination: ${error.message}`); }
        resolve();
      });
    });
  }

  async start(runner: RunnerDefinition): Promise<void> {
    logger.info(`Executing: ${runner.command} ${runner.args.join(" ")}`);
    const child = spawn(runner.command, runner.args, { cwd: this.cwd, stdio: "inherit", shell: false, windowsHide: true });
    this.child = child;
    
    child.on("error", (error) => {
      logger.error(error.message);
      if (this.child === child) { this.child = null; }
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) { this.child = null; }
      logger.info(`Process exited | Code: ${code} | Signal: ${signal ?? "none"}`);
    });

    logger.success(`Process started | PID: ${child.pid ?? "pending"}`);
  }

  async restart(runner: RunnerDefinition): Promise<void> {
    await this.stop();
    await this.start(runner);
  }
}
