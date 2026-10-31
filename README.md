# HyperReload

Universal TypeScript-based Hot Reload and Instant Restart Engine.

## Supported Languages

- Python (.py)
- JavaScript (.js, .mjs, .cjs)
- TypeScript (.ts, .tsx)
- Ruby (.rb)
- Go (.go)

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
node dist/index.js app.py
node dist/index.js app.js
node dist/index.js app.ts
node dist/index.js app.rb
node dist/index.js main.go
```

## Custom Watch Directory

```bash
node dist/index.js app.py ./src
```

## Development

```bash
npm run dev -- app.py
```

## Configuration

Edit hyperreload.config.json.

- debounceMs: Restart delay in milliseconds.
- ignore: Files and directories excluded from watching.

## Stop

Press CTRL+C.

## Build

```bash
npm run build
```
