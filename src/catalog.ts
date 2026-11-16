import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { isStatus, type EventKind, type LineageEdge, type SearchCoverage, type SearchResult, type SessionEvent, type LineageRefresh, type ManualLineageEdge, type MarkPatch, type Session, type SessionStatus, type SourceDiagnostic, type Tool, type Transcript, type TranscriptMessage } from "./contracts.ts";
import { LineageIndex } from "./lineage.ts";
import { homeDirectory, userDataDirectory } from "./paths.ts";
import { archiveAction } from "./resume.ts";
import { readSources, realContained, realPath, withRealpathMemo, type ArchiveSource } from "./sources.ts";
import { sourceCopy } from "./sourceCopy.ts";
import { clip, matchedTerms, mergeWindows, metaHits, parseTerms, rgPatterns, summarize, tally, verdicts, type Tally, type Term } from "./search.ts";

const MIN_SIZE = 2048;
const MAX_HEAD_LINES = 400;
const TAIL_CHUNK = 65_536;
const TAIL_LIMIT = 4_194_304;
const INDEX_TTL_MS = 30_000;
const HEAD_PREFETCH = 32_768;
const PREFETCH_BATCH = 512;
const PREFETCH_CONCURRENCY = 32;
const WORKER_THRESHOLD = 256;
const WORKER_JOB_SIZE = 32;

const TAIL_NEEDLES: Record<Tool, Buffer[]> = {
  claude: [Buffer.from('"model":"'), Buffer.from('"effort"')],
  codex: [Buffer.from('"model":"'), Buffer.from('"turn_context"')],
  pi: [Buffer.from('"modelId":"')],
};

let cacheVersion: string | undefined;
/** Hashes this module in development and the whole bundle in a compiled binary, so any parser change drops persisted metadata. */
function metadataCacheVersion(): string {
  try { return cacheVersion ??= Bun.hash(readFileSync(import.meta.path)).toString(36); }
  catch { return cacheVersion ??= crypto.randomUUID(); }
}

type Prefetched = { head: Buffer; tail: Buffer; size: number };
let prefetched: Map<string, Prefetched> | undefined;

/** Reads each file's head and tail concurrently, since per-file open latency dominates a cold scan. */
async function prefetch(paths: string[]): Promise<Map<string, Prefetched>> {
  const result = new Map<string, Prefetched>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, paths.length) }, async () => {
    while (next < paths.length) {
      const path = paths[next++]!;
      try {
        const handle = await open(path, "r");
        try {
          const { size } = await handle.stat();
          const head = Buffer.allocUnsafe(Math.min(size, HEAD_PREFETCH));
          await handle.read(head, 0, head.length, 0);
          let tail = head;
          if (size > head.length) {
            tail = Buffer.allocUnsafe(Math.min(size, TAIL_CHUNK));
            await handle.read(tail, 0, tail.length, size - tail.length);
          }
          result.set(path, { head, tail, size });
        } finally { await handle.close(); }
      } catch {}
    }
  }));
  return result;
}

type Json = Record<string, unknown>;
type Metadata = {
  id: string;
  cwd: string;
  first_msg: string;
  birth: number | undefined;
  upstream_name: string;
  model: string;
  thinking_level: string;
  /** Codex: the thread this rollout continues (`history_base`), so search also scans the older segments. */
  history_base?: string;
};
type ParsedMetadata = Omit<Metadata, "model" | "thinking_level"> & { model?: string; thinking_level?: string };
type Binding = { adapter: Adapter; source?: ArchiveSource; rootId: string };
type DiscoveredFile = Binding & { path: string; stat: Stats };
type Located = DiscoveredFile & { originalId: string; history?: true };
type MetadataEntry = { file: DiscoveredFile; key: string; signature: string };
type Mark = {
  starred?: boolean;
  note?: string;
  name?: string;
  archived?: boolean;
  pinned?: boolean;
  status?: SessionStatus;
  added?: string;
};
type Marks = Record<string, Mark>;
/** A `tool_result_file` is plain text whose event ordinals are line indexes. */
type ChildFile =
  | { kind: "agent"; path: string; thread: string; parentOriginalId?: string }
  | { kind: "tool_result_file"; path: string; thread: string; parentOriginalId: string };
type ChildEntry = ChildFile & { adapter: Adapter; mtime: number };
type ChildIndex = { children: Map<string, ChildEntry[]>; orphans: ChildEntry[] };
type Children = { files: ChildFile[]; unreadable: string[] };

export interface CatalogOptions {
  home?: string;
  dataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  rgPath?: string | null;
  codexPath?: string | null;
  now?: () => Date;
  sourcesFile?: string;
}

export interface SessionQuery {
  /** AND; each term is a case-insensitive literal substring. */
  terms: string[];
  /** Epoch seconds; a Session passes when [birth, mtime] overlaps [since, until]. */
  since?: number;
  until?: number;
  tools?: Tool[];
  /** Absolute path; a Session passes when its cwd is this path or below it. */
  cwd?: string;
  exclude?: string[];
}

export type ExcerptSpec =
  | { around: string[]; context?: number; chars?: number; windows?: number }
  | { at: { thread?: string; from: number; to: number }; context?: number; chars?: number };
export type ExcerptWindow = { thread: string; label: string; from: number; to: number; hits: number[]; events: SessionEvent[] };
export type Excerpt = Session & { threads: { thread: string; label: string; events: number; hits: number[] }[]; windows: ExcerptWindow[]; omitted_windows: number };

type ScanThread = { paths: string[]; child?: ChildEntry | undefined; load: () => RawEvent[] };
/** `tally` is absent when the thread could not be read. */
type ReadThread = { files: string[]; child?: ChildEntry | undefined; tally?: Tally };
type Owner =
  | { kind: "row"; row: Session; meta: ReturnType<typeof metaHits>; main: string[]; children: ChildEntry[] }
  | { kind: "orphan"; child: ChildEntry };

const RG_BATCH = 128;
const RG_CONCURRENCY = 8;
/** Context events around a hit are clipped harder than the hit itself; they only orient the reader. */
const CONTEXT_CHARS = 120;

/**
 * One `rg -l` per term and batch, at most RG_CONCURRENCY at a time. Returns the matching paths per term
 * and the paths ripgrep could not read; any other ripgrep failure fails the search.
 */
async function grepTerms(rg: string, terms: Term[], paths: string[]): Promise<{ found: Set<string>[]; unreadable: Set<string> }> {
  const found = terms.map(() => new Set<string>()), unreadable = new Set<string>();
  const jobs = terms.flatMap((term, index) => Array.from({ length: Math.ceil(paths.length / RG_BATCH) },
    (_, batch) => ({ index, patterns: rgPatterns(term), paths: paths.slice(batch * RG_BATCH, (batch + 1) * RG_BATCH) })));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(RG_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      if (!job.patterns.length) continue;
      const child = Bun.spawn([rg, "-i", "-F", "-l", "--null", "--no-ignore", "--hidden",
        ...job.patterns.flatMap((pattern) => ["-e", pattern]), "--", ...job.paths], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      for (const path of stdout.split("\0")) if (path) found[job.index]!.add(path);
      if (exitCode < 2) continue;
      // ripgrep reports a file it cannot open as "rg: <path>: <reason>" and keeps searching the rest.
      for (const line of stderr.split("\n").filter(Boolean)) {
        const path = job.paths.find((candidate) => line.startsWith(`rg: ${candidate}: `));
        if (!path) throw new CatalogError("search_failed", stderr.trim());
        unreadable.add(path);
      }
    }
  }));
  return { found, unreadable };
}

/** Reads a Session file; an I/O failure becomes CatalogError("unreadable") so search can count the file instead of failing. */
function readSession(path: string): Buffer {
  try { return readFileSync(path); }
  catch (error) { throw new CatalogError("unreadable", `${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Files under `root` whose relative path parts pass `keep`; an unreadable directory is skipped and reported in `unreadable`. */
function walk(root: string, keep: (parts: string[]) => boolean, unreadable: string[]): string[] {
  const output: string[] = [];
  const visit = (directory: string, parts: string[]) => {
    let entries: Dirent[];
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { unreadable.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`); return; }
    for (const entry of entries) {
      const path = join(directory, entry.name), next = [...parts, entry.name];
      if (entry.isDirectory()) visit(path, next);
      else if (entry.isFile() && keep(next)) output.push(path);
    }
  };
  if (existsSync(root)) visit(root, []);
  return output;
}

/** The first `length` bytes of each file, read concurrently; a failed read lands in `unreadable`. */
async function heads(paths: string[], length: number, unreadable: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, paths.length) }, async () => {
    while (next < paths.length) {
      const path = paths[next++]!;
      try { result.set(path, await Bun.file(path).slice(0, length).text()); }
      catch (error) { unreadable.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
  return result;
}

type Thread = { thread: string; label: string; events: RawEvent[] };
type Range = { thread: number; from: number; to: number; hits: number[] };

function aroundRanges(threads: Thread[], hits: number[][], context: number): Range[] {
  return threads.flatMap(({ events }, thread) => mergeWindows(hits[thread]!, context, events.length - 1).map((range) => ({ thread, ...range })));
}

/** `at.thread` names a child thread by id or unique id prefix; omitted means main. */
function atRange(threads: Thread[], at: { thread?: string; from: number; to: number }, context: number): Range {
  const name = at.thread ?? "main";
  const exact = threads.flatMap((item, position) => item.thread === name ? [position] : []);
  const matches = exact.length ? exact : threads.flatMap((item, position) => item.thread.startsWith(name) ? [position] : []);
  if (matches.length !== 1) throw new CatalogError("invalid", `找不到唯一的子线程: ${name}`);
  const thread = matches[0]!, last = threads[thread]!.events.length - 1;
  if (!Number.isSafeInteger(at.from) || !Number.isSafeInteger(at.to) || at.from < 0 || at.to < at.from || at.from > last)
    throw new CatalogError("invalid", `序号超出范围 0-${last}: ${at.from}-${at.to}`);
  return { thread, from: Math.max(0, at.from - context), to: Math.min(last, at.to + context), hits: [] };
}

function renderWindow({ thread, label, events }: Thread, { from, to, hits }: Range, terms: Term[], chars: number): ExcerptWindow {
  return { thread, label, from, to, hits, events: events.slice(from, to + 1).map((event, offset): SessionEvent => {
    const limit = terms.length && !hits.includes(from + offset) ? Math.min(chars, CONTEXT_CHARS) : chars;
    return { ordinal: from + offset, kind: event.kind, ...clip(event.text, terms, limit, event.kind), ...(event.tool ? { tool: event.tool } : {}), timestamp: event.timestamp };
  }) };
}

function historyBase(payload: Json | undefined): { history_base?: string } {
  const base = payload?.history_base;
  return isRecord(base) && typeof base.thread_id === "string" && base.thread_id ? { history_base: base.thread_id } : {};
}

function headCwd(path: string): string {
  for (const line of readHeadLines(path, 20)) {
    const record = parseRecord(line), cwd = stringValue(record?.cwd) || (isRecord(record?.payload) ? stringValue(record.payload.cwd) : "");
    if (cwd) return cwd;
  }
  return "";
}

export class CatalogError extends Error {
  constructor(public code: "not_found" | "ambiguous" | "invalid" | "missing_rg" | "search_failed" | "unreadable", message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

interface Adapter {
  readonly tool: Tool;
  readonly root: string;
  readonly discoveredCount: number;
  discover(): string[];
  parse(path: string): ParsedMetadata | null;
  parseJob(paths: string[]): ArchiveParseJob;
  metadataSignature(path: string): string;
  loadNames(paths: string[]): Map<string, string>;
  /** One JSONL record to 0..n events. Pure; the only place that knows each tool's wire format. */
  project(record: Json): Projected[];
  /** A main thread file's ordered events; Codex joins history_base segments oldest first. */
  events(id: string, path?: string): RawEvent[];
  /** Older files a main thread file continues from (Codex history_base), newest first. */
  history(path: string): string[];
  /** A child thread file's ordered events, without main-file filters. */
  childEvents(file: ChildFile): RawEvent[];
  /** Child thread files under this root with their direct parent's original id; not subject to MIN_SIZE. */
  children(): Promise<Children>;
  /** Display label of a child; may read a sidecar file, so callers ask only for children they show. */
  label(file: ChildFile): string;
  rename(id: string, name: string, path?: string): Promise<void>;
  findFile(id: string): string | undefined;
  allowed(path: string): boolean;
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function isoToEpoch(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? undefined : epoch / 1000;
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function compareSessions(left: Session, right: Session): number {
  return right.mtime - left.mtime || (left.source_kind === "archive"
    ? right.source_kind === "archive" ? left.id.localeCompare(right.id) : 1
    : right.source_kind === "archive" ? -1 : 0);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!isRecord(part) || !["text", "input_text", "output_text"].includes(stringValue(part.type))) return [];
    const text = stringValue(part.text).trim();
    return text ? [text] : [];
  }).join("\n").trim();
}

export type RawEvent = { kind: EventKind; text: string; tool?: string; timestamp: string; injected?: true };
type Projected = Omit<RawEvent, "timestamp">;

/** The only Transcript definition: readable user and assistant text, injected context left out. */
function transcriptOf(events: RawEvent[]): TranscriptMessage[] {
  return events.flatMap(({ kind, text, timestamp, injected }) =>
    (kind === "user" || kind === "assistant") && !injected ? [{ role: kind, text, timestamp }] : []);
}

/** Scalar leaves as `key: value` lines, so a term matches decoded tool input rather than its JSON spelling. */
function leaves(value: unknown, key = ""): string[] {
  if (typeof value === "string") return value ? [key ? `${key}: ${value}` : value] : [];
  if (typeof value === "number" || typeof value === "boolean") return [key ? `${key}: ${value}` : String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, key));
  return isRecord(value) ? Object.entries(value).flatMap(([name, item]) => leaves(item, name)) : [];
}

const flatten = (value: unknown): string => leaves(value).join("\n");

function textEvent(role: string, content: unknown): Projected[] {
  if (role !== "user" && role !== "assistant") return [];
  const text = contentText(content);
  return text ? [{ kind: role, text, ...(isInjected(role, text) ? { injected: true as const } : {}) }] : [];
}

function partEvents(content: unknown, kind: "thinking" | "tool_call", type: string, text: (part: Json) => string, tool?: (part: Json) => string): Projected[] {
  return (Array.isArray(content) ? content : []).flatMap((part): Projected[] => {
    if (!isRecord(part) || part.type !== type) return [];
    const value = text(part).trim(), name = tool?.(part);
    return value ? [{ kind, text: value, ...(name ? { tool: name } : {}) }] : [];
  });
}

const toolEvent = (kind: "tool_call" | "tool_output", tool: string, text: string): Projected[] =>
  text.trim() ? [{ kind, text: text.trim(), ...(tool ? { tool } : {}) }] : [];

function outputText(output: unknown): string {
  return typeof output === "string" ? output : Array.isArray(output) ? contentText(output) : flatten(output);
}

function isInjected(role: string, text: string): boolean {
  return role === "user" && [
    "# AGENTS.md instructions",
    "<environment_context",
    "<skill>",
    "Base directory for this skill:",
    "⚠",
  ].some((prefix) => text.startsWith(prefix));
}

function readLines(path: string, strict = false): string[] {
  if (strict) return readFileSync(path, "utf8").split(/\r?\n/);
  try {
    return readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

function* readHeadLines(path: string, limit: number): Generator<string> {
  let fd: number | undefined;
  const ahead = prefetched?.get(path);
  try {
    let pending = Buffer.alloc(0), lines = 0, capacity = 8192, position = 0;
    while (lines < limit) {
      let chunk = ahead?.head ?? Buffer.alloc(0), length = 0;
      if (ahead && position === 0) length = chunk.length;
      else if (!ahead || position < ahead.size) {
        fd ??= openSync(path, "r");
        chunk = Buffer.allocUnsafe(capacity);
        length = readSync(fd, chunk, 0, capacity, position);
      }
      position += length;
      if (!length) {
        if (pending.length) yield pending.toString("utf8").replace(/\r$/, "");
        break;
      }
      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, length)]) : chunk.subarray(0, length);
      capacity = Math.min(capacity * 2, 262_144);
      // 整块解码到最后一个换行；块尾那半行留成 Buffer 等下一轮补齐，避免在 UTF-8 字符中间截断。
      const split = data.lastIndexOf(10);
      if (split < 0) {
        pending = Buffer.from(data);
        continue;
      }
      const text = data.toString("utf8", 0, split);
      pending = Buffer.from(data.subarray(split + 1));
      for (let start = 0; lines < limit;) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        yield text.slice(start, end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
        lines++;
        if (newline < 0) break;
        start = newline + 1;
      }
    }
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function latest(paths: string[]): string | undefined {
  return paths.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

async function setCodexSessionName(executable: string | null, codexHome: string, id: string, name: string): Promise<void> {
  if (!executable) throw new CatalogError("invalid", "找不到 Codex CLI，无法更新 Session 名称");
  const child = Bun.spawn([executable, "app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exchange = async () => {
      const decoder = new TextDecoder();
      const reader = child.stdout.getReader();
      let buffer = "";
      const send = (value: Json) => {
        child.stdin.write(JSON.stringify(value) + "\n");
        child.stdin.flush();
      };
      const response = async (requestId: number): Promise<void> => {
        while (true) {
          while (!buffer.includes("\n")) {
            const { value, done } = await reader.read();
            if (done) throw new Error("Codex app-server 提前退出");
            buffer += decoder.decode(value, { stream: true });
          }
          const newline = buffer.indexOf("\n");
          const message = parseRecord(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!message || message.id !== requestId) continue;
          const error = isRecord(message.error) ? message.error : undefined;
          if (error) throw new Error(stringValue(error.message) || "Codex app-server 请求失败");
          return;
        }
      };
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-sessions", version: packageJson.version }, capabilities: {} } });
      await response(1);
      send({ method: "initialized" });
      send({ id: 2, method: "thread/name/set", params: { threadId: id, name } });
      await response(2);
      child.stdin.end();
      if (await child.exited !== 0) throw new Error("Codex app-server 退出异常");
    };
    await Promise.race([
      exchange(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { child.kill(); reject(new Error("Codex app-server 超时")); }, 5_000);
      }),
    ]);
  } catch (cause) {
    throw new CatalogError("invalid", `Codex Session 名称更新失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    clearTimeout(timeout);
    try { child.stdin.end(); } catch {}
    if (child.exitCode === null) child.kill();
  }
}

// 从文件尾往前按 64KB 推进，块与块之间 yield 一次 undefined 让调用方判定够不够；
// 找到就停，不必像按窗口重读那样为了多看 1MB 把前 64KB 再读一遍。
// 不含任何 needle 的块里没有调用方关心的行，跳过解码直接往前翻。
function* tailLines(read: (chunk: Buffer, length: number, offset: number) => void, size: number, needles: Buffer[]): Generator<string | undefined> {
  let offset = size, carry = Buffer.alloc(0);
  while (offset > 0 && size - offset < TAIL_LIMIT) {
    const length = Math.min(TAIL_CHUNK, offset);
    offset -= length;
    const chunk = Buffer.allocUnsafe(length);
    read(chunk, length, offset);
    const block = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    // 块首那半行要等下一块补齐，留成 Buffer 以免在 UTF-8 字符中间截断。
    const split = offset === 0 ? -1 : block.indexOf(10);
    if (split < 0 && offset > 0) {
      carry = block;
      yield undefined;
      continue;
    }
    carry = split < 0 ? Buffer.alloc(0) : block.subarray(0, split);
    if (!needles.some((needle) => block.indexOf(needle, split + 1) >= 0)) {
      yield undefined;
      continue;
    }
    const text = block.toString("utf8", split + 1);
    for (let end = text.length; end > 0;) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline + 1 < end) yield text.slice(newline + 1, end);
      end = newline;
    }
    yield undefined;
  }
}

function lastMatch(line: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...line.matchAll(pattern)].at(-1);
}

function tailMetadata(path: string, tool: Tool): Pick<Metadata, "model" | "thinking_level"> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { model: "", thinking_level: "" };
  }
  let model = "", modelId = "", record: Json | undefined, fd: number | undefined;
  const ahead = prefetched?.get(path)?.size === size ? prefetched.get(path) : undefined;
  const read = (chunk: Buffer, length: number, offset: number) => {
    const start = ahead ? offset - (size - ahead.tail.length) : -1;
    if (ahead && start >= 0) ahead.tail.copy(chunk, 0, start, start + length);
    else readSync(fd ??= openSync(path, "r"), chunk, 0, length, offset);
  };
  try {
    for (const line of tailLines(read, size, TAIL_NEEDLES[tool])) {
      if (line === undefined) {
        if (tool === "pi") {
          if (modelId) return { model: modelId, thinking_level: "" };
          continue;
        }
        const thinking_level = tool === "codex" && isRecord(record?.payload)
          ? stringValue(record.payload.effort) : stringValue(record?.effort);
        if ((model || thinking_level) && (tool !== "codex" || record)) return { model, thinking_level };
        continue;
      }
      if (tool === "pi") {
        const pair = lastMatch(line, /"provider":"([^"]+)","modelId":"([^"]+)"/g);
        if (pair) return { model: `${pair[1]}/${pair[2]}`, thinking_level: "" };
        modelId ||= lastMatch(line, /"modelId":"([^"]+)"/g)?.[1] ?? "";
        continue;
      }
      model ||= [...line.matchAll(/"model":"([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((value) => !value.startsWith("<"))
        .at(-1) ?? "";
      if (!record && line.includes(tool === "codex" ? '"turn_context"' : '"effort"')) {
        const parsed = parseRecord(line);
        if (parsed && (tool === "codex" ? parsed.type === "turn_context" : typeof parsed.effort === "string")) record = parsed;
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { model, thinking_level: "" };
}

function parseMetadata(adapter: Adapter, path: string): Metadata | null {
  const parsed = adapter.parse(path);
  if (!parsed) return null;
  const tail = tailMetadata(path, adapter.tool);
  return { ...parsed, first_msg: oneLine(parsed.first_msg, 240), model: parsed.model || tail.model, thinking_level: parsed.thinking_level || tail.thinking_level };
}

/** An archive adapter's parse inputs, cloneable into a worker; Claude titles are filled in by the caller. */
export type ArchiveParseJob = { tool: Tool; root: string; paths: string[]; indexed?: [string, ParsedMetadata | null][]; subagents?: [string, string][] };

export function parseArchiveJob(job: ArchiveParseJob): (Metadata | null)[] {
  const adapter = job.tool === "claude" ? new ClaudeAdapter(job.root, null, true)
    : job.tool === "pi" ? new PiAdapter(job.root, true)
      : CodexAdapter.archiveParser(job.root, job.indexed ?? [], job.subagents ?? []);
  return job.paths.map((path) => parseMetadata(adapter, path));
}

async function runWorkers(jobs: ArchiveParseJob[]): Promise<(Metadata | null)[][]> {
  const results: (Metadata | null)[][] = [];
  const workers = Array.from({ length: Math.min(jobs.length, Math.max(1, navigator.hardwareConcurrency - 1)) },
    // A compiled binary embeds the worker under its source path, which import.meta.url does not resolve to.
    () => new Worker(import.meta.url.includes("/$bunfs/") ? "./src/metadataWorker.ts" : new URL("./metadataWorker.ts", import.meta.url)));
  let next = 0;
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      const send = () => {
        if (next >= jobs.length) return resolve();
        const index = next++;
        worker.onmessage = (event: MessageEvent<(Metadata | null)[]>) => { results[index] = event.data; send(); };
        worker.postMessage(jobs[index]);
      };
      worker.onerror = (event) => reject(event.error ?? new Error(event.message));
      send();
    })));
  } finally {
    for (const worker of workers) worker.terminate();
  }
  return results;
}

abstract class JsonlAdapter implements Adapter {
  abstract readonly tool: Tool;
  discoveredCount = 0;
  constructor(readonly root: string, private realPaths = false) {}
  abstract discover(): string[];
  abstract parse(path: string): ParsedMetadata | null;
  abstract loadNames(paths: string[]): Map<string, string>;
  abstract rename(id: string, name: string): Promise<void>;

  metadataSignature(_path: string): string { return ""; }

  parseJob(paths: string[]): ArchiveParseJob { return { tool: this.tool, root: this.root, paths }; }

  async children(): Promise<Children> { return { files: [], unreadable: [] }; }

  label(file: ChildFile): string { return file.thread; }

  history(_path: string): string[] { return []; }

  protected files(pattern: string): string[] {
    const files = existsSync(this.root) ? [...new Bun.Glob(pattern).scanSync({ cwd: this.root, absolute: true, dot: true })] : [];
    this.discoveredCount = files.length;
    return this.realPaths ? files.filter((path) => this.allowed(path)) : files;
  }

  allowed(path: string): boolean {
    if (this.realPaths) return realContained(this.root, path);
    const child = relative(resolve(this.root), resolve(path));
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  }

  findFile(id: string): string | undefined {
    return latest(this.discover().filter((path) => this.parse(path)?.id === id));
  }

  abstract project(record: Json): Projected[];

  /** Lines that cannot project to an event are skipped before JSON.parse. */
  protected projectable(_line: string): boolean { return true; }

  protected eventsOf(text: string, keep: (record: Json) => boolean = () => true): RawEvent[] {
    const output: RawEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!this.projectable(line)) continue;
      const record = parseRecord(line);
      if (!record || !keep(record)) continue;
      const timestamp = stringValue(record.timestamp);
      for (const event of this.project(record)) output.push({ ...event, timestamp });
    }
    return output;
  }

  protected mainFile(id: string, path?: string): string {
    const file = path ?? this.findFile(id);
    if (!file) throw new CatalogError("not_found", `找不到 ${this.tool} session 文件: ${id}`);
    return file;
  }

  events(id: string, path?: string): RawEvent[] {
    return this.eventsOf(readSession(this.mainFile(id, path)).toString("utf8"));
  }

  childEvents(file: ChildFile): RawEvent[] {
    return this.eventsOf(readSession(file.path).toString("utf8"));
  }
}

class ClaudeAdapter extends JsonlAdapter {
  readonly tool = "claude" as const;
  private titleFiles = new Map<string, { signature: string; ai: Map<string, string>; custom: Map<string, string> }>();
  private titlesLoaded = false;

  constructor(root: string, private rgPath: string | null, private archive = false) { super(root, archive); }

  discover(): string[] {
    return this.files(this.archive ? "**/*.jsonl" : "*/*.jsonl")
      .filter((path) => !basename(path).startsWith("agent-") && (!this.archive || !relative(this.root, path).split(sep).includes("subagents")));
  }

  parse(path: string): ParsedMetadata | null {
    let cwd = "", first = "", originalId = "", recognized = false, birth: number | undefined;
    for (const line of readHeadLines(path, MAX_HEAD_LINES)) {
      if (cwd && birth !== undefined && !line.includes('"user"')) continue;
      const record = parseRecord(line);
      if (!record) continue;
      if (this.archive && record.isSidechain === true) return null;
      originalId ||= stringValue(record.sessionId);
      recognized ||= ["user", "assistant", "system"].includes(stringValue(record.type));
      cwd ||= stringValue(record.cwd);
      birth ??= isoToEpoch(record.timestamp);
      if (!first && record.type === "user" && !record.isSidechain) {
        const message = isRecord(record.message) ? record.message : this.archive ? record : {};
        const text = contentText(message.content);
        if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) first = text;
      }
      if (cwd && first) break;
    }
    if (this.archive ? !recognized : !cwd) return null;
    const id = this.archive && originalId ? originalId : basename(path, ".jsonl");
    return { id, cwd: cwd || "?", first_msg: first, birth, upstream_name: this.archive ? this.archiveTitle(path, id) : "" };
  }

  archiveTitle(path: string, id: string): string {
    const titles = this.titleFiles.get(resolve(path));
    return titles?.custom.get(id) || titles?.ai.get(id) || "";
  }

  loadNames(paths: string[]): Map<string, string> {
    const current = new Map<string, string>();
    for (const path of paths) try {
      const stat = statSync(path);
      current.set(resolve(path), `${stat.ctimeMs}:${stat.size}`);
    } catch {}
    const changed = [...current].filter(([path, signature]) => this.titleFiles.get(path)?.signature !== signature);
    if (!this.titlesLoaded) this.titlesLoaded = this.scanTitles([...current], true);
    else if (changed.length) this.scanTitles(changed, false);
    for (const path of this.titleFiles.keys()) if (!current.has(path)) this.titleFiles.delete(path);

    const ai = new Map<string, string>(), custom = new Map<string, string>();
    for (const value of this.titleFiles.values()) {
      for (const [id, name] of value.ai) ai.set(id, name);
      for (const [id, name] of value.custom) custom.set(id, name);
    }
    // Claude writes sessions-index.json beside its project's session files, so reuse those directories instead of a second tree walk.
    for (const path of new Set(paths.map((path) => join(dirname(path), "sessions-index.json")))) {
      if (!this.allowed(path)) continue;
      try {
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        const entries = isRecord(data) && Array.isArray(data.entries) ? data.entries : [];
        for (const entry of entries) if (isRecord(entry) && entry.customTitle)
          if (!custom.has(stringValue(entry.sessionId))) custom.set(stringValue(entry.sessionId), stringValue(entry.customTitle));
      } catch {}
    }
    for (const [id, name] of custom) ai.set(id, name);
    return ai;
  }

  private scanTitles(files: [string, string][], initial: boolean): boolean {
    const values = new Map(files.map(([path, signature]) => [path, {
      signature, ai: new Map<string, string>(), custom: new Map<string, string>(),
    }]));
    const add = (path: string, line: string) => {
      const value = values.get(resolve(path)), record = parseRecord(line), id = record && stringValue(record.sessionId);
      if (!value || !record || !id) return;
      if (record.type === "custom-title" && record.customTitle) value.custom.set(id, stringValue(record.customTitle));
      else if (record.type === "ai-title" && record.aiTitle) value.ai.set(id, stringValue(record.aiTitle));
    };
    if (this.rgPath && existsSync(this.root)) {
      const targets = initial && !this.archive ? [this.root] : [...values.keys()];
      if (!targets.length) return true;
      const result = Bun.spawnSync([this.rgPath, "--json", "-N", "--no-messages", "--no-ignore", "--hidden",
        String.raw`"type"\s*:\s*"(?:ai|custom)-title"`, ...targets]);
      if (result.exitCode > 1) return false;
      for (const line of result.stdout.toString().split(/\r?\n/)) {
        const event = parseRecord(line), data = event && isRecord(event.data) ? event.data : undefined;
        const path = data && isRecord(data.path) ? stringValue(data.path.text) : "";
        const lines = data && isRecord(data.lines) ? data.lines : undefined;
        if (event?.type === "match" && path && lines) add(path, stringValue(lines.text).trimEnd());
      }
    } else for (const path of values.keys()) for (const line of readLines(path)) add(path, line);
    for (const [path, value] of values) this.titleFiles.set(path, value);
    return true;
  }

  protected override projectable(line: string): boolean { return line.includes(this.archive ? '"content"' : '"message"'); }

  project(record: Json): Projected[] {
    const type = stringValue(record.type);
    if (type !== "user" && type !== "assistant") return [];
    const message = isRecord(record.message) ? record.message : this.archive ? { ...record, role: type } : undefined;
    if (!message) return [];
    const content = message.content;
    return [
      ...partEvents(content, "thinking", "thinking", (part) => stringValue(part.thinking)),
      // Tool-result records carry the output twice; the content block is the copy that stays readable.
      ...record.toolUseResult ? toolEvent("tool_output", "", contentText(content)) : textEvent(stringValue(message.role), content),
      ...(Array.isArray(content) ? content : []).flatMap((part): Projected[] => {
        if (!isRecord(part)) return [];
        if (part.type === "tool_use") return toolEvent("tool_call", stringValue(part.name), `${stringValue(part.name)}: ${flatten(part.input)}`);
        return part.type === "tool_result" ? toolEvent("tool_output", "", contentText(part.content)) : [];
      }),
    ];
  }

  // Subagent files are sidechain throughout; only a main file drops sidechain records.
  override events(id: string, path?: string): RawEvent[] {
    return this.eventsOf(readSession(this.mainFile(id, path)).toString("utf8"), (record) => !record.isSidechain);
  }

  override childEvents(file: ChildFile): RawEvent[] {
    if (file.kind === "agent") return super.childEvents(file);
    const lines = readSession(file.path).toString("utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines.map((text) => ({ kind: "tool_output", text, timestamp: "" }));
  }

  override async children(): Promise<Children> {
    const unreadable: string[] = [];
    // Live layout: <project>/agent-*.jsonl (legacy), <project>/<session>/subagents/**/agent-*.jsonl, <project>/<session>/tool-results/*.txt.
    const agent = (parts: string[]) => parts.at(-1)!.startsWith("agent-") && parts.at(-1)!.endsWith(".jsonl")
      && (this.archive || parts.length === 2 || parts[2] === "subagents");
    const result = (parts: string[]) => parts.at(-1)!.endsWith(".txt") && parts.at(-2) === "tool-results" && (this.archive || parts.length === 4);
    const paths = walk(this.root, (parts) => agent(parts) || result(parts), unreadable).filter((path) => this.allowed(path));
    const parentDirectory = (parts: string[], marker: string) => parts[parts.lastIndexOf(marker) - 1] ?? "";
    const files = paths.map((path): ChildFile => {
      const parts = relative(this.root, path).split(sep);
      if (path.endsWith(".txt")) return { kind: "tool_result_file", path, thread: basename(path), parentOriginalId: parentDirectory(parts, "tool-results") };
      const thread = basename(path, ".jsonl").slice("agent-".length);
      if (parts.includes("subagents")) return { kind: "agent", path, thread, parentOriginalId: parentDirectory(parts, "subagents") };
      const parent = stringValue(parseRecord(readHeadLines(path, 1).next().value ?? "")?.sessionId);
      return { kind: "agent", path, thread, ...(parent ? { parentOriginalId: parent } : {}) };
    });
    return { files, unreadable };
  }

  override label(file: ChildFile): string {
    const sidecar = file.path.replace(/\.jsonl$/, ".meta.json");
    if (file.kind !== "agent" || !existsSync(sidecar)) return file.thread;
    try {
      const meta: unknown = JSON.parse(readSession(sidecar).toString("utf8"));
      return isRecord(meta) && (stringValue(meta.description) || stringValue(meta.agentType)) || file.thread;
    } catch (error) {
      if (error instanceof CatalogError || error instanceof SyntaxError) return file.thread;
      throw error;
    }
  }

  async rename(id: string, name: string, locatedPath?: string): Promise<void> {
    const path = locatedPath ?? this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 claude session 文件: ${id}`);
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: name, sessionId: id }) + "\n");
  }
}

class CodexAdapter extends JsonlAdapter {
  readonly tool = "codex" as const;

  static archiveParser(root: string, indexed: [string, ParsedMetadata | null][], subagents: [string, string][]): CodexAdapter {
    const adapter = new CodexAdapter(root, "", "", null, true);
    adapter.indexedMetadata = new Map(indexed);
    adapter.archiveSubagents = new Map(subagents);
    return adapter;
  }

  override parseJob(paths: string[]): ArchiveParseJob {
    return { ...super.parseJob(paths), indexed: [...this.indexedMetadata], subagents: [...this.archiveSubagents] };
  }

  private firstMessages = new Map<string, string>();
  private models = new Map<string, string>();
  private indexedMetadata = new Map<string, ParsedMetadata | null>();
  private archiveSubagents = new Map<string, string>();
  private names = new Map<string, string>();
  private namesSignature = "";
  private namesLoaded = false;
  private metadataRevision = "";
  constructor(root: string, private indexFile: string, private stateFile: string, private codexPath: string | null, private archive = false, private snapshotDirectory = "") { super(root, archive); }

  discover(): string[] {
    return this.files(this.archive ? "**/*.jsonl" : "*/*/*/rollout-*.jsonl");
  }

  parse(path: string): ParsedMetadata | null {
    const indexedPath = this.archive ? realPath(path) : resolve(path);
    if (!this.archive && this.indexedMetadata.has(indexedPath)) {
      const indexed = this.indexedMetadata.get(indexedPath);
      if (!indexed) return null;
      const meta = parseRecord(readHeadLines(path, 1).next().value ?? "");
      const payload = meta && isRecord(meta.payload) ? meta.payload : undefined;
      const birth = isoToEpoch(payload?.timestamp) ?? isoToEpoch(meta?.timestamp);
      const cwd = stringValue(payload?.cwd);
      return { ...indexed, ...(cwd ? { cwd } : {}), ...(birth === undefined ? {} : { birth }), ...historyBase(payload) };
    }
    const lines = readHeadLines(path, MAX_HEAD_LINES + 1);
    const meta = parseRecord(lines.next().value ?? "");
    const legacy = this.archive && meta?.type === undefined && typeof meta?.id === "string"
      && (typeof meta.instructions === "string" || meta.instructions === null) && isoToEpoch(meta.timestamp) !== undefined;
    const payload = meta && isRecord(meta.payload) ? meta.payload : legacy ? meta : undefined;
    const id = payload && stringValue(payload.id);
    if (!meta || !payload || !id || payload.thread_source === "subagent"
      || this.archive && (payload.source === "subagent" || isRecord(payload.source) && "subagent" in payload.source)) {
      lines.return(undefined);
      return null;
    }
    const owned = this.archive ? this.indexedMetadata.get(indexedPath) : undefined;
    if (owned === null || this.archive && this.archiveSubagents.get(indexedPath) === id) { lines.return(undefined); return null; }
    const indexed = owned?.id === id ? owned : undefined;
    let first = (this.archive ? indexed?.first_msg : this.firstMessages.get(id))?.trim() ?? "";
    if (!first || ["<", "#", "⚠"].some((prefix) => first.startsWith(prefix))) {
      first = "";
      for (const line of lines) {
        if (!line.includes("user")) continue;
        const record = parseRecord(line);
        const value = legacy && record?.type === "message" ? record : record?.payload;
        if (!isRecord(value)) continue;
        if (value.type === "user_message") first = stringValue(value.message).trim();
        else {
          const item = isRecord(value.item) ? value.item : value;
          if (item.role === "user") first = contentText(item.content);
        }
        if (first && !["<", "#", "⚠"].some((prefix) => first.startsWith(prefix))) break;
        first = "";
      }
    } else lines.return(undefined);
    const model = this.archive ? indexed?.model : this.models.get(id);
    return {
      id,
      cwd: stringValue(payload.cwd) || "?",
      first_msg: first,
      birth: isoToEpoch(payload.timestamp) ?? isoToEpoch(meta.timestamp),
      upstream_name: this.archive ? indexed?.upstream_name ?? "" : "",
      ...(model ? { model } : {}),
      ...historyBase(payload),
    };
  }

  metadataSignature(path: string): string {
    const indexedPath = this.archive ? realPath(path) : resolve(path);
    if (this.archiveSubagents.has(indexedPath)) return JSON.stringify(["subagent", this.archiveSubagents.get(indexedPath)]);
    return this.indexedMetadata.has(indexedPath)
      ? JSON.stringify(this.indexedMetadata.get(indexedPath))
      : this.metadataRevision;
  }

  loadNames(): Map<string, string> {
    if (this.archive && [this.indexFile, this.stateFile, `${this.stateFile}-wal`, `${this.stateFile}-shm`]
      .some((path) => existsSync(path) && !this.allowed(path))) {
      this.indexedMetadata.clear();
      this.archiveSubagents.clear();
      this.metadataRevision = "unavailable";
      return new Map();
    }
    const signature = [this.indexFile, this.stateFile, `${this.stateFile}-wal`].map((path) => {
      try { const stat = statSync(path); return `${stat.ctimeMs}:${stat.size}`; } catch { return ""; }
    }).join("|");
    if (this.namesLoaded && signature === this.namesSignature) return this.names;
    const names = new Map<string, string>();
    const firstMessages = new Map<string, string>();
    const models = new Map<string, string>();
    const indexedMetadata = new Map<string, ParsedMetadata | null>();
    const archiveSubagents = new Map<string, string>();
    let indexLines: string[];
    try { indexLines = readLines(this.indexFile, existsSync(this.indexFile)); }
    catch { return this.namesLoaded ? this.names : names; }
    for (const line of indexLines) {
      const record = parseRecord(line), id = record && stringValue(record.id);
      if (!record || !id) continue;
      const name = stringValue(record.thread_name);
      if (name) names.set(id, name); else names.delete(id);
    }
    if (!existsSync(this.stateFile)) {
      this.firstMessages = firstMessages;
      this.models = models;
      this.indexedMetadata = indexedMetadata;
      this.archiveSubagents = archiveSubagents;
      this.names = names;
      this.namesSignature = signature;
      this.namesLoaded = true;
      this.metadataRevision = signature;
      return this.names;
    }
    let database: Database | undefined;
    let snapshot: string | undefined;
    try {
      let stateFile = this.stateFile;
      if (this.archive) {
        mkdirSync(this.snapshotDirectory, { recursive: true });
        snapshot = mkdtempSync(join(this.snapshotDirectory, ".codex-metadata-"));
        stateFile = join(snapshot, "state.sqlite");
        copyFileSync(this.stateFile, stateFile);
        if (existsSync(`${this.stateFile}-wal`)) copyFileSync(`${this.stateFile}-wal`, `${stateFile}-wal`);
      }
      database = new Database(stateFile, { readonly: true });
      const columns = new Set((database.query("SELECT name FROM pragma_table_info('threads')").all() as Json[]).map((row) => stringValue(row.name)));
      const optional = (name: string) => columns.has(name) ? name : `NULL AS ${name}`;
      const rows = database.query(`SELECT id, title, first_user_message, ${optional("model")}, ${optional("rollout_path")}, ${optional("cwd")}, ${optional("created_at")}, ${optional("created_at_ms")}, ${optional("thread_source")} FROM threads`).all() as Json[];
      for (const row of rows) {
        const id = stringValue(row.id), title = stringValue(row.title), first = stringValue(row.first_user_message);
        if (!this.archive) {
          if (id && first) firstMessages.set(id, first);
          if (id && stringValue(row.model)) models.set(id, stringValue(row.model));
          if (!names.has(id) && title && title !== stringValue(row.first_user_message)) names.set(id, title);
        }
        const path = stringValue(row.rollout_path);
        if (!id || !path || this.archive && !this.allowed(path)) continue;
        const indexedPath = this.archive ? realPath(path) : resolve(path);
        const validFirst = first && !["<", "#", "⚠"].some((prefix) => first.startsWith(prefix));
        if (row.thread_source === "subagent") {
          if (this.archive) archiveSubagents.set(indexedPath, id);
          else indexedMetadata.set(indexedPath, null);
        }
        else if (this.archive || validFirst) indexedMetadata.set(indexedPath, {
          id, cwd: stringValue(row.cwd) || "?", first_msg: validFirst ? first : "",
          birth: numberValue(row.created_at_ms) === undefined ? numberValue(row.created_at) : numberValue(row.created_at_ms)! / 1000,
          upstream_name: this.archive && title !== first ? title : "",
          ...(stringValue(row.model) ? { model: stringValue(row.model) } : {}),
        });
      }
    } catch {
      if (this.archive) {
        this.indexedMetadata.clear();
        this.archiveSubagents.clear();
        this.metadataRevision = signature;
        return names;
      }
      return this.namesLoaded ? this.names : names;
    }
    finally {
      try { database?.close(); } finally { if (snapshot) rmSync(snapshot, { recursive: true, force: true }); }
    }
    this.firstMessages = firstMessages;
    this.models = models;
    this.indexedMetadata = indexedMetadata;
    this.archiveSubagents = archiveSubagents;
    this.names = names;
    this.namesSignature = signature;
    this.namesLoaded = true;
    this.metadataRevision = signature;
    return this.names;
  }

  protected override projectable(line: string): boolean {
    return this.archive || line.includes('"response_item"') || line.includes('"item_completed"');
  }

  project(record: Json): Projected[] {
    const payload = isRecord(record.payload) ? record.payload : undefined;
    const item = this.archive && record.type === "message" ? record
      : record.type === "response_item" ? payload : this.archive && !payload ? record : undefined;
    if (item) switch (item.type) {
      case "message": return textEvent(stringValue(item.role), item.content);
      case "function_call": return toolEvent("tool_call", stringValue(item.name), `${stringValue(item.name)}: ${stringValue(item.arguments)}`);
      case "custom_tool_call": return toolEvent("tool_call", stringValue(item.name), `${stringValue(item.name)}: ${stringValue(item.input)}`);
      case "local_shell_call": return toolEvent("tool_call", "local_shell", `local_shell: ${flatten(item.action)}`);
      case "function_call_output": case "custom_tool_call_output": case "local_shell_call_output":
        return toolEvent("tool_output", "", outputText(item.output));
      default: return [];
    }
    const done = record.type === "event_msg" && payload?.type === "item_completed" && isRecord(payload.item) ? payload.item : undefined;
    if (!done) return [];
    if (done.type === "CommandExecution") {
      const command = Array.isArray(done.command) ? done.command.map(stringValue).join(" ") : stringValue(done.command);
      return toolEvent("tool_output", "command", `${command}\n${stringValue(done.aggregated_output)}`);
    }
    if (done.type === "McpToolCall") {
      const tool = `${stringValue(done.server)}.${stringValue(done.tool)}`, result = isRecord(done.result) ? done.result : undefined;
      return toolEvent("tool_output", tool, [`${tool}: ${flatten(done.arguments)}`, contentText(result?.content) || flatten(result), flatten(done.error)].filter(Boolean).join("\n"));
    }
    if (done.type === "FileChange" && isRecord(done.changes))
      return toolEvent("tool_output", "file_change", Object.entries(done.changes).map(([path, change]) => `${path}\n${flatten(change)}`).join("\n"));
    return [];
  }

  override async children(): Promise<Children> {
    const unreadable: string[] = [];
    const paths = walk(this.root, (parts) => parts.at(-1)!.endsWith(".jsonl") && (this.archive || parts.length === 4 && parts[3]!.startsWith("rollout-")), unreadable)
      .filter((path) => this.allowed(path));
    // A child's session_meta names itself and its parent in the first few hundred bytes, before base_instructions.
    const head = await heads(paths, 4096, unreadable);
    const files = paths.flatMap((path): ChildFile[] => {
      const text = head.get(path) ?? "", indexed = this.archiveSubagents.get(realPath(path));
      if (!indexed && !/"thread_source":"subagent"|"parent_thread_id"|"subagent":\{/.test(text)) return [];
      const field = (name: string) => text.match(new RegExp(`"${name}":"([^"]*)"`))?.[1] ?? "";
      const parent = field("parent_thread_id");
      return [{ kind: "agent", path, thread: field("id") || indexed || basename(path, ".jsonl"), ...(parent ? { parentOriginalId: parent } : {}) }];
    });
    return { files, unreadable };
  }

  override label(file: ChildFile): string {
    const text = readSession(file.path).subarray(0, 4096).toString("utf8");
    const field = (name: string) => text.match(new RegExp(`"${name}":"([^"]*)"`))?.[1] ?? "";
    return field("agent_nickname") || field("agent_path") || file.thread;
  }

  /** The history_base chain of a rollout, newest first, each with the byte length it contributes. */
  private segments(path: string): { path: string; end?: number }[] {
    const segments: { path: string; end?: number }[] = [];
    const seen = new Set<string>();
    let segment: { path: string; end?: number } = { path };
    let candidates: string[] | undefined;
    while (true) {
      if (!this.allowed(segment.path) || seen.has(segment.path))
        throw new CatalogError("invalid", `Codex 会话历史链无效: ${segment.path}`);
      seen.add(segment.path);
      segments.push(segment);
      const meta = parseRecord(readHeadLines(segment.path, 1).next().value ?? "");
      const payload = meta && isRecord(meta.payload) ? meta.payload : undefined;
      const base = payload?.history_base;
      if (base === undefined || base === null) return segments;
      if (!isRecord(base) || typeof base.thread_id !== "string" || !base.thread_id
        || typeof base.end_byte_offset !== "number" || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0)
        throw new CatalogError("invalid", `Codex 会话历史边界无效: ${segment.path}`);
      candidates ??= this.discover();
      const matches = candidates.filter((candidate) => {
        const name = basename(candidate);
        return name.endsWith(`-${base.thread_id}.jsonl`) || name.endsWith(`_${base.thread_id}.jsonl`);
      });
      if (matches.length !== 1)
        throw new CatalogError("not_found", `Codex 会话历史文件缺失或不唯一: ${base.thread_id}`);
      segment = { path: matches[0]!, end: base.end_byte_offset };
    }
  }

  override history(path: string): string[] {
    return this.segments(path).slice(1).map((segment) => segment.path);
  }

  override events(id: string, path?: string): RawEvent[] {
    return this.segments(this.mainFile(id, path)).reverse().flatMap((part) => {
      const data = readSession(part.path);
      if (part.end !== undefined && (part.end > data.length || (part.end > 0 && data[part.end - 1] !== 10)))
        throw new CatalogError("invalid", `Codex 会话历史边界超出文件或不完整: ${part.path}`);
      return this.eventsOf(data.subarray(0, part.end).toString("utf8"));
    });
  }

  async rename(id: string, name: string): Promise<void> {
    await setCodexSessionName(this.codexPath, dirname(this.root), id, name);
  }
}

class PiAdapter extends JsonlAdapter {
  readonly tool = "pi" as const;
  constructor(root: string, private archive = false) { super(root, archive); }

  discover(): string[] {
    return this.files(this.archive ? "**/*.jsonl" : "*/*.jsonl");
  }

  parse(path: string): ParsedMetadata | null {
    const lines = readHeadLines(path, MAX_HEAD_LINES + 1), meta = parseRecord(lines.next().value ?? ""), id = meta && stringValue(meta.id);
    if (!meta || meta.type !== "session" || !id) {
      lines.return(undefined);
      return null;
    }
    let first = "";
    for (const line of lines) {
      if (!line.includes('"role":"user"')) continue;
      const record = parseRecord(line), message = record && isRecord(record.message) ? record.message : undefined;
      if (record?.type === "message" && message?.role === "user") first = contentText(message.content);
      if (first && !first.startsWith("<")) break;
      first = "";
    }
    return {
      id,
      cwd: stringValue(meta.cwd) || "?",
      first_msg: first,
      birth: isoToEpoch(meta.timestamp),
      upstream_name: stringValue(meta.name),
    };
  }

  loadNames(): Map<string, string> { return new Map(); }

  protected override projectable(line: string): boolean { return line.includes('"message"'); }

  project(record: Json): Projected[] {
    const message = record.type === "message" && isRecord(record.message) ? record.message : undefined;
    if (!message) return [];
    const role = stringValue(message.role), content = message.content;
    if (role === "toolResult") return toolEvent("tool_output", stringValue(message.toolName), contentText(content));
    return [
      ...partEvents(content, "thinking", "thinking", (part) => stringValue(part.thinking)),
      ...textEvent(role, content),
      ...partEvents(content, "tool_call", "toolCall", (part) => `${stringValue(part.name)}: ${flatten(part.arguments)}`, (part) => stringValue(part.name)),
    ];
  }

  async rename(id: string, name: string, locatedPath?: string): Promise<void> {
    const path = locatedPath ?? this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 pi session 文件: ${id}`);
    const text = readFileSync(path, "utf8"), newline = text.indexOf("\n");
    const meta = parseRecord(newline < 0 ? text : text.slice(0, newline));
    if (!meta) throw new CatalogError("invalid", `pi session metadata 无效: ${id}`);
    meta.name = name;
    const output = JSON.stringify(meta) + (newline < 0 ? "" : text.slice(newline));
    atomicWrite(path, output);
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, text);
  if (existsSync(path)) chmodSync(temporary, statSync(path).mode & 0o7777);
  renameSync(temporary, path);
}

function isStarred(mark: Mark | undefined): boolean {
  return Boolean(mark && (mark.starred ?? true));
}

function meaningful(mark: Mark): boolean {
  return Boolean(mark.starred || mark.note || mark.name || mark.archived || mark.pinned || mark.status);
}

function added(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export class SessionCatalog {
  private bindings: Binding[];
  private liveBindings: Binding[];
  private archiveBindings = new Map<string, Binding>();
  private sourcesFile: string;
  private explicitSourcesFile: boolean;
  private home: string;
  private platform: NodeJS.Platform;
  private codexPath: string | null;
  private diagnostics: SourceDiagnostic[] = [];
  /** Child directories the last childIndex() could not read; replaced on every call. */
  private childDiagnostics: SourceDiagnostic[] = [];
  private marksFile: string;
  private dataDirectory: string;
  private manualLineageFile: string;
  private metadataFile: string;
  private metadataState: "unloaded" | "clean" | "dirty" = "unloaded";
  private metadata = new Map<string, { signature: string; value: Metadata | null }>();
  private index: { expires: number; rows: Session[] } | undefined;
  private archiveRows: Session[] | undefined;
  /** Scans await file prefetches midway, so they run one at a time over the shared caches. */
  private scan: Promise<unknown> = Promise.resolve();
  private locations = new Map<string, Located>();
  private now: () => Date;
  private rgPath: string | null | undefined;
  private lineageIndex: LineageIndex;

  constructor(options: CatalogOptions = {}) {
    const home = options.home ?? homeDirectory();
    const claude = join(home, ".claude", "projects");
    const codex = join(home, ".codex");
    const pi = join(home, ".pi", "agent", "sessions");
    const rg = options.rgPath === undefined ? Bun.which("rg") : options.rgPath;
    this.home = home;
    this.platform = options.platform ?? process.platform;
    this.codexPath = options.codexPath === undefined ? Bun.which("codex") : options.codexPath;
    this.liveBindings = [
      new ClaudeAdapter(claude, rg),
      new CodexAdapter(join(codex, "sessions"), join(codex, "session_index.jsonl"), join(codex, "state_5.sqlite"),
        this.codexPath),
      new PiAdapter(pi),
    ].map((adapter) => ({ adapter, rootId: adapter.tool }));
    this.bindings = this.liveBindings;
    const dataDirectory = options.dataDirectory ?? userDataDirectory(home, options.environment, options.platform);
    this.dataDirectory = dataDirectory;
    this.sourcesFile = options.sourcesFile ?? (options.environment ?? process.env).AGENT_SESSIONS_SOURCES_FILE ?? join(userDataDirectory(home, options.environment, options.platform), "sources.json");
    this.explicitSourcesFile = options.sourcesFile !== undefined || (options.environment ?? process.env).AGENT_SESSIONS_SOURCES_FILE !== undefined;
    this.marksFile = join(dataDirectory, "stars.json");
    this.manualLineageFile = join(dataDirectory, "manual-lineages.json");
    this.metadataFile = join(dataDirectory, "metadata-cache.json");
    this.lineageIndex = new LineageIndex(join(dataDirectory, "lineage.sqlite"));
    this.now = options.now ?? (() => new Date());
    this.rgPath = options.rgPath;
  }

  /** scope "live" rescans only live roots and reuses archive rows from the last full scan; scope "archive" serves that cache unless fresh. */
  async list(options: { fresh?: boolean; tool?: Tool; scope?: "live" | "archive" } = {}): Promise<Session[]> {
    const { fresh, tool, scope } = options;
    if (scope === "archive" && !fresh && this.archiveRows) return structuredClone(this.archiveRows);
    if (!fresh && !tool && !scope && this.index && this.index.expires > Date.now()) return structuredClone(this.index.rows);
    const live = scope === "live", scan = this.scan.then(() => withRealpathMemo(() => this.build(!live)));
    this.scan = scan.catch(() => {});
    const built = await scan;
    if (!live) this.archiveRows = built.filter((row) => row.source_kind === "archive");
    const rows = live ? [...built, ...this.archiveRows ?? []].sort(compareSessions) : built;
    this.index = { expires: Date.now() + INDEX_TTL_MS, rows };
    const scoped = scope ? rows.filter((row) => (row.source_kind === "archive") === (scope === "archive")) : rows;
    return structuredClone(tool ? scoped.filter((row) => row.tool === tool) : scoped);
  }

  sourceDiagnostics(): SourceDiagnostic[] { return structuredClone([...this.diagnostics, ...this.childDiagnostics]); }

  async detail(id: string): Promise<Transcript> {
    const session = await this.exact(id);
    const location = this.location(id);
    return { ...session, messages: transcriptOf(location.adapter.events(location.originalId, location.path)) };
  }

  async refreshLineage(force = false): Promise<LineageRefresh> {
    const sessions = await this.list({ fresh: true }), refreshed = this.lineageIndex.refresh(sessions, force);
    const ids = new Set(sessions.map((session) => session.id));
    const manual = this.loadManualLineages().filter((edge) => ids.has(edge.upstream_id) && ids.has(edge.downstream_id));
    return { ...refreshed, edges: refreshed.edges + manual.length };
  }

  async lineage(id: string, refresh = true): Promise<{ sessions: Session[]; edges: LineageEdge[] }> {
    await this.exact(id);
    const sessions = await this.list({ fresh: refresh });
    if (refresh) this.lineageIndex.refresh(sessions);
    const graph = this.lineageIndex.lineage(id, this.loadManualLineages());
    const indexed = new Map(sessions.map((session) => [session.id, session]));
    const present = new Set(graph.session_ids.filter((sessionId) => indexed.has(sessionId)));
    return {
      sessions: [...present].flatMap((sessionId) => {
        const session = indexed.get(sessionId);
        return session ? [session] : [];
      }),
      edges: graph.edges.filter((edge) => present.has(edge.upstream_id) && present.has(edge.downstream_id)),
    };
  }

  async lineages(): Promise<{ sessions: Session[]; edges: LineageEdge[] }> {
    const sessions = await this.list({ fresh: true });
    this.lineageIndex.refresh(sessions);
    const graph = this.lineageIndex.all(this.loadManualLineages());
    const ids = new Set(graph.session_ids);
    const present = new Set(sessions.filter((session) => ids.has(session.id)).map((session) => session.id));
    return {
      sessions: sessions.filter((session) => present.has(session.id)),
      edges: graph.edges.filter((edge) => present.has(edge.upstream_id) && present.has(edge.downstream_id)),
    };
  }

  async addManualLineage(upstreamId: string, downstreamId: string): Promise<void> {
    const sessions = await this.list({ fresh: true });
    await Promise.all([this.exact(upstreamId), this.exact(downstreamId)]);
    this.lineageIndex.refresh(sessions);
    const manual = this.loadManualLineages();
    if (manual.some((edge) => edge.upstream_id === upstreamId && edge.downstream_id === downstreamId)) return;
    const reachable = new Set([downstreamId]);
    for (const id of reachable) for (const edge of this.lineageIndex.all(manual).edges)
      if (edge.upstream_id === id) reachable.add(edge.downstream_id);
    if (reachable.has(upstreamId)) throw new CatalogError("invalid", "手动关系不能形成循环");
    manual.push({ relation: "manual", upstream_id: upstreamId, downstream_id: downstreamId, created_at: this.now().getTime() / 1000 });
    atomicWrite(this.manualLineageFile, JSON.stringify(manual, null, 1));
  }

  removeManualLineage(upstreamId: string, downstreamId: string): void {
    const manual = this.loadManualLineages();
    const kept = manual.filter((edge) => edge.upstream_id !== upstreamId || edge.downstream_id !== downstreamId);
    if (kept.length !== manual.length) atomicWrite(this.manualLineageFile, JSON.stringify(kept, null, 1));
  }

  /**
   * Sessions whose meta fields, main thread and child threads together contain every term (case-insensitive literal).
   * Every candidate file is attributed to a result or counted in coverage; an unreadable file is counted, never fatal.
   */
  async find(query: SessionQuery, limit = 20): Promise<{ total: number; results: SearchResult[]; coverage: SearchCoverage }> {
    const rg = this.rgPath === undefined ? Bun.which("rg") : this.rgPath;
    if (!rg) throw new CatalogError("missing_rg", "需要 ripgrep (rg)，请安装并加入 PATH");
    const terms = parseTerms(query.terms);
    const coverage: SearchCoverage = { scanned_files: 0, candidate_files: 0, unclassified_files: 0, partial_files: 0, injected_only_files: 0, unreadable_files: 0, orphan_files: 0, unreadable: [], orphans: [] };
    if (!terms.length) return { total: 0, results: [], coverage };
    const all = await this.list({ fresh: true });
    const index = await withRealpathMemo(() => this.childIndex());
    const inRange = (birth: number, mtime: number) => (query.since === undefined || mtime >= query.since) && (query.until === undefined || birth <= query.until);
    const prefix = query.cwd && (query.cwd.endsWith(sep) ? query.cwd : query.cwd + sep);
    const underCwd = (cwd: string) => !query.cwd || cwd === query.cwd || cwd.startsWith(prefix!);
    const toolAllowed = (tool: Tool) => !query.tools?.length || query.tools.includes(tool);
    const owners: Owner[] = [];
    for (const row of all) if (inRange(row.birth, row.mtime) && toolAllowed(row.tool) && underCwd(row.cwd) && !query.exclude?.includes(row.id))
      owners.push({ kind: "row", row, meta: metaHits(row, terms), main: this.mainFiles(row), children: index.children.get(row.id) ?? [] });
    for (const child of index.orphans) if (inRange(child.mtime, child.mtime) && toolAllowed(child.adapter.tool) && underCwd(headCwd(child.path)))
      owners.push({ kind: "orphan", child });
    // A thread is the unit of reading: a main thread may span several Codex segment files.
    const childThread = (child: ChildEntry): ScanThread => ({ paths: [child.path], child, load: () => child.adapter.childEvents(child) });
    const threadsOf = (owner: Owner): ScanThread[] => owner.kind === "orphan" ? [childThread(owner.child)]
      : [{ paths: owner.main, load: () => this.mainEvents(owner.row) }, ...owner.children.map(childThread)];
    const paths = owners.flatMap((owner) => threadsOf(owner).flatMap((thread) => thread.paths));
    coverage.scanned_files = paths.length;
    const { found, unreadable } = await grepTerms(rg, terms, paths);
    const touched = (path: string) => unreadable.has(path) || found.some((hits) => hits.has(path));
    const results: SearchResult[] = [];
    for (const owner of owners) {
      const threads = threadsOf(owner), meta = owner.kind === "row" ? owner.meta : { seen: new Set<number>(), best: [] };
      // An unreadable file may hold any term, so it keeps its owner in play.
      const possible = (term: number) => meta.seen.has(term) || threads.some(({ paths: files }) => files.some((path) => unreadable.has(path) || found[term]!.has(path)));
      if (!terms.every((_, term) => possible(term))) continue;
      const read = threads.flatMap(({ paths: all, child, load }): ReadThread[] => {
        const files = all.filter(touched);
        if (!files.length) return [];
        if (files.some((path) => unreadable.has(path))) return [{ files, child }];
        try { return [{ files, child, tally: tally(load(), terms, child?.thread ?? "main") }]; }
        catch (error) { if (error instanceof CatalogError) return [{ files, child }]; throw error; }
      });
      const outcome = verdicts(terms.length, meta.seen, read.map((thread) => thread.tally));
      read.forEach((thread, position) => {
        coverage.candidate_files += thread.files.length;
        const verdict = outcome[position]!;
        if (verdict === "unreadable") { coverage.unreadable_files += thread.files.length; coverage.unreadable.push(...thread.files); }
        else if (verdict === "injected_only") coverage.injected_only_files += thread.files.length;
        else if (verdict === "partial") coverage.partial_files += thread.files.length;
        else if (verdict === "unclassified") coverage.unclassified_files += thread.files.length;
        else if (owner.kind === "orphan") coverage.orphan_files += thread.files.length;
      });
      if (meta.seen.size < terms.length && !outcome.includes("match")) continue;
      const hit = read.flatMap(({ child, tally: counts }) => counts ? [{ child, tally: counts }] : []);
      if (owner.kind === "orphan") {
        coverage.orphans.push({ path: owner.child.path, label: owner.child.adapter.label(owner.child), hits: hit[0]?.tally.hits ?? 0 });
        continue;
      }
      const match = summarize(meta, hit.find((thread) => !thread.child)?.tally,
        hit.flatMap(({ child, tally: counts }) => child ? [{ thread: child.thread, label: child.adapter.label(child), tally: counts }] : []));
      results.push({ ...owner.row, snippet: match.best[0]?.snippet ?? "", match });
    }
    coverage.orphans.sort((left, right) => right.hits - left.hits);
    results.sort((left, right) => left.match.tier - right.match.tier || compareSessions(left, right));
    return { total: results.length, results: results.slice(0, limit), coverage };
  }

  /** Windows of one Session's event streams (main thread, then child threads), so a reader never needs the whole Transcript. */
  async excerpt(id: string, spec: ExcerptSpec): Promise<Excerpt> {
    const session = await this.exact(id);
    const index = await withRealpathMemo(() => this.childIndex());
    const threads = [
      { thread: "main", label: "main", events: this.mainEvents(session) },
      ...(index.children.get(id) ?? []).sort((left, right) => left.path.localeCompare(right.path))
        .map((child) => ({ thread: child.thread, label: child.adapter.label(child), events: child.adapter.childEvents(child) })),
    ];
    const terms = "around" in spec ? parseTerms(spec.around) : [];
    if ("around" in spec && !terms.length) throw new CatalogError("invalid", "缺少要定位的词");
    const hits = threads.map(({ events }) => events.flatMap((event, ordinal) => !event.injected && matchedTerms(event.text, terms).length ? [ordinal] : []));
    const ranges = "around" in spec ? aroundRanges(threads, hits, spec.context ?? 2) : [atRange(threads, spec.at, spec.context ?? 0)];
    const shown = "around" in spec ? ranges.slice(0, spec.windows ?? 8) : ranges;
    return {
      ...session,
      threads: threads.map(({ thread, label, events }, position) => ({ thread, label, events: events.length, hits: hits[position]! })),
      windows: shown.map((range) => renderWindow(threads[range.thread]!, range, terms, spec.chars ?? 300)),
      omitted_windows: ranges.length - shown.length,
    };
  }

  private mainEvents(row: Session): RawEvent[] {
    const location = this.location(row.id);
    return location.adapter.events(location.originalId, location.path);
  }

  /** The files a row's main thread is read from: its own file and, for a continued Codex rollout, the older segments. */
  private mainFiles(row: Session): string[] {
    const location = this.locations.get(row.id);
    if (!location?.history) return [row.source_path];
    try { return [row.source_path, ...location.adapter.history(location.path)]; }
    // A broken chain fails mainEvents() too, which counts the row's file as unreadable.
    catch (error) { if (error instanceof CatalogError) return [row.source_path]; throw error; }
  }

  async resolve(prefix: string): Promise<Session> {
    const matches = (await this.list({ fresh: true })).filter(({ id }) => id.startsWith(prefix));
    if (!matches.length) throw new CatalogError("not_found", `没有 session 匹配 '${prefix}'`);
    if (matches.length > 1) throw new CatalogError("ambiguous", `id 前缀 '${prefix}' 匹配到 ${matches.length} 个 session，需要更长前缀`);
    return matches[0]!;
  }

  async listStars(): Promise<{ id: string; added: string; note: string }[]> {
    return Object.entries(this.loadMarks())
      .filter(([, mark]) => isStarred(mark))
      .map(([id, mark]) => ({ id, added: mark.added ?? "", note: mark.note ?? "" }))
      .sort((left, right) => right.added.localeCompare(left.added));
  }

  async unstar(prefix: string): Promise<string> {
    const matches = (await this.listStars()).filter(({ id }) => id.startsWith(prefix));
    if (matches.length !== 1) throw new CatalogError(matches.length ? "ambiguous" : "not_found", `'${prefix}' 匹配到 ${matches.length} 个已标记 session`);
    const id = matches[0]!.id, marks = this.loadMarks(), mark = marks[id]!;
    mark.starred = false;
    if (meaningful(mark)) marks[id] = mark; else delete marks[id];
    this.saveMarks(marks); this.index = this.archiveRows = undefined;
    return id;
  }

  async updateMark(id: string, patch: MarkPatch): Promise<void> {
    await this.exact(id);
    const marks = this.loadMarks(), mark: Mark = marks[id] ?? { starred: false, note: "" };
    mark.starred ??= true;
    if (patch.star !== undefined) mark.starred = patch.star;
    if (patch.note !== undefined) mark.note = patch.note;
    if (patch.archive !== undefined) mark.archived = patch.archive;
    if (patch.pin !== undefined) mark.pinned = patch.pin;
    if (patch.status !== undefined) mark.status = patch.status;
    if (meaningful(mark)) {
      mark.added ??= added(this.now());
      marks[id] = mark;
    } else delete marks[id];
    this.saveMarks(marks);
    this.index = this.archiveRows = undefined;
  }

  async rename(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new CatalogError("invalid", "名称不能为空");
    const session = await this.exact(id);
    const location = this.location(id);
    if (location.source) throw new CatalogError("invalid", sourceCopy.errors.readonly);
    await location.adapter.rename(location.originalId, name.trim(), location.path);
    if (session.tool === "codex") {
      const marks = this.loadMarks(), mark = marks[id];
      if (mark?.name) {
        delete mark.name;
        if (!meaningful(mark)) delete marks[id];
        this.saveMarks(marks);
      }
    }
    this.index = undefined;
  }

  private discoverSources(): void {
    const { sources, diagnostics } = readSources(this.sourcesFile, this.home);
    this.diagnostics = diagnostics;
    if (this.explicitSourcesFile && !existsSync(this.sourcesFile)) this.diagnostics.push({ source_id: "config", level: "error", message: sourceCopy.errors.missingConfig });
    const bindings: Binding[] = [...this.liveBindings];
    const retained = new Map<string, Binding>();
    for (const source of sources) for (const root of source.roots) {
      const key = JSON.stringify([source.id, root.id, root.tool, root.path]);
      let binding = this.archiveBindings.get(key);
      if (!binding) {
        const adapter = root.tool === "claude" ? new ClaudeAdapter(root.path, this.rgPath === undefined ? Bun.which("rg") : this.rgPath, true)
          : root.tool === "pi" ? new PiAdapter(root.path, true)
          : new CodexAdapter(root.path, join(root.path, "session_index.jsonl"), join(root.path, "state_5.sqlite"), null, true, this.dataDirectory);
        binding = { adapter, source, rootId: root.id };
      } else binding.source = source;
      retained.set(key, binding);
      bindings.push(binding);
    }
    this.archiveBindings = retained;
    this.bindings = bindings;
  }

  /** Attributes every child file of the last scan to a row, walking child-of-child chains; the rest are orphans. */
  private async childIndex(): Promise<ChildIndex> {
    const rowIds = new Map<Adapter, Map<string, string>>(), rowPaths = new Set<string>();
    for (const [id, location] of this.locations) {
      const ids = rowIds.get(location.adapter) ?? new Map<string, string>();
      ids.set(location.originalId, id);
      rowIds.set(location.adapter, ids);
      rowPaths.add(resolve(location.path));
    }
    const index: ChildIndex = { children: new Map(), orphans: [] };
    this.childDiagnostics = [];
    for (const { adapter, source, rootId } of this.bindings) {
      const { files, unreadable } = await adapter.children();
      const parents = new Map(files.flatMap((file) => file.kind === "agent" ? [[file.thread, file.parentOriginalId] as const] : []));
      const ids = rowIds.get(adapter);
      for (const file of files) {
        if (rowPaths.has(resolve(file.path))) continue;
        let mtime: number;
        try { mtime = statSync(file.path).mtimeMs / 1000; }
        catch (error) { unreadable.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); continue; }
        let parent = file.parentOriginalId, owner: string | undefined;
        for (const seen = new Set<string>(); parent && !seen.has(parent); parent = parents.get(parent)) {
          seen.add(parent);
          owner = ids?.get(parent);
          if (owner) break;
        }
        const entry: ChildEntry = { ...file, adapter, mtime };
        if (!owner) index.orphans.push(entry);
        else index.children.set(owner, [...index.children.get(owner) ?? [], entry]);
      }
      for (const reason of unreadable)
        this.childDiagnostics.push({ source_id: source?.id ?? "live", root_id: rootId, level: "error", message: sourceCopy.errors.childUnreadable(reason) });
    }
    return index;
  }

  private location(id: string): Located {
    const location = this.locations.get(id);
    if (!location || !location.adapter.allowed(location.path)) throw new CatalogError("not_found", sourceCopy.errors.fileUnavailable(id));
    return location;
  }

  private recordKey(file: DiscoveredFile, id: string): string {
    const identity = [file.source?.id ?? "live", file.rootId, file.adapter.tool, id, relative(file.adapter.root, file.path)];
    return `${file.source ? "archive" : "live"}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }

  private async build(archive: boolean): Promise<Session[]> {
    if (this.metadataState === "unloaded") this.loadMetadataCache();
    if (archive) this.discoverSources();
    else this.diagnostics = this.diagnostics.filter((report) => report.source_id !== "live");
    const marks = this.loadMarks();
    const names = new Map<Adapter, Map<string, string>>();
    const files: DiscoveredFile[] = [];
    const seenPaths = new Set<string>();
    const reports = new Map<Adapter, SourceDiagnostic>();
    for (const binding of archive ? this.bindings : this.liveBindings) {
      const { adapter, source, rootId } = binding;
      const report: SourceDiagnostic = { source_id: source?.id ?? "live", root_id: rootId, level: "info", message: "", discovered: 0, valid: 0, skipped: 0 };
      reports.set(adapter, report);
      try {
        if (source && !statSync(adapter.root).isDirectory()) throw new Error(sourceCopy.errors.notDirectory);
        const paths = adapter.discover();
        names.set(adapter, adapter.loadNames(paths));
        if (source) paths.sort();
        report.discovered = adapter.discoveredCount;
        report.skipped = adapter.discoveredCount - paths.length;
        for (const path of paths) {
          if (!adapter.allowed(path)) { report.skipped!++; continue; }
          const real = realPath(path);
          if (source && seenPaths.has(real)) { report.skipped!++; continue; }
          const stat = statSync(real);
          if (!stat.isFile() || !source && stat.size < MIN_SIZE) { report.skipped!++; continue; }
          seenPaths.add(real);
          files.push({ ...binding, path: resolve(path), stat });
        }
      } catch (error) {
        report.level = "error";
        report.message = sourceCopy.errors.inaccessible(error instanceof Error ? error.message : sourceCopy.errors.read);
      }
      if (source || report.message) this.diagnostics.push(report);
    }
    const parsed: { file: DiscoveredFile; metadata: Metadata }[] = [];
    const liveFiles = new Map<string, DiscoveredFile>();
    const rootCounts = new Map<Adapter, Map<string, number>>();
    const entries = files.map((file) => this.metadataEntry(file));
    const misses = entries.filter(({ key, signature }) => this.metadata.get(key)?.signature !== signature);
    const offloaded = misses.length >= WORKER_THRESHOLD ? misses.filter(({ file }) => file.source) : [];
    const workers = offloaded.length ? this.parseInWorkers(offloaded) : undefined;
    await this.parseInline(workers ? misses.filter(({ file }) => !file.source) : misses);
    if (workers) await workers;
    for (const entry of entries) {
      const { file } = entry, metadata = this.cached(entry);
      const report = reports.get(file.adapter);
      if (!metadata) { if (report) report.skipped!++; continue; }
      if (report) report.valid!++;
      parsed.push({ file, metadata });
      const counts = rootCounts.get(file.adapter) ?? new Map<string, number>();
      counts.set(metadata.id, (counts.get(metadata.id) ?? 0) + 1);
      rootCounts.set(file.adapter, counts);
      if (!file.source && (!liveFiles.has(metadata.id) || file.stat.mtimeMs > liveFiles.get(metadata.id)!.stat.mtimeMs))
        liveFiles.set(metadata.id, file);
    }
    for (const report of reports.values()) if (!report.message)
      report.message = sourceCopy.counts(report.discovered!, report.valid!, report.skipped!);
    const rows: Session[] = [], locations = new Map(archive ? [] : [...this.locations].filter(([, location]) => location.source));
    const archiveRoots = this.bindings.filter((binding) => binding.source).map((binding) => binding.adapter.root);
    for (const { file, metadata } of parsed) {
      if (!file.source && liveFiles.get(metadata.id) !== file) continue;
      const id = file.source ? this.recordKey(file, metadata.id) : metadata.id;
      locations.set(id, { ...file, originalId: metadata.id, ...(metadata.history_base ? { history: true as const } : {}) });
      const mark = marks[id];
      const rootName = file.source && rootCounts.get(file.adapter)!.get(metadata.id)! > 1 ? "" : names.get(file.adapter)?.get(metadata.id);
      const upstream = metadata.upstream_name || rootName || "";
      const name = file.adapter.tool === "codex" ? upstream || mark?.name || "" : mark?.name || upstream;
      rows.push({
        id,
        ...(file.source ? { session_id: metadata.id, source_id: file.source.id, source_label: file.source.label,
          ...(file.source.scope ? { source_scope: file.source.scope } : {}), source_kind: "archive" as const, root_id: file.rootId,
          primary_action: archiveAction({ tool: file.adapter.tool, cwd: metadata.cwd, path: resolve(file.path) }, file.source, archiveRoots, join(this.home, ".pi", "agent", "sessions"), this.platform) }
          : {}),
        tool: file.adapter.tool,
        source_path: resolve(file.path),
        cwd: metadata.cwd,
        name: oneLine(name, 120),
        first_msg: oneLine(metadata.first_msg, 240),
        mtime: file.stat.mtimeMs / 1000,
        birth: metadata.birth ?? file.stat.mtimeMs / 1000,
        size_kb: Math.floor(file.stat.size / 1024),
        model: metadata.model,
        ...(metadata.thinking_level ? { thinking_level: metadata.thinking_level } : {}),
        starred: isStarred(mark),
        star_note: mark?.note ?? "",
        archived: Boolean(mark?.archived),
        ...(mark?.pinned ? { pinned: true } : {}),
        status: mark?.status ?? "",
      });
    }
    this.locations = locations;
    const present = new Set(entries.map(({ key }) => key));
    for (const key of this.metadata.keys()) if (!present.has(key) && (archive || key.startsWith("live:"))) {
      this.metadata.delete(key);
      this.metadataState = "dirty";
    }
    // Live-only refreshes skip the write: they run often and the costly archive entries are already on disk.
    if (archive && this.metadataState === "dirty") this.saveMetadataCache();
    return rows.sort(compareSessions);
  }

  private metadataEntry(file: DiscoveredFile): MetadataEntry {
    return { file, key: this.recordKey(file, ""),
      signature: `${file.stat.ctimeMs}:${file.stat.mtimeMs}:${file.stat.size}:${file.adapter.metadataSignature(file.path)}` };
  }

  private cached(entry: MetadataEntry): Metadata | null {
    const previous = this.metadata.get(entry.key);
    if (previous?.signature === entry.signature) return previous.value;
    return this.store(entry, parseMetadata(entry.file.adapter, entry.file.path));
  }

  private store({ key, signature }: MetadataEntry, value: Metadata | null): Metadata | null {
    this.metadata.set(key, { signature, value });
    this.metadataState = "dirty";
    return value;
  }

  private async parseInline(entries: MetadataEntry[]): Promise<void> {
    for (let start = 0; start < entries.length; start += PREFETCH_BATCH) {
      const batch = entries.slice(start, start + PREFETCH_BATCH);
      prefetched = await prefetch(batch.map(({ file }) => file.path));
      try { for (const entry of batch) this.cached(entry); } finally { prefetched = undefined; }
    }
  }

  /** Spreads a cold archive scan across cores; falls back to parsing inline if workers are unavailable. */
  private async parseInWorkers(entries: MetadataEntry[]): Promise<void> {
    const groups = new Map<Adapter, MetadataEntry[]>(), chunks: MetadataEntry[][] = [];
    for (const entry of entries) {
      const group = groups.get(entry.file.adapter);
      if (group) group.push(entry); else groups.set(entry.file.adapter, [entry]);
    }
    for (const group of groups.values())
      for (let start = 0; start < group.length; start += WORKER_JOB_SIZE) chunks.push(group.slice(start, start + WORKER_JOB_SIZE));
    let results: (Metadata | null)[][];
    try {
      results = await runWorkers(chunks.map((chunk) => chunk[0]!.file.adapter.parseJob(chunk.map(({ file }) => file.path))));
    } catch {
      return this.parseInline(entries);
    }
    chunks.forEach((chunk, index) => chunk.forEach((entry, position) => {
      const value = results[index]![position]!;
      const { adapter, path } = entry.file;
      if (value && adapter instanceof ClaudeAdapter) value.upstream_name = adapter.archiveTitle(path, value.id);
      this.store(entry, value);
    }));
  }

  private loadMetadataCache(): void {
    this.metadataState = "clean";
    try {
      const value: unknown = JSON.parse(readFileSync(this.metadataFile, "utf8"));
      if (!isRecord(value) || value.version !== metadataCacheVersion() || !Array.isArray(value.entries)) return;
      for (const entry of value.entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
        const metadata: unknown = entry[2];
        if (metadata === null || isRecord(metadata) && ["id", "cwd", "first_msg", "upstream_name", "model", "thinking_level"].every((field) => typeof metadata[field] === "string"))
          this.metadata.set(entry[0], { signature: entry[1], value: metadata as Metadata | null });
      }
    } catch {}
  }

  private saveMetadataCache(): void {
    try {
      const entries = [...this.metadata].map(([key, { signature, value }]) => [key, signature, value]);
      atomicWrite(this.metadataFile, JSON.stringify({ version: metadataCacheVersion(), entries }));
      this.metadataState = "clean";
    } catch {}
  }

  private loadManualLineages(): ManualLineageEdge[] {
    if (!existsSync(this.manualLineageFile)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.manualLineageFile, "utf8"));
      if (!Array.isArray(value) || !value.every((edge) => isRecord(edge) && edge.relation === "manual"
        && typeof edge.upstream_id === "string" && edge.upstream_id
        && typeof edge.downstream_id === "string" && edge.downstream_id !== edge.upstream_id
        && typeof edge.created_at === "number" && Number.isFinite(edge.created_at))) throw new Error();
      return value as ManualLineageEdge[];
    } catch {
      throw new CatalogError("invalid", "手动关系数据已损坏");
    }
  }

  private loadMarks(): Marks {
    try {
      const value: unknown = JSON.parse(readFileSync(this.marksFile, "utf8"));
      if (!isRecord(value)) return {};
      const marks: Marks = {};
      for (const [id, raw] of Object.entries(value)) {
        if (!isRecord(raw)) continue;
        const mark: Mark = {};
        if (typeof raw.starred === "boolean") mark.starred = raw.starred;
        if (typeof raw.note === "string") mark.note = raw.note;
        if (typeof raw.name === "string") mark.name = raw.name;
        if (typeof raw.archived === "boolean") mark.archived = raw.archived;
        if (typeof raw.pinned === "boolean") mark.pinned = raw.pinned;
        if (isStatus(raw.status)) mark.status = raw.status;
        if (typeof raw.added === "string") mark.added = raw.added;
        marks[id] = mark;
      }
      return marks;
    } catch {
      return {};
    }
  }

  private saveMarks(marks: Marks): void {
    atomicWrite(this.marksFile, JSON.stringify(marks, null, 1));
  }

  private async exact(id: string): Promise<Session> {
    const match = (rows: Session[]) => rows.find((row) => row.id === id);
    const session = match(this.index?.rows ?? []) ?? match(await this.list({ fresh: true }));
    if (!session) throw new CatalogError("not_found", `没有 session 匹配 '${id}'`);
    return session;
  }
}
