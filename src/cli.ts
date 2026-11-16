#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CatalogError, SessionCatalog, type Excerpt, type ExcerptSpec, type SessionQuery } from "./catalog.ts";
import { isTool, type MatchSummary, type SearchCoverage, type SearchHit, type Session, type Tool } from "./contracts.ts";
import { primaryAction, withResumeCommand } from "./resume.ts";
import { serveResident, startDashboard, stopDashboard } from "./lifecycle.ts";
import { homeDirectory, userDataDirectory } from "./paths.ts";
import packageJson from "../package.json" with { type: "json" };

const HELP = `Agent Sessions

Usage:
  sessions                         print the active-session snapshot
  sessions list [-n 20] [claude|codex|pi] [--json]
  sessions find <term>... [--since 7d|24h|2026-11-01] [--until ...] [--tool claude,codex,pi]
                [--cwd <path>] [--self] [-n 20] [--json]
  sessions show <id-prefix> [--json]
  sessions show <id-prefix> <term>... [-C 2] [--chars 300] [-n 8] [--json]
  sessions show <id-prefix> --at [<thread>:]<n>[-<m>] [-C 0] [--chars 300] [--json]
  sessions index [--rebuild] [--json]
  sessions lineage <id-prefix> [--json]
  sessions star <id-prefix> [note]
  sessions unstar <id-prefix>
  sessions stars
  sessions dash [--no-open]
  sessions dash --stop

find:  every term must occur in the Session (meta fields, tool calls and output,
       child threads included); case-insensitive literal substrings. Results
       rank ★ (title, note, first message or user text hit) first, then
       assistant-only, then the rest. The calling Claude Code Session
       (CLAUDE_CODE_SESSION_ID) is left out unless --self.
show:  with terms, prints only windows around hits; --at reads a range by
       ordinal, in a child thread with <thread>:. --chars 0 keeps text whole.
-v     print every source diagnostic to stderr (default: errors only)
-h, --help anywhere prints this help
`;

function home(): string {
  return homeDirectory();
}

function stamp(epoch: number): string {
  const date = new Date(epoch * 1000), pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function printEntry(row: Session, snippet?: string): void {
  console.log(`${row.starred ? "★" : " "} [${stamp(row.mtime)}] ${row.tool.padEnd(6)} ${row.cwd}`);
  console.log(`    ${snippet ?? (row.name || row.first_msg)}`);
  console.log(`    ↳ ${primaryAction(row).value}\n`);
}

let verbose = false;

function reportSources(catalog: SessionCatalog): void {
  for (const diagnostic of catalog.sourceDiagnostics()) if (verbose || diagnostic.level === "error")
    console.error(`[${diagnostic.source_id}${diagnostic.root_id ? `/${diagnostic.root_id}` : ""}] ${diagnostic.message}`);
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} 缺少取值`);
  args.splice(index, 2);
  return value;
}

function integer(args: string[], name: string, fallback: number, minimum = 1): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} 必须是${minimum ? "正" : "非负"}整数`);
  return value;
}

const UNITS: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 };

function epoch(args: string[], name: string): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const relative = /^(\d+)([mhdw])$/.exec(raw);
  if (relative) return Date.now() / 1000 - Number(relative[1]) * UNITS[relative[2]!]!;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new Error(`${name} 无法解析: ${raw}`);
  return parsed / 1000;
}

function tildePath(path: string): string {
  const base = home();
  return path === base || path.startsWith(base + "/") ? "~" + path.slice(base.length) : path;
}

function line(text: string, limit: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? value.slice(0, limit) + "…" : value;
}

/** Shortest prefix (at least 8 characters) that `resolve` maps back to this id alone. */
function prefixes(ids: string[]): (id: string) => string {
  const sorted = [...new Set(ids)].sort();
  const common = (left = "", right = "") => { let index = 0; while (index < left.length && left[index] === right[index]) index++; return index; };
  const lengths = new Map(sorted.map((id, index) => [id, Math.max(8, common(id, sorted[index - 1]) + 1, common(id, sorted[index + 1]) + 1)]));
  return (id) => id.slice(0, lengths.get(id) ?? id.length);
}

const KIND_LABELS: Record<string, string> = { user: "u", assistant: "a", thinking: "th", tool_call: "call", tool_output: "out", meta: "meta" };

function hitLabel(hit: SearchHit): string {
  if (hit.kind === "meta") return `meta:${hit.field}`;
  return `#${hit.thread === "main" ? "" : hit.thread + ":"}${hit.ordinal} ${KIND_LABELS[hit.kind]}${hit.tool ? ` [${hit.tool}]` : ""}`;
}

function coverageLine(coverage: SearchCoverage): string {
  return `扫描 ${coverage.scanned_files} 个文件，候选 ${coverage.candidate_files}，未归类 ${coverage.unclassified_files}，仅注入 ${coverage.injected_only_files}，孤儿 ${coverage.orphan_files}`;
}

function printMatch(row: Session & { match: MatchSummary }, prefix: string): void {
  const { match } = row;
  console.log(`${match.tier === 1 ? "★" : " "} ${prefix} ${row.tool} ${stamp(row.mtime)} ${tildePath(row.cwd)}  ${line(row.name || row.first_msg, 80)}`);
  const sub = match.threads.reduce((sum, thread) => sum + thread.hits, 0);
  const counts = [...Object.entries(match.counts).filter(([, value]) => value).map(([kind, value]) => `${KIND_LABELS[kind]}${value}`), ...(sub ? [`sub${sub}`] : [])];
  const best = match.best[0];
  console.log(`    ${counts.join(" ")}${best ? `  ${hitLabel(best)}  ${line(best.snippet, 120)}` : ""}`);
}

function printExcerpt(excerpt: Excerpt): void {
  console.log(`${excerpt.id} ${excerpt.tool} ${stamp(excerpt.mtime)} ${tildePath(excerpt.cwd)}  ${line(excerpt.name || excerpt.first_msg, 80)}`);
  console.log(`↳ ${primaryAction(excerpt).value}`);
  const hit = excerpt.threads.filter(({ hits }) => hits.length).map(({ thread, hits }) => `${thread} ${hits.join(" ")}`);
  if (hit.length) console.log(`hits: ${hit.join(" | ")}`);
  if (!excerpt.windows.length) console.log("没有命中");
  for (const window of excerpt.windows) {
    console.log(`── ${window.thread}${window.thread !== "main" && window.label !== window.thread ? ` (${line(window.label, 60)})` : ""} #${window.from}-${window.to}`);
    for (const event of window.events)
      console.log(`#${event.ordinal} ${KIND_LABELS[event.kind]}${event.tool ? ` [${event.tool}]` : ""}  ${line(event.text, Number.MAX_SAFE_INTEGER)}${event.length ? `  (原长 ${event.length})` : ""}`);
  }
  if (excerpt.omitted_windows) console.log(`还有 ${excerpt.omitted_windows} 个窗口未显示（调大 -n 或用 --at）`);
}

function atSpec(raw: string): { thread?: string; from: number; to: number } {
  const parsed = /^(?:(.+):)?(\d+)(?:-(\d+))?$/.exec(raw);
  if (!parsed) throw new Error(`--at 格式应为 [<thread>:]<n>[-<m>]: ${raw}`);
  const from = Number(parsed[2]), to = parsed[3] === undefined ? from : Number(parsed[3]);
  return { ...(parsed[1] ? { thread: parsed[1] } : {}), from, to };
}

function internal(args: string[], name: string): string {
  const index = args.indexOf(name), value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

export async function main(argv = process.argv.slice(2), options: { html?: string } = {}): Promise<number> {
  try {
    const args = [...argv];
    if (!args.length) {
      try { console.log(readFileSync(join(userDataDirectory(home()), "last-active.txt"), "utf8")); }
      catch { console.log("还没有快照（session-tracker 每 5 分钟生成）"); }
      return 0;
    }
    if (args[0] !== "_serve" && args.some((arg) => arg === "-h" || arg === "--help")) { console.log(HELP); return 0; }
    if (args[0] === "--version") { console.log(`sessions ${packageJson.version}`); return 0; }
    if (args[0] === "_serve") {
      let html = options.html;
      if (html === undefined) {
        try { html = (await import("../build/generated-html.ts")).INDEX_HTML; } catch {}
      }
      await serveResident({ port: Number(internal(args, "--port")), nonce: internal(args, "--nonce"), stateFile: internal(args, "--state"), ...(html === undefined ? {} : { html }) });
      return 0;
    }
    verbose = flag(args, "-v") || flag(args, "--verbose");
    const json = flag(args, "--json"), rebuild = flag(args, "--rebuild"), command = args.shift();
    const n = integer(args, "-n", command === "show" ? 8 : 20), catalog = new SessionCatalog({ home: home() });
    if (command === "list") {
      const rawTool = args[0]; if (rawTool && !isTool(rawTool)) throw new Error(`未知工具: ${rawTool}`);
      const tool: Tool | undefined = rawTool && isTool(rawTool) ? rawTool : undefined;
      const rows = (await catalog.list({ fresh: true, ...(tool ? { tool } : {}) })).filter((row) => !row.archived).slice(0, n);
      reportSources(catalog);
      if (json) console.log(JSON.stringify({ sessions: rows.map((row) => withResumeCommand(row)), diagnostics: catalog.sourceDiagnostics() }, null, 2));
      else rows.forEach((row) => printEntry(row));
      return 0;
    }
    if (command === "find") {
      const since = epoch(args, "--since"), until = epoch(args, "--until"), cwd = option(args, "--cwd"), tools = option(args, "--tool");
      const self = flag(args, "--self"), caller = process.env.CLAUDE_CODE_SESSION_ID;
      const parsedTools = tools?.split(",").map((tool) => { if (!isTool(tool)) throw new Error(`未知工具: ${tool}`); return tool; });
      if (!args.length) throw new Error("find 需要至少一个词");
      const query: SessionQuery = { terms: args, ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }),
        ...(parsedTools ? { tools: parsedTools } : {}), ...(cwd ? { cwd: resolve(cwd) } : {}), ...(caller && !self ? { exclude: [caller] } : {}) };
      const { total, results, coverage } = await catalog.find(query, n);
      reportSources(catalog);
      if (json) { console.log(JSON.stringify({ total, results: results.map((row) => withResumeCommand(row)), coverage }, null, 2)); return 0; }
      if (!results.length) console.log(`没有匹配的 session（${coverageLine(coverage)}）`);
      else {
        console.log(`共 ${total} 个匹配 session，显示 ${results.length} 个（${coverageLine(coverage)}）`);
        const prefix = prefixes((await catalog.list()).map(({ id }) => id));
        results.forEach((row) => printMatch(row, prefix(row.id)));
      }
      for (const orphan of coverage.orphans) console.log(`孤儿 ${orphan.hits} 处 ${line(orphan.label, 40)}  ${orphan.path}`);
      return 0;
    }
    if (command === "show") {
      const context = option(args, "-C"), chars = integer(args, "--chars", 300, 0), at = option(args, "--at");
      const contextValue = context === undefined ? undefined : Number(context);
      if (contextValue !== undefined && (!Number.isInteger(contextValue) || contextValue < 0)) throw new Error("-C 必须是非负整数");
      const target = args.shift();
      if (!target) throw new Error("show 需要 id 前缀");
      const row = await catalog.resolve(target);
      if (at || args.length) {
        const spec: ExcerptSpec = at ? { at: atSpec(at), chars, ...(contextValue === undefined ? {} : { context: contextValue }) }
          : { around: args, chars, windows: n, ...(contextValue === undefined ? {} : { context: contextValue }) };
        const excerpt = await catalog.excerpt(row.id, spec);
        reportSources(catalog);
        if (json) console.log(JSON.stringify(withResumeCommand(excerpt), null, 2));
        else printExcerpt(excerpt);
        return 0;
      }
      const transcript = await catalog.detail(row.id);
      reportSources(catalog);
      if (json) console.log(JSON.stringify(withResumeCommand(transcript), null, 2));
      else {
        printEntry(transcript);
        transcript.messages.forEach((message) => console.log(`[${message.role}] ${message.text}\n`));
      }
      return 0;
    }
    if (command === "index" && !args.length) {
      const result = await catalog.refreshLineage(rebuild);
      reportSources(catalog);
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`已分析 ${result.sessions} 个 session（本次扫描 ${result.scanned} 个），发现 ${result.edges} 条关系，耗时 ${result.elapsed_ms}ms`);
      return 0;
    }
    if (command === "lineage" && args.length === 1) {
      const row = await catalog.resolve(args[0]!);
      const lineage = await catalog.lineage(row.id);
      reportSources(catalog);
      const value = { ...lineage, sessions: lineage.sessions.map((session) => withResumeCommand(session)) };
      if (json) console.log(JSON.stringify(value, null, 2));
      else if (!lineage.edges.length) console.log(`${row.id} 暂未发现上下游 session`);
      else lineage.edges.forEach((edge) => console.log(`${edge.upstream_id} -> ${edge.downstream_id}\n    ${edge.relation === "manual" ? "手动关联" : edge.path}`));
      return 0;
    }
    if (command === "star" && args.length) {
      const row = await catalog.resolve(args[0]!); const note = args.slice(1).join(" ");
      await catalog.updateMark(row.id, { star: true, ...(note ? { note } : {}) });
      console.log(`★ ${row.id}${note ? `  (${note})` : ""}`); return 0;
    }
    if (command === "unstar" && args.length) { console.log(`已取消 ${await catalog.unstar(args[0]!)}`); return 0; }
    if (command === "stars") {
      const stars = await catalog.listStars();
      if (!stars.length) console.log("还没有标记任何 session（sessions star <id前缀> [备注]）");
      else stars.forEach((star) => console.log(`★ ${star.id}  [${star.added}]  ${star.note}`));
      return 0;
    }
    if (command === "dash") {
      if (args.includes("--stop")) console.log(await stopDashboard() ? "dashboard 已停止" : "dashboard 未运行");
      else console.log((await startDashboard({ open: !args.includes("--no-open") })).url);
      return 0;
    }
    console.error(HELP); return 1;
  } catch (error) {
    console.error(error instanceof CatalogError || error instanceof Error ? error.message : "操作失败");
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
