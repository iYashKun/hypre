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
const { loadConfig } = require("../dist/index.js");
const { defaultConfig } = require("../dist/config/default.js");
const picomatch = require("picomatch");

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

test("control startup replaces stale state even when its PID is reused", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-stale-control-test-"));
  const key = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 20);
  const stateDirectory = path.join(os.homedir(), ".hypre");
  const statePath = path.join(stateDirectory, `hypre-${key}.json`);
  const probe = net.createServer();
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const unusedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await fs.writeFile(statePath, JSON.stringify({ port: unusedPort, token: "stale-token", pid: process.pid }), { mode: 0o600 });

  const server = new ControlServer(cwd, async () => {}, emptyStatus);
  try {
    await server.start();
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.notEqual(state.token, "stale-token");
  } finally {
    await server.stop();
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

test("configured ignore patterns replace the built-in list", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-config-test-"));
  try {
    await fs.writeFile(path.join(cwd, "hypre.config.json"), JSON.stringify({ ignore: ["custom/**"] }));
    assert.deepEqual(loadConfig(cwd).ignore, ["custom/**"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("default ignores .NET outputs without ignoring Rust src/bin sources", () => {
  const isIgnored = (file) => defaultConfig.ignore.some((pattern) => picomatch(pattern, { dot: true })(file));
  assert.equal(isIgnored("apps/api/bin/Debug/net8.0/api.dll"), true);
  assert.equal(isIgnored("apps/api/bin/Release/net8.0/api.dll"), true);
  assert.equal(isIgnored("apps/worker/src/bin/main.rs"), false);
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

test("runner exit is detected when a descendant keeps stdio open", async () => {
  const manager = new ProcessManager(process.cwd());
  const source = 'const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); process.exit(1);';
  const startedAt = Date.now();
  await assert.rejects(manager.start({
    command: process.execPath,
    args: ["-e", source]
  }, { startupGraceMs: 5000, shutdownTimeoutMs: 1000 }));
  assert.ok(Date.now() - startedAt < 1500);
  assert.equal(manager.getStatus().active, false);
  await manager.stop(1000);
});
