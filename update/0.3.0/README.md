## 0.3.0

### Added

- Load project root `.env` values into launched programs and custom watch commands. Shell variables take precedence and changes to `.env` restart the program or all workspace services.
- Add `hypre status` for process and per service PID, uptime, last successful restart and restart loop state.
- Add `hypre dev` multi service workspaces with dependency ordered startup, reverse order shutdown, isolated file watches and `hypre restart <service>`.
- Add optional glob based `watchRules` actions: `ignore`, `restart`, `preview-reload` and debounced `command`. Without rules every non-ignored file change uses the default restart behavior.
- Automatically try the next preview port when the configured port is busy.

### Fixed

- Restrict preview file access to the canonical preview root to prevent symlink escapes.
- Resolve the TypeScript compiler without relying on an exported package subpath and type-check workspace services using their own `tsconfig.json`.
- Enable JSX syntax in the TypeScript fallback check when no `tsconfig.json` exists.
- Run Go packages instead of only the selected source file, so sibling package files are included.
- Select nested Cargo binary targets for Rust entries under `src/bin`.
- Terminate custom watch command processes during Hypre shutdown.

### Dependencies

- Add `dotenv` for `.env` parsing and `picomatch` for watch and service glob matching.

### Verification

- TypeScript build and CLI version checks pass.
- Production dependency audit reports no known vulnerabilities.
