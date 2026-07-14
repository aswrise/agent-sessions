# Verify Bun, Vue, and cross-platform distribution constraints

Research completed 2026-07-14 for [Verify Bun, Vue, and cross-platform distribution constraints](https://github.com/aswrise/agent-sessions/issues/3).

## Decision

The fixed migration stack is viable. Use Bun for the backend, tests, scripts, package management, and standalone compilation; use Vue 3 + TypeScript with Vite for SFC compilation/HMR; use `vue-tsc --noEmit`, Vitest, and Vue Test Utils for frontend checks. Treat the six release artifacts as a supported build matrix, not as proof of runtime parity: each artifact still needs smoke tests on its target OS/architecture.

The six Bun targets are:

| OS | x64 | arm64 |
| --- | --- | --- |
| Linux | `bun-linux-x64` | `bun-linux-arm64` |
| macOS | `bun-darwin-x64` | `bun-darwin-arm64` |
| Windows | `bun-windows-x64` | `bun-windows-arm64` |

Bun documents all six targets as supported for `bun build --compile`; Linux also has glibc and musl variants. Linux x64 and Windows x64 have baseline/modern variants. The default x64 builds use AVX2-oriented SIMD; choose the baseline variant if older x64 CPUs must run the artifact. The release contract must state the CPU floor instead of silently treating standard x64 as universal.

## Confirmed constraints

### Standalone compilation and assets

- `bun build --compile` bundles imported files/packages and the Bun runtime, and accepts a cross-platform `--target`.
- `bun:sqlite` is supported in compiled executables. The database is resolved relative to the process working directory by default. Therefore the migration must keep the user data file outside the executable and resolve its location explicitly; it must not assume that a bundled executable's directory is writable or is the current directory.
- A relative path to a file not included in the executable is loaded from disk relative to the process current working directory. Files reached through dynamic/unanalysable paths are therefore packaging hazards.
- Bun's full-stack HTML build can produce a manifest for `Bun.serve`, but Vite is the specified frontend build tool. The simplest boundary is: Vite emits `dist` assets, and the Bun server serves that directory (or an explicitly generated manifest). Do not assume that putting an HTML import in the compiled backend automatically includes the Vite output.
- Vite imports referenced assets and hashes them in production. Assets in `public/` are copied as-is and must be referenced by root-absolute URLs. Pick one convention and test that the packaged server serves `index.html`, hashed assets, and any exact-name public files.

### Vue and test toolchain

- Vue's official TypeScript guidance says Vite transforms TypeScript but does not type-check it; `vue-tsc` is the command-line checker for Vue SFCs. Keep type checking as a separate CI step.
- Vue Test Utils v2 targets Vue 3 and recommends Vitest. Vitest reads the Vite config by default and supports the Vue project example, so no second frontend transform stack is needed.
- Frontend tests should assert observable DOM/events/API effects, not component implementation details. Backend parity remains covered by the existing Python characterization tests until the TypeScript implementation exists.

### Processes and external dependency

- Bun's `Bun.spawn` accepts an argument array and a `cwd`; use those instead of constructing shell command strings. `detached: true` creates a separate process group on POSIX and uses Windows detached-process support on Windows, so the semantics are available on both families but signal/termination behavior still needs target smoke tests.
- Bun documents `windowsHide` and Windows argument handling separately. Resume commands are a user-facing shell contract and remain the subject of [Choose cross-platform resume command semantics](https://github.com/aswrise/agent-sessions/issues/9); this ticket does not settle shell quoting.
- `rg` remains the only external runtime dependency. A release artifact must either verify that `rg` is on `PATH` or fail with a clear installation message. Bundling or replacing it would violate the map's scope.
- The current Python launcher uses `explorer.exe` for WSL, `open` for macOS, and `xdg-open` otherwise. The compiled launcher must preserve this observable behavior or explicitly document the replacement; WSL/native-Windows detection cannot be inferred solely from `process.platform`.

### GitHub Actions distribution

- GitHub Actions supports a matrix job, and artifacts can be named from matrix values and uploaded with `actions/upload-artifact@v4`.
- A tag-triggered workflow can therefore build the six target strings from a matrix and upload one named artifact per target. Ordinary commits should run verification only, as required by the map.
- Cross-compilation support in Bun proves target generation is available; it does not prove that the produced binary works on every target. Release CI needs at least executable-version/help and dashboard HTTP smoke checks on the target OSes, or a documented limitation where a runner cannot execute an architecture natively.

## Assumptions that remain implementation gates

These are not claims established by the official documentation and must be tested during implementation:

1. A Bun version pinned by the migration can cross-compile all six targets without a target-specific linker/runtime defect.
2. The compiled backend can serve the Vite `dist` tree from a location that works when launched from an arbitrary cwd, including a path containing spaces on Windows.
3. `bun:sqlite` behaves compatibly with the current read-only Codex database access and with the existing `stars.json` persistence under Windows file locking.
4. `rg` executable discovery and error reporting work for native Windows, WSL, macOS, and Linux installations.
5. Detached dashboard lifecycle, `--stop`, browser opening, Ctrl-C, and child cleanup have equivalent enough behavior on Windows and POSIX.
6. The six artifacts' smoke tests can run on the available GitHub-hosted runners; if ARM64 execution is unavailable, use cross-build plus native/self-hosted validation and record the gap.

## Required implementation checks

- Pin Bun and lock dependencies; run `bun install --frozen-lockfile`, `vue-tsc --noEmit`, backend tests, frontend tests, and Vite production build.
- For every target, compile with the exact target string, verify the artifact exists, and run a smoke command where the runner supports it.
- Smoke-test from a temporary cwd and a Windows path with spaces; verify static assets, SQLite path selection, `rg` lookup, dashboard start/stop, and detached process cleanup.
- Keep Python as the entrypoint until these checks and the existing parity suite demonstrate the documented behavior; then remove the Python implementation in the cutover change.

## Official sources

- [Bun single-file executables](https://bun.sh/docs/bundler/executables) — compile targets, CPU variants, SQLite, asset inclusion, and unsupported compile flags.
- [Bun file types](https://bun.sh/docs/runtime/file-types) — HTML/full-stack builds and file-loader behavior.
- [Bun `spawn` API](https://bun.sh/reference/bun/spawn) — cwd, detached processes, Windows behavior, and argument handling.
- [Vue TypeScript overview](https://vuejs.org/guide/typescript/overview.html) — Vite transpilation and `vue-tsc`.
- [Vue Test Utils installation](https://test-utils.vuejs.org/installation/) — Vue Test Utils v2 and Vitest recommendation.
- [Vite static asset handling](https://vite.dev/guide/assets.html) — imports, `public/`, and production asset URLs.
- [Vite backend integration](https://vite.dev/guide/backend-integration.html) — manifest and backend/static-asset boundary.
- [Vitest getting started](https://vitest.dev/guide/) — Vite config reuse and Vue example.
- [GitHub Actions job matrices](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs) and [workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) — matrix builds and artifact upload.
