const assert = require("node:assert/strict");
const { createHash, createHmac } = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { ControlServer } = require("../dist/core/control-server.js");
const { ProcessManager } = require("../dist/core/process-manager.js");
const { runCleanupSteps } = require("../dist/core/shutdown.js");
const { waitForHttpReady } = require("../dist/utils/readiness.js");

function emptyStatus() {
  return {
    active: false,
    pid: null,
    uptimeMs: null,
    lastSuccessfulRestartAt: null,
    restartLoopPaused: false,
    restartFailures: 0
  };
}

test("control server handles one request and closes idle clients on stop", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-control-test-"));
  let restarts = 0;
  const server = new ControlServer(cwd, async () => { restarts += 1; }, emptyStatus);
  let idleClient;
  try {
    await server.start();
    const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
    const statePath = path.join(os.homedir(), ".hypre", `hypre-${key}.json`);
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal((await fs.stat(path.dirname(statePath)).then((stats) => stats.mode & 0o777)), 0o700);
    const client = net.createConnection({ port: state.port, host: "127.0.0.1" });
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    let responseBuffer = "";
    const responseLines = [];
    const responseWaiters = [];
    const readLine = () => responseLines.length
      ? Promise.resolve(responseLines.shift())
      : new Promise((resolve) => responseWaiters.push(resolve));
    client.on("data", (chunk) => {
      responseBuffer += chunk.toString();
      let newline = responseBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = responseBuffer.slice(0, newline);
        responseBuffer = responseBuffer.slice(newline + 1);
        newline = responseBuffer.indexOf("\n");
        const waiter = responseWaiters.shift();
        if (waiter) waiter(line);
        else responseLines.push(line);
      }
    });
    const challenge = Buffer.alloc(24, 7).toString("hex");
    client.write(`${JSON.stringify({ challenge })}\n`);
    const handshake = JSON.parse(await readLine());
    assert.equal(handshake.proof, createHmac("sha256", state.token).update(challenge).digest("hex"));

    const request = `${JSON.stringify({ token: state.token, command: "restart" })}\n`;
    client.write(`${request}${request}`);
    assert.deepEqual(JSON.parse(await readLine()), { ok: true });
    assert.equal(restarts, 1);
    client.destroy();

    idleClient = net.createConnection({ port: state.port, host: "127.0.0.1" });
    await new Promise((resolve, reject) => {
      idleClient.once("connect", resolve);
      idleClient.once("error", reject);
    });
    let timer;
    await Promise.race([
      server.stop(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Control server stop hung")), 1000); })
    ]);
    clearTimeout(timer);
  } finally {
    idleClient?.destroy();
    await server.stop().catch(() => {});
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("cleanup attempts every step after a failure", async () => {
  let secondStepRan = false;
  await assert.rejects(runCleanupSteps([
    async () => { throw new Error("first step failed"); },
    async () => { secondStepRan = true; }
  ]), AggregateError);
  assert.equal(secondStepRan, true);
});

test("workspace readiness accepts an API root that returns 404", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await waitForHttpReady(`http://127.0.0.1:${address.port}/`, 1000);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("candidate exit aborts its readiness check", async () => {
  const manager = new ProcessManager(process.cwd());
  let aborted = false;
  const startedAt = Date.now();
  await assert.rejects(manager.start({
    command: process.execPath,
    args: ["-e", "process.exit(1)"]
  }, {
    startupGraceMs: 60000,
    shutdownTimeoutMs: 1000,
    waitUntilReady: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    })
  }));
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1000);
  await manager.stop(1000);
});

test("ProcessManager stop terminates a running child process", async () => {
  const manager = new ProcessManager(process.cwd());
  await manager.start({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"]
  }, { startupGraceMs: 25, shutdownTimeoutMs: 1000 });
  assert.ok(manager.getStatus().pid);
  await manager.stop(1000);
  assert.equal(manager.getStatus().active, false);
});
