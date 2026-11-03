import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

function stripHopByHopHeaders(headers: http.OutgoingHttpHeaders): void {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade"
  ]);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const header of connection.split(",")) blocked.add(header.trim().toLowerCase());
  }
  for (const header of blocked) delete headers[header];
}

export class LiveProxyServer {
  private server: http.Server | null = null;
  private upstreamPort: number | null = null;
  private upstreamHost = "127.0.0.1";
  private readonly candidateHosts = new Map<number, string>();
  private readonly sockets = new Set<net.Socket>();
  private readonly inFlight = new Map<number, number>();
  private readonly drainWaiters = new Map<number, () => void>();

  constructor(
    private readonly port: number,
    private readonly readinessTimeoutMs: number,
    private readonly healthPath: string = "/",
    private readonly drainTimeoutMs: number = 5000
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.proxyRequest(request, response));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
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
    this.candidateHosts.clear();
    if (!server) return;
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closed;
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
      const host = await this.probe(port);
      if (host) {
        this.candidateHosts.set(port, host);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Readiness check timed out after ${this.readinessTimeoutMs}ms at ${this.healthPath} on port ${port}`);
  }

  async promote(port: number): Promise<void> {
    const previousPort = this.upstreamPort;
    this.upstreamPort = port;
    this.upstreamHost = this.candidateHosts.get(port) ?? "127.0.0.1";
    this.candidateHosts.delete(port);
    if (previousPort !== null && previousPort !== port) await this.waitForRequests(previousPort);
  }

  private proxyRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const port = this.upstreamPort;
    if (!port) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Application is starting");
      return;
    }

    this.inFlight.set(port, (this.inFlight.get(port) ?? 0) + 1);
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      this.completeRequest(port);
    };
    const upstream = http.request({
      hostname: this.upstreamHost,
      port,
      method: request.method,
      path: request.url,
      headers: this.forwardHeaders(request)
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, stripResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });

    upstream.on("error", () => {
      complete();
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("Application is unavailable");
      }
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableEnded) {
        upstream.destroy();
        complete();
      }
    });
    response.once("finish", complete);
    request.pipe(upstream);
  }

  private completeRequest(port: number): void {
    const remaining = Math.max(0, (this.inFlight.get(port) ?? 0) - 1);
    if (remaining > 0) {
      this.inFlight.set(port, remaining);
      return;
    }
    this.inFlight.delete(port);
    this.drainWaiters.get(port)?.();
  }

  private async waitForRequests(port: number): Promise<void> {
    if (!this.inFlight.has(port)) return;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.set(port, resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, this.drainTimeoutMs))
    ]);
    this.drainWaiters.delete(port);
  }

  private forwardHeaders(request: http.IncomingMessage): http.OutgoingHttpHeaders {
    const headers = { ...request.headers } as http.OutgoingHttpHeaders;
    const priorForwardedFor = headers["x-forwarded-for"];
    stripHopByHopHeaders(headers);
    headers["x-forwarded-for"] = [priorForwardedFor, request.socket.remoteAddress]
      .flatMap((value) => Array.isArray(value) ? value : value ? [value] : [])
      .join(", ");
    headers["x-forwarded-host"] = request.headers.host;
    headers["x-forwarded-proto"] = "http";
    return headers;
  }

  private proxyUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = this.upstreamPort;
    if (!port) {
      socket.destroy();
      return;
    }

    const upstream = net.connect(port, this.upstreamHost, () => {
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

  private async probe(port: number): Promise<string | null> {
    const hosts = ["127.0.0.1", "::1"];
    const results = await Promise.all(hosts.map((hostname) => new Promise<string | null>((resolve) => {
      const request = http.get({ hostname, port, path: this.healthPath }, (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500 ? hostname : null);
      });
      request.setTimeout(500, () => request.destroy());
      request.on("error", () => resolve(null));
    })));
    return results.find((host) => host !== null) ?? null;
  }
}

function stripResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const outgoing = { ...headers } as http.OutgoingHttpHeaders;
  stripHopByHopHeaders(outgoing);
  return outgoing;
}
