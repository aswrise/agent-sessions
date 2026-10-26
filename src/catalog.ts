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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { isStatus, type LineageEdge, type LineageRefresh, type ManualLineageEdge, type MarkPatch, type Session, type SessionStatus, type SourceDiagnostic, type Tool, type Transcript, type TranscriptMessage } from "./contracts.ts";
import { LineageIndex } from "./lineage.ts";
import { homeDirectory, userDataDirectory } from "./paths.ts";
import { archiveAction } from "./resume.ts";
import { readSources, realContained, type ArchiveSource } from "./sources.ts";
import { sourceCopy } from "./sourceCopy.ts";

const MIN_SIZE = 2048;
const MAX_HEAD_LINES = 400;
const TAIL_CHUNK = 65_536;
const TAIL_LIMIT = 4_194_304;
const INDEX_TTL_MS = 30_000;

type Json = Record<string, unknown>;
type Metadata = {
  id: string;
  cwd: string;
  first_msg: string;
  birth: number | undefined;
  upstream_name: string;
  model: string;
  thinking_level: string;
};
type ParsedMetadata = Omit<Metadata, "model" | "thinking_level"> & { model?: string; thinking_level?: string };
type Binding = { adapter: Adapter; source?: ArchiveSource; rootId: string };
type DiscoveredFile = Binding & { path: string; stat: Stats };
type Located = DiscoveredFile & { originalId: string };
type Mark = {
  starred?: boolean;
  note?: string;
  name?: string;
  archived?: boolean;
  status?: SessionStatus;
  added?: string;
};
type Marks = Record<string, Mark>;

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

export class CatalogError extends Error {
  constructor(public code: "not_found" | "ambiguous" | "invalid" | "missing_rg" | "search_failed", message: string) {
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
  metadataSignature(path: string): string;
  loadNames(): Map<string, string>;
  transcript(id: string, path?: string): TranscriptMessage[];
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

function skipTranscript(role: string, text: string): boolean {
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
  try {
    fd = openSync(path, "r");
    let pending = Buffer.alloc(0), lines = 0, capacity = 8192;
    while (lines < limit) {
      const chunk = Buffer.allocUnsafe(capacity);
      const length = readSync(fd, chunk, 0, capacity, null);
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
function* tailLines(fd: number, size: number): Generator<string | undefined> {
  let offset = size, carry = Buffer.alloc(0);
  while (offset > 0 && size - offset < TAIL_LIMIT) {
    const length = Math.min(TAIL_CHUNK, offset);
    offset -= length;
    const chunk = Buffer.allocUnsafe(length);
    readSync(fd, chunk, 0, length, offset);
    const block = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    // 块首那半行要等下一块补齐，留成 Buffer 以免在 UTF-8 字符中间截断。
    const split = offset === 0 ? -1 : block.indexOf(10);
    if (split < 0 && offset > 0) {
      carry = block;
      yield undefined;
      continue;
    }
    carry = split < 0 ? Buffer.alloc(0) : block.subarray(0, split);
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
  let model = "", modelId = "", record: Json | undefined;
  const fd = openSync(path, "r");
  try {
    for (const line of tailLines(fd, size)) {
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
    closeSync(fd);
  }
  return { model, thinking_level: "" };
}

abstract class JsonlAdapter implements Adapter {
  abstract readonly tool: Tool;
  discoveredCount = 0;
  constructor(readonly root: string, private realPaths = false) {}
  abstract discover(): string[];
  abstract parse(path: string): ParsedMetadata | null;
  abstract loadNames(): Map<string, string>;
  abstract rename(id: string, name: string): Promise<void>;

  metadataSignature(_path: string): string { return ""; }

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

  protected messages(id: string, pick: (record: Json) => Json | undefined, locatedPath?: string, marker?: string): TranscriptMessage[] {
    const path = locatedPath ?? this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 ${this.tool} session 文件: ${id}`);
    const output: TranscriptMessage[] = [];
    for (const line of readLines(path, true)) {
      if (marker && !line.includes(marker)) continue;
      const record = parseRecord(line);
      const message = record && pick(record);
      if (!record || !message) continue;
      const role = stringValue(message.role);
      if (role !== "user" && role !== "assistant") continue;
      const text = contentText(message.content);
      if (text && !skipTranscript(role, text))
        output.push({ role, text, timestamp: stringValue(record.timestamp) });
    }
    return output;
  }

  abstract transcript(id: string): TranscriptMessage[];
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
    const titles = this.archive ? this.titleFiles.get(resolve(path)) : undefined;
    return { id, cwd: cwd || "?", first_msg: first, birth, upstream_name: titles?.custom.get(id) || titles?.ai.get(id) || "" };
  }

  loadNames(): Map<string, string> {
    const current = new Map<string, string>();
    for (const path of this.discover()) try {
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
    if (existsSync(this.root)) for (const path of new Bun.Glob(this.archive ? "**/sessions-index.json" : "*/sessions-index.json").scanSync({ cwd: this.root, absolute: true, dot: true })) {
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

  transcript(id: string, path?: string): TranscriptMessage[] {
    return this.messages(id, (record) => {
      if (!["user", "assistant"].includes(stringValue(record.type)) || record.isSidechain || record.toolUseResult) return;
      return isRecord(record.message) ? record.message : this.archive ? { ...record, role: record.type } : undefined;
    }, path, this.archive ? '"content"' : '"message"');
  }

  async rename(id: string, name: string, locatedPath?: string): Promise<void> {
    const path = locatedPath ?? this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 claude session 文件: ${id}`);
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: name, sessionId: id }) + "\n");
  }
}

class CodexAdapter extends JsonlAdapter {
  readonly tool = "codex" as const;
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
    const indexedPath = this.archive ? realpathSync(path) : resolve(path);
    if (!this.archive && this.indexedMetadata.has(indexedPath)) {
      const indexed = this.indexedMetadata.get(indexedPath);
      if (!indexed) return null;
      const meta = parseRecord(readHeadLines(path, 1).next().value ?? "");
      const payload = meta && isRecord(meta.payload) ? meta.payload : undefined;
      const birth = isoToEpoch(payload?.timestamp) ?? isoToEpoch(meta?.timestamp);
      const cwd = stringValue(payload?.cwd);
      return { ...indexed, ...(cwd ? { cwd } : {}), ...(birth === undefined ? {} : { birth }) };
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
    };
  }

  metadataSignature(path: string): string {
    const indexedPath = this.archive ? realpathSync(path) : resolve(path);
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
        const indexedPath = this.archive ? realpathSync(path) : resolve(path);
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

  transcript(id: string, path?: string): TranscriptMessage[] {
    return this.messages(id, (record) => {
      if (this.archive && record.type === "message") return record;
      if (record.type !== "response_item" || !isRecord(record.payload) || record.payload.type !== "message") return;
      return record.payload;
    }, path, this.archive ? '"message"' : '"response_item"');
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

  transcript(id: string, path?: string): TranscriptMessage[] {
    return this.messages(id, (record) => record.type === "message" && isRecord(record.message) ? record.message : undefined, path, '"message"');
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
  return Boolean(mark.starred || mark.note || mark.name || mark.archived || mark.status);
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
  private marksFile: string;
  private dataDirectory: string;
  private manualLineageFile: string;
  private metadata = new Map<string, { signature: string; value: Metadata | null }>();
  private index: { expires: number; rows: Session[] } | undefined;
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
    this.lineageIndex = new LineageIndex(join(dataDirectory, "lineage.sqlite"));
    this.now = options.now ?? (() => new Date());
    this.rgPath = options.rgPath;
  }

  async list(options: { fresh?: boolean; tool?: Tool } = {}): Promise<Session[]> {
    if (!options.fresh && !options.tool && this.index && this.index.expires > Date.now()) return structuredClone(this.index.rows);
    const rows = this.build();
    this.index = { expires: Date.now() + INDEX_TTL_MS, rows };
    return structuredClone(options.tool ? rows.filter((row) => row.tool === options.tool) : rows);
  }

  sourceDiagnostics(): SourceDiagnostic[] { return structuredClone(this.diagnostics); }

  async detail(id: string): Promise<Transcript> {
    const session = await this.exact(id);
    const location = this.location(id);
    return { ...session, messages: location.adapter.transcript(location.originalId, location.path) };
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

  async find(keyword: string, limit = 20): Promise<{ total: number; results: (Session & { snippet: string })[] }> {
    const rg = this.rgPath === undefined ? Bun.which("rg") : this.rgPath;
    if (!rg) throw new CatalogError("missing_rg", "需要 ripgrep (rg)，请安装并加入 PATH");
    const query = keyword.trim();
    if (!query) return { total: 0, results: [] };
    const rows = await this.list({ fresh: true });
    const indexed = new Map(rows.map((session) => [realpathSync(session.source_path), session]));
    const hits = new Map<string, Session & { snippet: string }>();
    for (const session of rows) {
      const summary = [session.name, session.star_note, session.first_msg, session.id, session.session_id ?? ""].find((value) => value.toLowerCase().includes(query.toLowerCase()));
      if (summary) hits.set(session.id, { ...session, snippet: matchSnippet(summary, query) });
    }
    const paths = rows.map((row) => row.source_path);
    if (paths.length) {
      const patterns = [...new Set([query, JSON.stringify(query).slice(1, -1)]
        .filter((pattern) => !pattern.includes("\n") && !pattern.includes("\r")))];
      for (let offset = 0; offset < paths.length; offset += 128) {
        const processResult = Bun.spawnSync([rg, "-i", "-F", "-l", "--null", "--no-messages", "--no-ignore", "--hidden",
          ...patterns.flatMap((pattern) => ["-e", pattern]), "--", ...paths.slice(offset, offset + 128)]);
        if (processResult.exitCode > 1)
          throw new CatalogError("search_failed", processResult.stderr.toString().trim() || "ripgrep 搜索失败");
        for (const path of processResult.stdout.toString().split("\0").filter(Boolean)) {
          const session = indexed.get(realpathSync(path));
          if (!session || hits.has(session.id)) continue;
          const location = this.location(session.id);
          const message = location.adapter.transcript(location.originalId, location.path)
            .find(({ text }) => text.toLowerCase().includes(query.toLowerCase()));
          if (message) hits.set(session.id, { ...session, snippet: matchSnippet(message.text, query) });
        }
      }
    }
    const sorted = [...hits.values()].sort(compareSessions);
    return { total: sorted.length, results: sorted.slice(0, limit) };
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
    this.saveMarks(marks); this.index = undefined;
    return id;
  }

  async updateMark(id: string, patch: MarkPatch): Promise<void> {
    await this.exact(id);
    const marks = this.loadMarks(), mark: Mark = marks[id] ?? { starred: false, note: "" };
    mark.starred ??= true;
    if (patch.star !== undefined) mark.starred = patch.star;
    if (patch.note !== undefined) mark.note = patch.note;
    if (patch.archive !== undefined) mark.archived = patch.archive;
    if (patch.status !== undefined) mark.status = patch.status;
    if (meaningful(mark)) {
      mark.added ??= added(this.now());
      marks[id] = mark;
    } else delete marks[id];
    this.saveMarks(marks);
    this.index = undefined;
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

  private location(id: string): Located {
    const location = this.locations.get(id);
    if (!location || !location.adapter.allowed(location.path)) throw new CatalogError("not_found", sourceCopy.errors.fileUnavailable(id));
    return location;
  }

  private recordKey(file: DiscoveredFile, id: string): string {
    const identity = [file.source?.id ?? "live", file.rootId, file.adapter.tool, id, relative(file.adapter.root, file.path)];
    return `${file.source ? "archive" : "live"}:${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  }

  private build(): Session[] {
    this.discoverSources();
    const marks = this.loadMarks();
    const names = new Map<Adapter, Map<string, string>>();
    const files: DiscoveredFile[] = [];
    const seenPaths = new Set<string>();
    const reports = new Map<Adapter, SourceDiagnostic>();
    for (const binding of this.bindings) {
      const { adapter, source, rootId } = binding;
      const report: SourceDiagnostic = { source_id: source?.id ?? "live", root_id: rootId, level: "info", message: "", discovered: 0, valid: 0, skipped: 0 };
      reports.set(adapter, report);
      try {
        if (source && !statSync(adapter.root).isDirectory()) throw new Error(sourceCopy.errors.notDirectory);
        names.set(adapter, adapter.loadNames());
        const paths = adapter.discover();
        if (source) paths.sort();
        report.discovered = adapter.discoveredCount;
        report.skipped = adapter.discoveredCount - paths.length;
        for (const path of paths) {
          if (!adapter.allowed(path)) { report.skipped!++; continue; }
          const real = realpathSync(path);
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
    for (const file of files) {
      const metadata = this.cached(file);
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
    const rows: Session[] = [], locations = new Map<string, Located>();
    const archiveRoots = this.bindings.filter((binding) => binding.source).map((binding) => binding.adapter.root);
    for (const { file, metadata } of parsed) {
      if (!file.source && liveFiles.get(metadata.id) !== file) continue;
      const id = file.source ? this.recordKey(file, metadata.id) : metadata.id;
      locations.set(id, { ...file, originalId: metadata.id });
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
        status: mark?.status ?? "",
      });
    }
    this.locations = locations;
    const present = new Set(files.map((file) => this.recordKey(file, "")));
    for (const key of this.metadata.keys()) if (!present.has(key)) this.metadata.delete(key);
    return rows.sort(compareSessions);
  }

  private cached(file: DiscoveredFile): Metadata | null {
    const key = this.recordKey(file, "");
    const signature = `${file.stat.ctimeMs}:${file.stat.mtimeMs}:${file.stat.size}:${file.adapter.metadataSignature(file.path)}`;
    const previous = this.metadata.get(key);
    if (previous?.signature === signature) return previous.value;
    const parsed = file.adapter.parse(file.path);
    const tail = parsed ? tailMetadata(file.path, file.adapter.tool) : undefined;
    const value = parsed ? { ...parsed, model: parsed.model || tail!.model, thinking_level: parsed.thinking_level || tail!.thinking_level } : null;
    this.metadata.set(key, { signature, value });
    return value;
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
    const session = (this.index?.rows ?? await this.list()).find((row) => row.id === id);
    if (!session) throw new CatalogError("not_found", `没有 session 匹配 '${id}'`);
    return session;
  }
}

function matchSnippet(value: string, query: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return oneLine(text, 100);
  const start = Math.max(0, index - 40), end = Math.min(text.length, index + query.length + 60);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
