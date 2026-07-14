# Bun/Vue migration verification — 2026-07-14

Mode: local, sanitized fixtures plus read-only real-data shape checks.

| Gate | Result | Evidence |
| --- | --- | --- |
| Python baseline/oracle | Pre-cutover pass | 7 legacy tests; checked-in deterministic metadata and Transcript hashes |
| SessionCatalog | Pass | Claude/Codex/pi parity, malformed records, subagent exclusion, cache, legacy/orphan marks, rename modes, SQLite readonly |
| HTTP | Pass | GET app/list/detail/nonce health; safe 400/404/500 JSON; star/note/archive/status/rename mutations |
| Vue | Pass | tabs; keyword/path/date/size/status filters; sort/pagination; clipboard/detail/popstate/preview; theme/width/keyboard preferences; success/rollback/error mutations |
| Type/build | Pass | `vue-tsc --noEmit`; Vite production build; embedded HTML has no disk-relative asset references |
| Executable | Pass on Linux x64 | arbitrary cwd with spaces, help/version, list/SQLite, missing-rg, dashboard GET/start/stop/state cleanup |
| Six targets | Built | Bun 1.3.14 generated Linux/macOS/Windows x64 and ARM64 artifacts; checksums and formats are recorded in [`artifact-manifest-2026-07-14.json`](artifact-manifest-2026-07-14.json) |
| Native target execution | Partial | Linux x64 executed locally; the manifest marks every other local target unexecuted; release CI owns macOS/Windows x64 execution |
| Real data | Pass | counts, normalized shape, id hash, and HTTP 200 only; no Transcript text logged |

ARM64 runtime verification is not implied by cross-compilation. Each release
artifact includes a `.verification.json`; ARM64 remains `executed: false` until a
native or equivalent runner is configured.
