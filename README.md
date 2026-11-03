# `hypre`

**A universal hot reload CLI**

**Write code > Save > See changes instantly**

<p>
  <img src="https://img.shields.io/npm/v/@yashkun/hypre?color=7c3aed&label=npm" />
  <img src="https://img.shields.io/badge/TypeScript-powered-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
  <img src="https://img.shields.io/github/created-at/iYashKun/hypre?label=created%20at&labelColor=black&color=7C3AED" />
  <img src="https://img.shields.io/github/last-commit/iYashKun/hypre?style=flat&logo=git&color=F05032&logoColor=white" />
  <img src="https://img.shields.io/npm/d18m/%40yashkun%2Fhypre?label=Downloads&colour=blue" />
</p>

------------------------------------------------------------------------

## What is hypre?

**Hypre** is a lightweight multi-language development utility that
watches your project files and automatically restarts your running
program whenever a supported source file changes.

> Instead of stopping and rerunning your application manually, start hypre
once and keep coding.

## Features

-   **Automatic restart when supported source files change**
-   **Staged restarts that keep the previous process running when a replacement fails**
-   **TypeScript type checking, crash recovery, grouped errors and restart loop protection**
-   **Multi-language runner support**
-   **Recursive file watching**
-   **Debounced change detection to reduce duplicate restarts**
-   **Static HTML preview with automatic browser reload, starting at port 8888 and incrementing if busy**
-   **Simple CLI designed for local or global use**

## Supported languages

> **HTML (.html), Python (.py), JavaScript (.js), TypeScript (.ts, .tsx), Ruby (.rb), Go (.go), Rust (.rs), PHP (.php)**

Install the relevant language runtime separately. Hypre does not bundle
Python, Node.js, Ruby, Go, Rust or PHP.

## Installation

**Install the CLI globally to use it from any project:**

``` bash
npm install -g @yashkun/hypre
```

**Install Hypre in an individual project: (Local development dependency)**

``` bash
npm install --save-dev @yashkun/hypre
```

**Then add a script to your project's `package.json`:**

``` json
{
  "scripts": {
    "dev": "hypre app.ts"
  }
}
```

**Run it with:**

``` bash
npm run dev
```

**Run without a global install**

``` bash
npx @yashkun/hypre app.py
```

## Usage

**Pass the entry file as the first argument:**

``` bash
hypre app.py
hypre app.ts
hypre main.go
hypre src/main.rs
hypre index.php
```

**Run an npm script, restart the active Hypre session, generate configuration or print the version:**

``` bash
hypre run dev
hypre restart
hypre init
hypre --v
```

**`hypre run dev` runs `npm run dev` and watches source files plus
`package.json`. `hypre restart` requests a restart from the Hypre session
running in the current project. `hypre init` creates `hypre.config.json` and
never overwrites an existing file.**

**By default Hypre watches the current project directory recursively. You can
optionally choose a different directory:**

``` bash
hypre app.py ./src
```

**Hypre watches the selected directory recursively and restarts the entry
when supported source files change. This includes local imported modules
within that directory; dependencies under `node_modules` are ignored. For an
HTML entry, it serves the entry directory starting at `http://localhost:8888`
and reloads the browser when HTML or static assets change. If the configured
preview port is busy, Hypre tries the next port (for example, `8889`, then
`8890`).**

For HTTP servers, enable `proxy` in `hypre.config.json` and have the app bind
to the `PORT` environment variable. Hypre starts each replacement on a
separate local port, waits for the configured health path to return a
successful response, switches proxy traffic and then gracefully stops the
old process. The proxy listens on `proxy.port`. Without proxy mode, a server
that binds a fixed port may need a brief handoff during restart.

### Example output

``` text
Entry       : /workspace/app.py
Watch       : /workspace
Status      : ACTIVE

[INFO] Watching directory: /workspace
[SUCCESS] Process started

[CHANGE] change: /workspace/app.py
[WARN] Restarting application...
[INFO] Process exited
[SUCCESS] Process started
```

## Configuration

**Create `hypre.config.json` in your project root:**

``` json
{
  "debounceMs": 150,
  "previewPort": 8888,
  "startupGraceMs": 1000,
  "shutdownTimeoutMs": 5000,
  "restartOnCrash": true,
  "restartLoopLimit": 5,
  "restartLoopWindowMs": 30000,
  "proxy": {
    "enabled": false,
    "port": 3000,
    "readinessTimeoutMs": 10000
  },
  "ignore": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/target/**",
    "**/.next/**",
    "**/__pycache__/**",
    "**/vendor/**",
    "**/coverage/**"
  ]
}
```

**Hypre keeps the current process until its replacement passes startup checks.
`restartLoopLimit` and `restartLoopWindowMs` control when repeated failures
pause automatic recovery. Use `hypre -h` or `hypre --help` for the command
list.**
> Proxy mode expects an HTTP application that honors `PORT`; it checks `/` for
an HTTP 2xx/3xx response before switching traffic.

## Development

**Clone the repository, install dependencies and build the TypeScript
source:**

``` bash
git clone https://github.com/iYashKun/hypre.git
cd hypre
npm install
npm run build
npm link
```

**Run the CLI from the compiled output:**

``` bash
hypre app.py
```

------------------------------------------------------------------------

## Contributing

**Contributions are welcome! Feel free to open an issue or submit a pull request if you have a way to improve this project.**

**Make sure your request is meaningful and you have tested the app locally before submitting a pull request.**

## Support

**💙 If you like this project give it a ⭐ and share it with friends!**
