### Added

- Add C (`.c`), C++ (`.cc`, `.cpp`, `.cxx`, `.c++`) and C# (`.cs`) runners. C and C++ compile to isolated temporary executables; C# runs through the nearest unambiguous `.csproj`.
- Add optional workspace `readyUrl` and `readinessTimeoutMs` settings so dependent services can wait for HTTP readiness. Responses below status 500 count as ready.
- Add `npm checks` with regression coverage for preview and proxy security, control server shutdown/authentication, readiness cancellation, TypeScript fallback and C/C++/C# execution.

### Fixed

- Restrict HTML preview access to loopback, reject foreign `Host` headers and dotfiles, block symlink escapes and serve only allowlisted file types.
- Make ignore globs work with Chokidar 6 and merge configured patterns with built-in exclusions, including `coverage`, `bin` and `obj`.
- Find TypeScript project configs above the watch directory and provide Node types in the no-config fallback. Watch the root `package.json` in `hypre run` mode.
- Keep the watcher alive after an initial launch failure, queue changes until startup completes, cancel readiness probes when candidates exit and clear startup/drain timers.
- Make shutdown attempt all cleanup steps, terminate compiler and child process trees, close idle control/proxy sockets and continue restarting remaining workspace services after a restart failure.
- Harden proxy readiness and forwarding: accept 404 readiness responses, probe IPv4/IPv6 loopback, propagate aborted requests, filter hop-by-hop headers, preserve forwarded IP chains and drain old HTTP requests with a timeout.
- Validate configuration types, reject unsupported service `shell` settings, serialize overlapping watch commands and send error logs to stderr.
- Protect the control service with a private per-user state directory, mode-0600 state files, duplicate-session checks, a challenge-response handshake, one request per connection and bounded connection lifetime.
- Pin the Go launcher to the package version, forward interrupt/termination signals and return a valid failure status when its child is signaled.
- Route vulnerability reports through private GitHub Security Advisories.

### CI and Dependencies

- Verify the release tag against both `package.json` and the Go launcher version.
- Add `@types/node` as a runtime dependency for TypeScript fallback checks and remove the `tree-kill` dependency in favor of process group signaling and Windows `taskkill`.

### Verification

- `npm ci` and `npm checks` pass; all 11 tests pass.
