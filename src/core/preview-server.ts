import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import http, { type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { logger } from "../utils/logger";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

const liveReloadScript = `<script>(()=>{const events=new EventSource('/__hypre_reload');events.onmessage=()=>location.reload()})()</script>`;

export class PreviewServer {
  private server: Server | null = null;
  private resolvedRoot: string | null = null;
  private readonly clients = new Set<ServerResponse>();

  constructor(
    private readonly root: string,
    private readonly entryFile: string,
    private readonly port: number
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.resolvedRoot = await realpath(this.root);
    for (let port = this.port; port <= 65535; port += 1) {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request.url || "/", response);
      });

      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        logger.success(`HTML preview: http://localhost:${port}`);
        return;
      } catch (error) {
        this.server = null;
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }

    throw new Error(`No available preview port from ${this.port} through 65535`);
  }

  reload(): void {
    for (const client of this.clients) client.write("data: reload\n\n");
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.resolvedRoot = null;

    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => error ? reject(error) : resolve());
    });
    this.server = null;
  }

  private async handleRequest(url: string, response: ServerResponse): Promise<void> {
    const host = response.req.headers.host;
    try {
      const hostname = new URL(`http://${host}`).hostname.toLowerCase();
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }

    if (pathname.split("/").some((part) => part.startsWith("."))) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    if (pathname === "/__hypre_reload") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      response.write(": connected\n\n");
      this.clients.add(response);
      response.on("close", () => this.clients.delete(response));
      return;
    }

    const root = this.resolvedRoot;
    if (!root) {
      response.writeHead(503).end("Preview server is unavailable");
      return;
    }

    const requestedPath = pathname === "/"
      ? path.join(root, this.entryFile)
      : path.resolve(root, `.${pathname}`);
    const relativePath = path.relative(root, requestedPath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    try {
      const resolvedPath = await realpath(requestedPath);
      const relativeResolvedPath = path.relative(root, resolvedPath);
      if (relativeResolvedPath === ".." || relativeResolvedPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeResolvedPath)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      if (!(await stat(resolvedPath)).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      const extension = path.extname(resolvedPath).toLowerCase();
      const contentType = contentTypes[extension];
      if (!contentType) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      response.setHeader("Content-Type", contentType);
      if (contentType.startsWith("text/html")) {
        const html = await readFile(resolvedPath, "utf8");
        const closingBody = /<\/body\s*>/i;
        const injectedHtml = closingBody.test(html)
          ? html.replace(closingBody, `${liveReloadScript}</body>`)
          : `${html}${liveReloadScript}`;
        response.end(injectedHtml);
        return;
      }

      createReadStream(resolvedPath).on("error", () => {
        if (!response.headersSent) response.writeHead(500);
        response.end("Unable to read file");
      }).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }
}
