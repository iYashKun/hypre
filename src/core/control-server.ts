import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

function getStatePath(cwd: string): string {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  return path.join(os.homedir(), ".hypre", `hypre-${key}.json`);
}

export class ControlServer {
  private readonly statePath: string;
  private readonly token = randomBytes(24).toString("hex");
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | null = null;

  constructor(
    private readonly cwd: string,
    private readonly restart: (service?: string) => Promise<void>,
    private readonly getStatus: () => EngineStatus
  ) {
    this.statePath = getStatePath(cwd);
  }

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = "";
      let authenticated = false;
      let handled = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        if (handled) return;
        buffer += chunk;
        if (buffer.length > 2048) {
          handled = true;
          socket.end(JSON.stringify({ ok: false, error: "Invalid request" }) + "\n");
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0 && !handled) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!authenticated) {
            let challenge: unknown;
            try {
              challenge = (JSON.parse(line) as { challenge?: unknown }).challenge;
            } catch {
              challenge = undefined;
            }
            if (typeof challenge !== "string" || !/^[a-f0-9]{48}$/.test(challenge)) {
              handled = true;
              socket.end(JSON.stringify({ ok: false, error: "Invalid handshake" }) + "\n");
              return;
            }
            const proof = createHmac("sha256", this.token).update(challenge).digest("hex");
            socket.write(JSON.stringify({ proof }) + "\n");
            authenticated = true;
            continue;
          }
          handled = true;
          void this.handleRequest(socket, line);
        }
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
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      await closed;
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
    const directory = path.dirname(this.statePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await fs.stat(directory);
    if (!directoryStats.isDirectory() || (process.getuid && directoryStats.uid !== process.getuid())) {
      throw new Error("Hypre control state directory is not private to this user");
    }
    await fs.chmod(directory, 0o700);

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
  const statePath = getStatePath(cwd);
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
    let authenticated = false;
    const challenge = randomBytes(24).toString("hex");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for Hypre control response"));
    }, 5000);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ challenge })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      let newline = response.indexOf("\n");
      while (newline >= 0) {
        const line = response.slice(0, newline);
        response = response.slice(newline + 1);
        newline = response.indexOf("\n");
        let result: ControlResponse & { proof?: string };
        try {
          result = JSON.parse(line) as ControlResponse & { proof?: string };
        } catch (error) {
          clearTimeout(timer);
          socket.destroy();
          reject(error);
          return;
        }
        if (!authenticated) {
          const expected = Buffer.from(createHmac("sha256", state.token).update(challenge).digest("hex"), "hex");
          const provided = typeof result.proof === "string" ? Buffer.from(result.proof, "hex") : Buffer.alloc(0);
          if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
            clearTimeout(timer);
            socket.destroy();
            reject(new Error("Hypre control server identity check failed"));
            return;
          }
          authenticated = true;
          socket.write(`${JSON.stringify({ token: state.token, command, ...(service ? { service } : {}) })}\n`);
          continue;
        }
        clearTimeout(timer);
        socket.end();
        resolve(result);
        return;
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
