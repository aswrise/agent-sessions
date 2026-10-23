# Agent Sessions

Find the right Claude Code, Codex, or pi conversation, understand how work moved
between Sessions, and continue from the original project with a ready-to-run
resume command.

[中文说明](README.zh-CN.md)

![Agent Sessions dashboard](docs/dashboard.png)

Agent Sessions is a local dashboard and CLI for people who work with multiple
coding agents across many repositories. It reads the history already stored by
each tool—there is no import step and no hosted account.

## What you can do

- **Search user-started Sessions** across Claude Code, Codex, and pi by tool,
  project path, date, status, size, name, note, first message, or full Transcript
  text. Internal subagent Sessions are excluded.
- **Continue where you left off** by copying a correctly quoted resume command
  that restores the original working directory and model.
- **Read the conversation** in a focused Transcript view with Markdown rendering
  and browser back/forward navigation.
- **Organize useful work** with stars, names, notes, statuses, and recoverable
  archives.
- **Trace Session Lineage** when one Session writes a Markdown or HTML Artifact
  and another Session picks it up. Hover a Session or file to focus its direct
  upstream and downstream relationships.
- **Repair missing Lineage** by adding an upstream Session manually. Manual
  relationships can be removed if added by mistake and survive refreshes,
  restarts, and derived-index rebuilds.
- **Automate from the terminal** with stable JSON output for other agents and
  scripts.

## Quick start

Agent Sessions needs [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on
your `PATH`.

1. Download the file for your OS and architecture from
   [GitHub Releases](https://github.com/aswrise/agent-sessions/releases).
2. Rename it to `sessions` (`sessions.exe` on Windows), make it executable on
   Linux/macOS, and put it on `PATH`.
3. Start the dashboard:

```bash
sessions dash
```

The browser normally opens automatically. Otherwise visit
`http://127.0.0.1:7867/`. The dashboard binds only to localhost.

```bash
sessions dash --no-open  # start without opening a browser
sessions dash --stop     # stop the resident dashboard
```

Prebuilt x64 releases use Bun's standard targets and may require AVX2. On an
older Linux or Windows x64 CPU, use the baseline source-build command below.

## Using the dashboard

### Find and resume a Session

Use **普通** search for names, notes, and first messages. Switch to **深度** and
press Enter to search readable Transcript text. Narrow the result with the tool,
project path, updated/created date, size, or status filters.

Click a live row to copy its resume command. Archive rows copy their source path
or an eligible pi fork command. Open the Transcript with the detail button and
use its labeled copy action. Press `/` to focus search and
`Esc` to leave the detail page.

![Dashboard filters](docs/dashboard-filters.png)

### Organize your work

- Click ☆ to star an important Session.
- Click a live name or any note cell to edit it. Archive names are read-only.
- Choose a status such as `todo`, `in progress`, `review`, `blocked`, or `done`.
- Archive completed work; it remains available from the **归档** tab and can be
  restored later.

### Understand Session Lineage

Open **关系图**, then click **开始分析** the first time. Agent Sessions
incrementally finds Artifact handoffs and lays the connected Sessions out from
upstream to downstream. Hover a Session or FILE card to isolate the relevant
path; click a Session to inspect its Transcript and complete relationship chain.

If inference misses a handoff:

1. Open the downstream Session.
2. Click **补充上游** and choose the upstream Session.
3. Use **取消关联** beside a manual upstream if the relationship was added by
   mistake.

Automatic Artifact relationships remain read-only; only relationships marked
`MANUAL / 手动关联` can be removed.

### Read the Transcript

The detail page keeps the Session metadata, resume action, relationship graph,
and readable user/assistant messages together.

![Transcript detail](docs/dashboard-detail.png)

## CLI reference

Session IDs may be shortened to any unique prefix.

| Command | Purpose |
| --- | --- |
| `sessions list -n 30` | List recent Sessions across all tools and projects |
| `sessions list claude` | Limit results to `claude`, `codex`, or `pi` |
| `sessions find "keyword"` | Search summaries and readable Transcript text |
| `sessions show 48e17d64` | Show one complete Transcript |
| `sessions index` | Incrementally analyze cross-Session Artifact handoffs |
| `sessions lineage 48e17d64` | Show the complete upstream/downstream component |
| `sessions star 48e17d64 "note"` | Star a Session with an optional note |
| `sessions unstar 48e17d64` | Remove a star |
| `sessions stars` | List starred Sessions |
| `sessions dash` | Start or reopen the dashboard |

Add `--json` to `list`, `find`, `show`, `index`, or `lineage` for stable
machine-readable output.

## Additional archive sources

The three default live roots work without configuration. To read additional
snapshots, create `sources.json` in the application data directory described
below. It is `~/.local/share/session-snapshots/sources.json` on POSIX and
`%LOCALAPPDATA%\session-snapshots\sources.json` on Windows.
Use `AGENT_SESSIONS_SOURCES_FILE` to select another file. Library callers can
set `CatalogOptions.sourcesFile`, which takes precedence over the environment.
Keep this file private when its paths identify projects or organizations.

```json
{
  "version": 1,
  "sources": [
    {
      "id": "snapshot-2024",
      "label": "Laptop snapshot",
      "scope": "personal",
      "roots": [
        { "id": "claude", "tool": "claude", "path": "~/Archives/laptop/claude-projects" },
        { "id": "codex", "tool": "codex", "path": "~/Archives/laptop/codex-sessions" },
        { "id": "pi", "tool": "pi", "path": "~/Archives/laptop/pi-sessions" },
        { "id": "pi-extra", "tool": "pi", "path": "~/Archives/other/pi-sessions" }
      ],
      "cwdMappings": [
        { "from": "/old/projects/example", "to": "~/Projects/example" }
      ],
      "continuationDirectory": "~/SessionContinuations/pi"
    }
  ]
}
```

`version` and `sources` are required. Each source needs a stable unique `id`
and at least one root. Each root needs an `id` unique within its source, a
`tool` of `claude`, `codex`, or `pi`, and a path. IDs use letters, digits,
periods, underscores, or hyphens and start with a letter or digit. `live` is
reserved. `label` defaults to the source ID. `scope` is an optional display
label and does not grant tool access. Multiple roots for one tool are allowed.
Paths must be absolute or start with `~/`; Windows JSON paths need escaped
backslashes. There is no configuration editor in the dashboard.

Initial dashboard loading, every dashboard refresh, and CLI list/search include
all configured sources. The source selector defaults to all sources and only
filters displayed results, including deep-search results. Refresh rereads the
configuration and discovers new files in every root, keeps the current list
visible while scanning, preserves filters, and clamps the page when necessary.
Library callers use `list({ fresh: true })` to rescan; normal list/detail calls
may reuse the current catalog cache. Missing roots and invalid configuration
produce visible diagnostics while other sources keep working. Offline rows are
omitted until their source returns; their marks and manual relations remain.

Archive discovery accepts valid flat or nested JSONL files and excludes
recognized internal subagents and malformed records. Valid tiny archive files
are included. Live files retain the existing 2 KiB minimum for compatibility.
Diagnostics report discovered, valid, and skipped counts. Escaping file links
are skipped. The same real file in overlapping roots appears once, with live
roots taking precedence and then configuration order. Separate snapshot files
remain separate even when their original IDs match.

Archive `id` values are stable record keys derived from source ID, root ID,
tool, original ID, and relative file path. `session_id` contains the original
tool ID. Use the row `id` for detail, search, marks, and lineage. Keep IDs and
relative paths unchanged to retain annotations. Live records retain their
original IDs and raw-ID annotations. When live files share an ID, the newest
file supplies the single live row. Archive copies keep independent keys and
annotations. Names and optional
Codex metadata belong to each root. An archive Codex root may contain its own
`session_index.jsonl` and `state_5.sqlite`; it never uses the live database or
follows a database rollout path outside that root.
SQLite title, first-message, and model fields apply only when the canonical
rollout path and original ID match that exact archive file. Stale foreign paths
fall back to the file's own metadata.
Archive SQLite reads use a temporary application-data copy of the database and
its WAL, so SQLite cannot create or update sidecars in the archive directory.

Archive rename is rejected by the catalog. Stars, notes, statuses, and manual
relations write only application data. Automatic lineage connects records
within a source; explicit manual relations may cross sources.

Live `resume_command` values keep their existing behavior. Archive JSON has a
`primary_action` with `kind` of `path` or `fork` and its copy `value`, and omits
`resume_command`. Claude archives always copy their path, regardless of date.
Codex archives also copy their path. Every row has a separate source-path copy
action. Copying never launches a terminal, tool, or model.

Pi can copy `cd ... && pi --fork <archive-file> --session-dir <directory>` when
the longest directory-boundary `cwdMappings.from` match resolves to an existing
directory. Historical `from` paths may use POSIX or Windows syntax; `to` paths
use the current machine's filesystem. The continuation directory must already exist, be writable, and be
outside every configured archive root and the live pi store, including through
symlinks. Otherwise pi falls back to the source path. Create that independent
directory yourself before enabling the action. The command quotes all values
and does not inherit the archived model or provider. This file behavior was
verified offline with pi 1.3.0; interactive TUI and provider execution are not
part of that verification. Register the continuation directory as a separate
source if its new branches should appear on refresh.

## Local data and privacy

Agent Sessions reads local files directly and does not upload Transcript data.

| Tool | Session source |
| --- | --- |
| Claude Code | `~/.claude/projects/<path-slug>/*.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` plus read-only indexes |
| pi | `~/.pi/agent/sessions/<path-slug>/*.jsonl` |

Scanning, search, detail, and automatic Lineage analysis do not modify source
Sessions. Explicit rename follows each tool's local naming behavior. Stars,
notes, statuses, and archives are stored in `stars.json`; Manual
Lineage is stored in `manual-lineages.json`; the disposable automatic Lineage
cache is `lineage.sqlite`. These files live under
`~/.local/share/session-snapshots/` on POSIX or the platform local application
data directory on native Windows.

Back up `stars.json` and `manual-lineages.json` if those annotations matter to
you. `lineage.sqlite` can always be rebuilt.

## Build from source

Install Bun 1.3.14 and `rg`, then run:

```bash
bun install --frozen-lockfile
bun run compile
install -m 755 build/sessions ~/.local/bin/sessions
```

For an older x64 CPU without AVX2, build the matching baseline target:

```bash
bun scripts/compile.ts --target bun-linux-x64-baseline
bun scripts/compile.ts --target bun-windows-x64-baseline
```

For a source checkout without compiling a standalone executable:

```bash
bun install --frozen-lockfile
bun run build
./sessions dash
```

## Development

```bash
bun run test                    # Bun seam tests + Vue DOM tests
bun run typecheck               # vue-tsc --noEmit
bun run build                   # Vite build + inline assets
bun run compile                 # host standalone executable
bun scripts/real-data-check.ts  # read-only shape/count check; no Transcript text
```

Release builds target Linux, macOS, and Windows on x64 and ARM64, include
SHA-256 files, and record which target smoke tests were actually executed.
