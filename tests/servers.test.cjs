const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { LiveProxyServer } = require("../dist/core/live-proxy.js");
const { PreviewServer } = require("../dist/core/preview-server.js");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function getResponse(port, pathname, host = `127.0.0.1:${port}`, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: pathname,
      headers: { ...headers, host }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString()
      }));
    });
    request.once("error", reject);
  });
}

test("preview serves local assets but rejects dotfiles, symlinks, and foreign hosts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-preview-test-"));
  const outside = path.join(os.tmpdir(), `hypre-secret-${process.pid}.json`);
  const port = await reservePort();
  const preview = new PreviewServer(root, "index.html", port);
  try {
    await fs.writeFile(path.join(root, "index.html"), "<html><body>ok</body></html>");
    await fs.writeFile(path.join(root, ".env"), "SECRET=value");
    await fs.writeFile(outside, '{"secret":"value"}');
    await fs.symlink(outside, path.join(root, "escape.json"));
    await preview.start();

    assert.equal((await getResponse(port, "/", `localhost:${port}`)).status, 200);
    assert.equal((await getResponse(port, "/.env")).status, 403);
    assert.equal((await getResponse(port, "/escape.json")).status, 403);
    assert.equal((await getResponse(port, "/", "attacker.example")).status, 403);
  } finally {
    await preview.stop();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test("live proxy considers a 404 root response ready and forwards safely", async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(404, { connection: "close" });
    response.end(JSON.stringify({ forwardedFor: request.headers["x-forwarded-for"], secret: request.headers["x-private"] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = new LiveProxyServer(await reservePort(), 1500, 1000);
  try {
    await proxy.start();
    await proxy.waitUntilReady(upstreamPort);
    await proxy.promote(upstreamPort);

    const response = await getResponse(proxy.port, "/", undefined, {
      "x-forwarded-for": "client-value",
      connection: "keep-alive, x-private",
      "x-private": "must-not-forward"
    });
    assert.equal(response.status, 404);
    const body = JSON.parse(response.body);
    assert.equal(body.forwardedFor, "client-value, 127.0.0.1");
    assert.equal(body.secret, undefined);
  } finally {
    await proxy.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
