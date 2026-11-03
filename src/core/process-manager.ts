import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunnerDefinition } from "../types";
import { logger } from "../utils/logger";
import { signalProcessTree } from "../utils/process";

export interface ProcessStartOptions {
  startupGraceMs: number;
  shutdownTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  waitUntilReady?: (signal: AbortSignal) => Promise<void>;
  onPromote?: () => void | Promise<void>;
}

interface ManagedProcess {
  child: ChildProcess;
  stderr: string;
  exited: boolean;
  closed: boolean;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitPromise: Promise<void>;
  closePromise: Promise<void>;
  artifactPath: string | null;
}

export class ProcessManager {
  private active: ManagedProcess | null = null;
  private readonly candidates = new Set<ManagedProcess>();
  private crashHandler: (() => void) | null = null;
  private lastSuccessfulBuildAt: Date | null = null;
  private buildChild: ChildProcess | null = null;

  constructor(private readonly cwd: string) {}

  setCrashHandler(handler: () => void): void {
    this.crashHandler = handler;
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
    if (this.buildChild) await this.terminateChild(this.buildChild, timeoutMs);
    const active = this.active;
    this.active = null;
    const stopping = new Set(this.candidates);
    if (active) stopping.add(active);
    await Promise.all([...stopping].map((record) => this.terminate(record, timeoutMs)));
  }

  async start(runner: RunnerDefinition, options: ProcessStartOptions): Promise<void> {
    const candidate = await this.launch(runner, options);
    this.active = candidate;
    await options.onPromote?.();
    this.markSuccessful();
  }

  async restart(runner: RunnerDefinition, options: ProcessStartOptions): Promise<void> {
    const previous = this.active;
    try {
      const candidate = await this.launch(runner, options);
      this.active = candidate;
      await options.onPromote?.();
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
        await options.onPromote?.();
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
    const artifactPath = runner.build?.artifact
      ? path.join(os.tmpdir(), `hypre-${randomUUID()}${process.platform === "win32" ? ".exe" : ""}`)
      : null;
    try {
      if (runner.build) await this.runBuild(runner.build, artifactPath);
    } catch (error) {
      if (artifactPath) await rm(artifactPath, { force: true }).catch(() => {});
      throw error;
    }
    logger.build("Starting candidate process...");
    const command = artifactPath ? runner.command.replaceAll("{{artifact}}", artifactPath) : runner.command;
    const args = artifactPath ? runner.args.map((arg) => arg.replaceAll("{{artifact}}", artifactPath)) : runner.args;
    const shell = runner.shell ?? false;
    const spawnCommand = shell ? [command, ...args].join(" ") : command;
    const spawnArgs = shell ? [] : args;
    logger.info(`Executing: ${command} ${args.join(" ")}`);

    const child = spawn(spawnCommand, spawnArgs, {
      cwd: runner.cwd ?? this.cwd,
      env: { ...process.env, ...runner.env, ...options.env },
      stdio: ["inherit", "pipe", "pipe"],
      shell,
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let resolveExit!: () => void;
    let resolveClose!: () => void;
    const record: ManagedProcess = {
      child,
      stderr: "",
      exited: false,
      closed: false,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      exitPromise: new Promise<void>((resolve) => { resolveExit = resolve; }),
      closePromise: new Promise<void>((resolve) => { resolveClose = resolve; }),
      artifactPath
    };
    this.candidates.add(record);

    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      record.stderr = `${record.stderr}${chunk.toString()}`.slice(-65536);
      process.stderr.write(chunk);
    });

    child.on("exit", (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.signal = signal;
      resolveExit();
      logger.info(`Process exited | Code: ${code} | Signal: ${signal ?? "none"}`);
      if (record.child.pid && !record.closed) void this.terminate(record, 1000);
      if (this.active === record) {
        this.active = null;
        if (code !== 0 || signal !== null) this.crashHandler?.();
      }
    });

    child.on("close", (code, signal) => {
      if (!record.exited) {
        record.exited = true;
        record.exitCode = code;
        record.signal = signal;
        resolveExit();
      }
      record.closed = true;
      record.exited = true;
      record.exitCode = code;
      record.signal = signal;
      this.candidates.delete(record);
      resolveClose();
      if (record.artifactPath) void rm(record.artifactPath, { force: true }).catch(() => {});
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
    } catch (error) {
      this.candidates.delete(record);
      if (artifactPath) await rm(artifactPath, { force: true }).catch(() => {});
      throw new Error(`Could not start ${runner.command}: ${error instanceof Error ? error.message : String(error)}`);
    }

    logger.success(`Candidate started | PID: ${child.pid ?? "pending"}`);

    const readinessController = new AbortController();
    try {
      if (options.waitUntilReady) {
        await Promise.race([
          options.waitUntilReady(readinessController.signal),
          record.exitPromise.then(() => {
            readinessController.abort();
            throw this.exitError(record);
          })
        ]);
      } else {
        let startupTimer: NodeJS.Timeout;
        const earlyExit = await Promise.race([
          new Promise<false>((resolve) => {
            startupTimer = setTimeout(() => resolve(false), options.startupGraceMs);
          }),
          record.exitPromise.then(() => true)
        ]);
        clearTimeout(startupTimer!);

        if (earlyExit && record.exitCode !== 0) throw this.exitError(record);
      }

      if (record.exited && record.exitCode !== 0) throw this.exitError(record);
      readinessController.abort();
      this.candidates.delete(record);
      return record;
    } catch (error) {
      readinessController.abort();
      await this.terminate(record, options.shutdownTimeoutMs);
      this.candidates.delete(record);
      if (artifactPath) await rm(artifactPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async runBuild(build: NonNullable<RunnerDefinition["build"]>, artifactPath: string | null): Promise<void> {
    logger.build("Building candidate...");
    const output: string[] = [];
    const args = artifactPath ? build.args.map((arg) => arg.replaceAll("{{artifact}}", artifactPath)) : build.args;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(build.command, args, {
        cwd: build.cwd ?? this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true
      });
      this.buildChild = child;
      child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
      child.once("error", (error) => {
        if (this.buildChild === child) this.buildChild = null;
        reject(new Error(`Could not run TypeScript compiler: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (this.buildChild === child) this.buildChild = null;
        if (code === 0) resolve();
        else {
          const diagnostics = output.join("").trim();
          reject(new Error(`TypeScript compilation failed | Code: ${code} | Signal: ${signal ?? "none"}${diagnostics ? `\n${diagnostics}` : ""}`));
        }
      });
    });
  }

  private async terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

    await signalProcessTree(child.pid, "SIGTERM").catch((error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) logger.warn(`Graceful termination: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (await this.waitForChildExit(child, timeoutMs)) return;

    logger.warn(`Process did not exit within ${timeoutMs}ms; forcing termination`);
    await signalProcessTree(child.pid, "SIGKILL").catch(() => {});
    await this.waitForChildExit(child, 1000);
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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
    if (record.closed || !record.child.pid) return;

    await signalProcessTree(record.child.pid, "SIGTERM").catch((error: unknown) => {
      if (!record.exited) logger.warn(`Graceful termination: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (await this.waitForClose(record, timeoutMs)) return;

    logger.warn(`Process did not exit within ${timeoutMs}ms; forcing termination`);
    await signalProcessTree(record.child.pid, "SIGKILL").catch(() => {});
    await this.waitForClose(record, 1000);
  }

  private async waitForClose(record: ManagedProcess, timeoutMs: number): Promise<boolean> {
    if (record.closed) return true;

    let timer: NodeJS.Timeout;
    const timedOut = await Promise.race([
      record.closePromise.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      })
    ]);
    clearTimeout(timer!);
    return !timedOut;
  }
}
