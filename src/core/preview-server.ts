import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

export class IPreviewServer {
  private server: Server | null = null;
  private readonly clients = new Set<ServerResponse>();

  constructor(
    private readonly root: string,
    private readonly entryFile: string,
    private readonly port: number
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request.url || "/", response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "0.0.0.0", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    logger.success(`HTML preview: http://localhost:${this.port}`);
  }

  reload(): void {
    for (const client of this.clients) client.write("data: reload\n\n");
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();

    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => error ? reject(error) : resolve());
    });
    this.server = null;
  }

  private async handleRequest(url: string, response: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
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

    const requestedPath = pathname === "/"
      ? path.join(this.root, this.entryFile)
      : path.resolve(this.root, `.${pathname}`);
    if (requestedPath !== this.root && !requestedPath.startsWith(`${this.root}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    try {
      if (!(await stat(requestedPath)).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }

      const contentType = contentTypes[path.extname(requestedPath).toLowerCase()] || "application/octet-stream";
      response.setHeader("Content-Type", contentType);
      if (contentType.startsWith("text/html")) {
        const html = await readFile(requestedPath, "utf8");
        const closingBody = /<\/body\s*>/i;
        const injectedHtml = closingBody.test(html)
          ? html.replace(closingBody, `${liveReloadScript}</body>`)
          : `${html}${liveReloadScript}`;
        response.end(injectedHtml);
        return;
      }

      createReadStream(requestedPath).on("error", () => {
        if (!response.headersSent) response.writeHead(500);
        response.end("Unable to read file");
      }).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }
}
