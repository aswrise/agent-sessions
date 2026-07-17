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

Click a row to copy its resume command. Click **查看** to open the Transcript and
**复制恢复命令** to copy it from the detail page. Press `/` to focus search and
`Esc` to leave the detail page.

![Dashboard filters](docs/dashboard-filters.png)

### Organize your work

- Click ☆ to star an important Session.
- Click the name or note cell to edit it.
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
