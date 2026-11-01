import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

export class LiveProxyServer {
  private server: http.Server | null = null;
  private upstreamPort: number | null = null;

  constructor(
    private readonly port: number,
    private readonly readinessTimeoutMs: number
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.proxyRequest(request, response));
    this.server.on("upgrade", (request, socket, head) => this.proxyUpgrade(request, socket, head));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.upstreamPort = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async reserveCandidatePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Could not allocate a port for the replacement process");
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    return address.port;
  }

  async waitUntilReady(port: number): Promise<void> {
    const deadline = Date.now() + this.readinessTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.probe(port)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Readiness check timed out after ${this.readinessTimeoutMs}ms at http://127.0.0.1:${port}/`);
  }

  promote(port: number): void {
    this.upstreamPort = port;
  }

  private proxyRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const port = this.upstreamPort;
    if (!port) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Application is starting");
      return;
    }

    const upstream = http.request({
      hostname: "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: {
        ...request.headers,
        "x-forwarded-for": request.socket.remoteAddress,
        "x-forwarded-host": request.headers.host,
        "x-forwarded-proto": "http"
      }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("Application is unavailable");
      }
    });
    request.pipe(upstream);
  }

  private proxyUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.upstreamPort;
    if (!port) {
      socket.destroy();
      return;
    }

    const upstream = net.connect(port, "127.0.0.1", () => {
      const headers = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });

    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  private probe(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 400);
      });
      request.setTimeout(500, () => request.destroy());
      request.on("error", () => resolve(false));
    });
  }
}
