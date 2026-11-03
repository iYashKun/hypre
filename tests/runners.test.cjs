const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { ProcessManager } = require("../dist/core/process-manager.js");
const { getRunner } = require("../dist/runners/index.js");
const { typescriptRunner } = require("../dist/runners/typescript.js");

const hasCc = spawnSync(process.env.CC || "cc", ["--version"], { stdio: "ignore" }).status === 0;
const hasCxx = spawnSync(process.env.CXX || "c++", ["--version"], { stdio: "ignore" }).status === 0;
const hasDotnet = spawnSync("dotnet", ["--version"], { stdio: "ignore" }).status === 0;

async function runRunner(file, cwd, startupGraceMs = 10000, env) {
  const output = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    output.push(String(chunk));
    return write.call(this, chunk, ...args);
  };

  const manager = new ProcessManager(cwd);
  try {
    const runner = getRunner(file, cwd);
    runner.env = { ...runner.env, ...env };
    await manager.start(runner, { startupGraceMs, shutdownTimeoutMs: 1000 });
    assert.ok(manager.getStatus().lastSuccessfulRestartAt);
  } finally {
    await manager.stop(1000);
    process.stdout.write = write;
  }
  return output.join("");
}

test("C and C++ entries compile to isolated temporary artifacts and run", { skip: !hasCc || !hasCxx }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-native-test-"));
  try {
    const cFile = path.join(directory, "hello.c");
    const cppFile = path.join(directory, "hello.cpp");
    await fs.writeFile(cFile, '#include <stdio.h>\nint main(void) { puts("c-ok"); return 0; }\n');
    await fs.writeFile(cppFile, '#include <iostream>\nint main() { std::cout << "cpp-ok\\n"; }\n');

    assert.match(await runRunner(cFile, directory), /c-ok/);
    assert.match(await runRunner(cppFile, directory), /cpp-ok/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("C# entries run through their nearest project", { skip: !hasDotnet }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-csharp-test-"));
  try {
    const project = path.join(directory, "Smoke.csproj");
    const source = path.join(directory, "Program.cs");
    const version = spawnSync("dotnet", ["--version"], { encoding: "utf8" }).stdout.trim();
    const major = Number.parseInt(version.split(".")[0], 10);
    await fs.writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${major}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>`);
    await fs.writeFile(source, 'Console.WriteLine("cs-ok");\n');

    assert.match(await runRunner(source, directory, 60000, {
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_NOLOGO: "1"
    }), /cs-ok/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript runner finds a project config above the watch directory", () => {
  const root = path.resolve(__dirname, "..");
  const runner = typescriptRunner(path.join(root, "src/index.ts"), path.join(root, "src"));
  assert.ok(runner.build.args.includes("--project"));
  assert.ok(runner.build.args.includes(path.join(root, "tsconfig.json")));
});

test("TypeScript fallback includes Node types without a project config", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hypre-typescript-test-"));
  try {
    const source = path.join(directory, "main.ts");
    await fs.writeFile(source, 'console.log(process.version);\n');
    assert.match(await runRunner(source, directory), /v\d+\.\d+\.\d+/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
