import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { EngineStatus } from "../types";
import { logger } from "../utils/logger";

interface ControlState {
  port: number;
  token: string;
  pid: number;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ControlServer {
  private readonly statePath: string;
  private readonly token = randomBytes(24).toString("hex");
  private server: net.Server | null = null;

  constructor(
    private readonly cwd: string,
    private readonly restart: (service?: string) => Promise<void>,
    private readonly getStatus: () => EngineStatus
  ) {
    const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
    this.statePath = path.join(os.tmpdir(), `hypre-${key}.json`);
  }

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 2048) {
          socket.end(JSON.stringify({ ok: false, error: "Invalid request" }) + "\n");
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        void this.handleRequest(socket, line);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Hypre control server");
    await this.writeStateFile({ port: address.port, token: this.token, pid: process.pid });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }

    try {
      const state = JSON.parse(await fs.readFile(this.statePath, "utf8")) as ControlState;
      if (state.token === this.token) await fs.unlink(this.statePath);
    } catch {
      // The control file may already have been removed.
    }
  }

  private async handleRequest(socket: net.Socket, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as { token?: string; command?: string; service?: string };
      if (request.token !== this.token || !["restart", "status"].includes(request.command ?? "")) {
        socket.end(JSON.stringify({ ok: false, error: "Unauthorized or unsupported command" }) + "\n");
        return;
      }
      if (request.command === "status") {
        socket.end(JSON.stringify({ ok: true, status: this.getStatus() }) + "\n");
        return;
      }
      if (request.service !== undefined && typeof request.service !== "string") {
        socket.end(JSON.stringify({ ok: false, error: "Invalid service name" }) + "\n");
        return;
      }
      socket.end(JSON.stringify({ ok: true }) + "\n");
      void this.restart(request.service).catch((error: unknown) => {
        logger.error(error instanceof Error ? error.stack || error.message : String(error));
      });
    } catch (error) {
      socket.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }) + "\n");
    }
  }

  private async writeStateFile(state: ControlState): Promise<void> {
    const create = async (): Promise<void> => {
      const file = await fs.open(this.statePath, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
      } finally {
        await file.close();
      }
    };

    try {
      await create();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const stats = await fs.lstat(this.statePath);
    if (!stats.isFile() || (process.getuid && stats.uid !== process.getuid())) {
      throw new Error("Hypre control state path exists and is not a private regular file");
    }

    let existing: Partial<ControlState> = {};
    try {
      existing = JSON.parse(await fs.readFile(this.statePath, "utf8")) as Partial<ControlState>;
    } catch {
      // An unreadable state file is stale if its owner process is not running.
    }
    if (typeof existing.pid === "number" && isProcessRunning(existing.pid)) {
      throw new Error("A Hypre session is already running for this project");
    }

    await fs.unlink(this.statePath);
    try {
      await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("A Hypre session started concurrently for this project");
      }
      throw error;
    }
  }
}

interface ControlResponse {
  ok?: boolean;
  error?: string;
  status?: EngineStatus;
}

async function requestControl(cwd: string, command: "restart" | "status", service?: string): Promise<ControlResponse> {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  const statePath = path.join(os.tmpdir(), `hypre-${key}.json`);
  let state: ControlState;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8")) as ControlState;
  } catch {
    throw new Error("No running Hypre session found in this project");
  }
  if (typeof state.token !== "string" || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !isProcessRunning(state.pid)) {
    throw new Error("No running Hypre session found in this project");
  }

  return await new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection({ port: state.port, host: "127.0.0.1" });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for Hypre restart"));
    }, 5000);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: state.token, command, ...(service ? { service } : {}) })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const result = JSON.parse(response.slice(0, newline)) as ControlResponse;
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to Hypre: ${error.message}`));
    });
  });
}

export async function requestRestart(cwd: string, service?: string): Promise<void> {
  const result = await requestControl(cwd, "restart", service);
  if (!result.ok) throw new Error(result.error || "Hypre restart failed");
}

export async function requestStatus(cwd: string): Promise<EngineStatus> {
  const result = await requestControl(cwd, "status");
  if (!result.ok || !result.status) throw new Error(result.error || "Could not read Hypre status");
  return result.status;
}
