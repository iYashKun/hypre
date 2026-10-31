# `hypre`

**A universal hot reload CLI**

**Write code > Save > See changes instantly**

<p>
  <img src="https://img.shields.io/npm/v/@yashkun/hypre?color=7c3aed&label=npm" alt="npm version" />
  <img src="https://img.shields.io/badge/TypeScript-powered-3178C6?logo=typescript&logoColor=white" alt="TypeScript powered" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" />
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
-   **Multi-language runner support**
-   **Recursive file watching**
-   **Debounced change detection to reduce duplicate restarts**
-   **Simple CLI designed for local or global use**

## Supported languages

> **Python (.py), JavaScript (.js), TypeScript (.ts, .tsx), Ruby (.rb), Go (.go)**

Install the relevant language runtime separately. Hypre does not bundle
Python, Node.js, Ruby or Go.

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
```

**You can optionally pass a directory to watch:**

``` bash
hypre app.py ./src
```

**Hypre watches the specified directory recursively and restarts the
selected entry program when a supported source file changes.**

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
  "ignore": [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/__pycache__/**",
    "**/vendor/**",
    "**/coverage/**"
  ]
}
```

## Development

**Clone the repository, install dependencies and build the TypeScript
source:**

``` bash
git clone https://github.com/iYashKun/hypre.git
cd hypre
npm install
npm run build
```

**Run the CLI from the compiled output:**

``` bash
node dist/index.js app.py
```

------------------------------------------------------------------------

**Made with ❤️ by Yash**
