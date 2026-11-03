import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";

import type { RunnerDefinition } from "../types";
import { logger } from "../utils/logger";

export interface ProcessStartOptions {
  startupGraceMs: number;
  shutdownTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  waitUntilReady?: () => Promise<void>;
  onPromote?: () => void;
}

interface ManagedProcess {
  child: ChildProcess;
  stderr: string;
  exited: boolean;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitPromise: Promise<void>;
}

export class ProcessManager {
  private active: ManagedProcess | null = null;
  private readonly candidates = new Set<ManagedProcess>();
  private crashHandler: (() => void) | null = null;
  private lastSuccessfulBuildAt: Date | null = null;

  constructor(private readonly cwd: string) {}

  setCrashHandler(handler: () => void): void {
    this.crashHandler = handler;
  }

  getLastSuccessfulBuildAt(): Date | null {
    return this.lastSuccessfulBuildAt;
  }

  hasActiveProcess(): boolean {
    return this.active !== null && !this.active.exited;
  }

  getStatus(): { active: boolean; pid: number | null; uptimeMs: number | null; lastSuccessfulRestartAt: string | null } {
    const active = this.active;
    const isActive = active !== null && !active.exited;
    return {
      active: isActive,
      pid: isActive ? active.child.pid ?? null : null,
      uptimeMs: isActive ? Date.now() - active.startedAt : null,
      lastSuccessfulRestartAt: this.lastSuccessfulBuildAt?.toISOString() ?? null
    };
  }

  async stop(timeoutMs = 5000): Promise<void> {
    const active = this.active;
    this.active = null;
    const stopping = new Set(this.candidates);
    if (active) stopping.add(active);
    await Promise.all([...stopping].map((record) => this.terminate(record, timeoutMs)));
  }

  async start(runner: RunnerDefinition, options: ProcessStartOptions): Promise<void> {
    const candidate = await this.launch(runner, options);
    this.active = candidate;
    options.onPromote?.();
    this.markSuccessful();
  }

  async restart(runner: RunnerDefinition, options: ProcessStartOptions): Promise<void> {
    const previous = this.active;
    try {
      const candidate = await this.launch(runner, options);
      this.active = candidate;
      options.onPromote?.();
      this.markSuccessful();

      if (previous && previous !== candidate) {
        await this.terminate(previous, options.shutdownTimeoutMs);
      }
    } catch (error) {
      if (previous && this.isPortConflict(error)) {
        logger.warn("Candidate needs the occupied application port; handing off with a short interruption");
        this.active = null;
        await this.terminate(previous, options.shutdownTimeoutMs);
        const candidate = await this.launch(runner, options);
        this.active = candidate;
        options.onPromote?.();
        this.markSuccessful();
        return;
      }
      this.active = previous;
      throw error;
    }
  }

  private async launch(
    runner: RunnerDefinition,
    options: ProcessStartOptions
  ): Promise<ManagedProcess> {
    if (runner.build) await this.runBuild(runner.build);
    logger.build("Starting candidate process...");
    logger.info(`Executing: ${runner.command} ${runner.args.join(" ")}`);

    const child = spawn(runner.command, runner.args, {
      cwd: runner.cwd ?? this.cwd,
      env: { ...process.env, ...runner.env, ...options.env },
      stdio: ["inherit", "pipe", "pipe"],
      shell: runner.shell ?? false,
      windowsHide: true
    });

    let resolveExit!: () => void;
    const record: ManagedProcess = {
      child,
      stderr: "",
      exited: false,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve; })
    };
    this.candidates.add(record);

    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      record.stderr = `${record.stderr}${chunk.toString()}`.slice(-65536);
      process.stderr.write(chunk);
    });

    child.on("exit", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      logger.info(`Process exited | Code: ${code} | Signal: ${signal ?? "none"}`);
    });

    child.on("close", (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.signal = signal;
      this.candidates.delete(record);
      resolveExit();
      if (this.active === record) {
        this.active = null;
        if (code !== 0 || signal !== null) this.crashHandler?.();
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
    } catch (error) {
      this.candidates.delete(record);
      throw new Error(`Could not start ${runner.command}: ${error instanceof Error ? error.message : String(error)}`);
    }

    logger.success(`Candidate started | PID: ${child.pid ?? "pending"}`);

    try {
      if (options.waitUntilReady) {
        await Promise.race([
          options.waitUntilReady(),
          record.exitPromise.then(() => {
            throw this.exitError(record);
          })
        ]);
      } else {
        const earlyExit = await Promise.race([
          new Promise<false>((resolve) => setTimeout(() => resolve(false), options.startupGraceMs)),
          record.exitPromise.then(() => true)
        ]);

        if (earlyExit && record.exitCode !== 0) throw this.exitError(record);
      }

      if (record.exited && record.exitCode !== 0) throw this.exitError(record);
      this.candidates.delete(record);
      return record;
    } catch (error) {
      await this.terminate(record, options.shutdownTimeoutMs);
      this.candidates.delete(record);
      throw error;
    }
  }

  private async runBuild(build: NonNullable<RunnerDefinition["build"]>): Promise<void> {
    logger.build("Compiling TypeScript...");
    const output: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(build.command, build.args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
      child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.once("error", (error) => reject(new Error(`Could not run TypeScript compiler: ${error.message}`)));
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else {
          const diagnostics = output.join("").trim();
          reject(new Error(`TypeScript compilation failed | Code: ${code} | Signal: ${signal ?? "none"}${diagnostics ? `\n${diagnostics}` : ""}`));
        }
      });
    });
  }

  private exitError(record: ManagedProcess): Error {
    const details = record.stderr.trim();
    const status = `Candidate exited | Code: ${record.exitCode} | Signal: ${record.signal ?? "none"}`;
    return new Error(details ? `${status}\n${details}` : status);
  }

  private isPortConflict(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /EADDRINUSE|address already in use/i.test(message);
  }

  private markSuccessful(): void {
    this.lastSuccessfulBuildAt = new Date();
    logger.success(`Last successful build: ${this.lastSuccessfulBuildAt.toLocaleString()}`);
    logger.info("Replacement process is ready");
  }

  private async terminate(record: ManagedProcess, timeoutMs: number): Promise<void> {
    if (record.exited || !record.child.pid) return;

    await new Promise<void>((resolve) => {
      treeKill(record.child.pid!, "SIGTERM", (error) => {
        if (error && !record.exited) logger.warn(`Graceful termination: ${error.message}`);
        resolve();
      });
    });

    if (await this.waitForExit(record, timeoutMs)) return;

    logger.warn(`Process did not exit within ${timeoutMs}ms; forcing termination`);
    await new Promise<void>((resolve) => {
      treeKill(record.child.pid!, "SIGKILL", () => resolve());
    });
    await this.waitForExit(record, 1000);
  }

  private async waitForExit(record: ManagedProcess, timeoutMs: number): Promise<boolean> {
    if (record.exited) return true;

    let timer: NodeJS.Timeout;
    const timedOut = await Promise.race([
      record.exitPromise.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      })
    ]);
    clearTimeout(timer!);
    return !timedOut;
  }
}
