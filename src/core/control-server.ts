import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

interface ControlState {
  port: number;
  token: string;
}

export class ControlServer {
  private readonly statePath: string;
  private readonly token = randomBytes(24).toString("hex");
  private server: net.Server | null = null;

  constructor(private readonly cwd: string, private readonly restart: () => Promise<void>) {
    const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
    this.statePath = path.join(os.tmpdir(), `hypre-${key}.json`);
  }

  async start(): Promise<void> {
    this.server = net.createServer((socket) => {
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
    await fs.writeFile(this.statePath, JSON.stringify({ port: address.port, token: this.token }), { mode: 0o600 });
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
      const request = JSON.parse(line) as { token?: string; command?: string };
      if (request.token !== this.token || request.command !== "restart") {
        socket.end(JSON.stringify({ ok: false, error: "Unauthorized or unsupported command" }) + "\n");
        return;
      }
      await this.restart();
      socket.end(JSON.stringify({ ok: true }) + "\n");
    } catch (error) {
      socket.end(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }) + "\n");
    }
  }
}

export async function requestRestart(cwd: string): Promise<void> {
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  const statePath = path.join(os.tmpdir(), `hypre-${key}.json`);
  let state: ControlState;
  try {
    state = JSON.parse(await fs.readFile(statePath, "utf8")) as ControlState;
  } catch {
    throw new Error("No running Hypre session found in this project");
  }

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ port: state.port, host: "127.0.0.1" });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for Hypre restart"));
    }, 5000);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: state.token, command: "restart" })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const result = JSON.parse(response.slice(0, newline)) as { ok?: boolean; error?: string };
        if (result.ok) resolve();
        else reject(new Error(result.error || "Hypre restart failed"));
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