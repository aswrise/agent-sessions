# 0001: Bun, Vue, and SessionCatalog

Status: accepted

## Decision

Use Bun 1.3.14 for the CLI, HTTP server, tests, build scripts, and standalone
compilation. Use Vue 3 with Vite for the dashboard. Keep one deep
`SessionCatalog` module with three internal Claude/Codex/pi adapters; CLI, HTTP,
and Vue do not read tool storage formats directly.

Vite assets are inlined before `bun build --compile`, producing one executable.
Lifecycle state uses a validated pid, port, and random nonce. A process is only
reused or stopped after its GET health response echoes that nonce.

## Consequences

- `rg` remains the sole external runtime dependency.
- `stars.json` stays backward compatible; Session and SQLite inputs are not
  converted during cutover or rollback.
- Release CI cross-builds six targets. x64 host artifacts run smoke tests;
  ARM64 artifacts carry an explicit unexecuted verification record until native
  runners are available.
