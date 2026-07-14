import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isStatus, type MarkPatch, type Session, type SessionStatus, type Tool, type Transcript, type TranscriptMessage } from "./contracts.ts";
import { userDataDirectory } from "./paths.ts";

const MIN_SIZE = 2048;
const MAX_HEAD_LINES = 400;
const INDEX_TTL_MS = 30_000;

type Json = Record<string, unknown>;
type Metadata = {
  id: string;
  cwd: string;
  first_msg: string;
  birth: number | undefined;
  upstream_name: string;
  model: string;
};
type Located = { adapter: Adapter; path: string; stat: Stats };
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
  now?: () => Date;
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
  discover(): string[];
  parse(path: string): Omit<Metadata, "model"> | null;
  loadNames(): Map<string, string>;
  transcript(id: string): TranscriptMessage[];
  rename(id: string, name: string): "upstream" | "local";
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

function isoToEpoch(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? undefined : epoch / 1000;
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ");
  return text.length > limit ? text.slice(0, limit) + "…" : text;
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

function latest(paths: string[]): string | undefined {
  return paths.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

function tailModel(path: string, tool: Tool): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  const fd = openSync(path, "r");
  try {
    for (const window of [65_536, 1_048_576, 4_194_304]) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      if (tool === "pi") {
        const pairs = [...text.matchAll(/"provider":"([^"]+)","modelId":"([^"]+)"/g)];
        if (pairs.length) return `${pairs.at(-1)![1]}/${pairs.at(-1)![2]}`;
        const ids = [...text.matchAll(/"modelId":"([^"]+)"/g)];
        if (ids.length) return ids.at(-1)![1]!;
      } else {
        const models = [...text.matchAll(/"model":"([^"]+)"/g)]
          .map((match) => match[1]!)
          .filter((model) => !model.startsWith("<"));
        if (models.length) return models.at(-1)!;
      }
      if (length === size) break;
    }
  } finally {
    closeSync(fd);
  }
  return "";
}

abstract class JsonlAdapter implements Adapter {
  abstract readonly tool: Tool;
  constructor(readonly root: string) {}
  abstract discover(): string[];
  abstract parse(path: string): Omit<Metadata, "model"> | null;
  abstract loadNames(): Map<string, string>;
  abstract rename(id: string, name: string): "upstream" | "local";

  allowed(path: string): boolean {
    return this.discover().map((candidate) => resolve(candidate)).includes(resolve(path));
  }

  findFile(id: string): string | undefined {
    return latest(this.discover().filter((path) => this.parse(path)?.id === id));
  }

  protected messages(id: string, pick: (record: Json) => Json | undefined): TranscriptMessage[] {
    const path = this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 ${this.tool} session 文件: ${id}`);
    const output: TranscriptMessage[] = [];
    for (const line of readLines(path, true)) {
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

  discover(): string[] {
    if (!existsSync(this.root)) return [];
    return [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: this.root, absolute: true, dot: true })]
      .filter((path) => !basename(path).startsWith("agent-"));
  }

  parse(path: string): Omit<Metadata, "model"> | null {
    let cwd = "", first = "", birth: number | undefined;
    for (const line of readLines(path).slice(0, MAX_HEAD_LINES)) {
      const record = parseRecord(line);
      if (!record) continue;
      cwd ||= stringValue(record.cwd);
      birth ??= isoToEpoch(record.timestamp);
      if (!first && record.type === "user" && !record.isSidechain) {
        const message = isRecord(record.message) ? record.message : {};
        const text = contentText(message.content);
        if (text && !text.startsWith("<") && !text.startsWith("Caveat:")) first = text;
      }
      if (cwd && first) break;
    }
    if (!cwd) return null;
    return { id: basename(path, ".jsonl"), cwd, first_msg: first, birth, upstream_name: "" };
  }

  loadNames(): Map<string, string> {
    const ai = new Map<string, string>(), custom = new Map<string, string>();
    for (const path of this.discover()) for (const line of readLines(path)) {
      const record = parseRecord(line);
      const id = record && stringValue(record.sessionId);
      if (!record || !id) continue;
      if (record.type === "custom-title" && record.customTitle) custom.set(id, stringValue(record.customTitle));
      else if (record.type === "ai-title" && record.aiTitle) ai.set(id, stringValue(record.aiTitle));
    }
    if (existsSync(this.root)) for (const path of new Bun.Glob("*/sessions-index.json").scanSync({ cwd: this.root, absolute: true, dot: true })) {
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

  transcript(id: string): TranscriptMessage[] {
    return this.messages(id, (record) => {
      if (!["user", "assistant"].includes(stringValue(record.type)) || record.isSidechain || record.toolUseResult) return;
      return isRecord(record.message) ? record.message : undefined;
    });
  }

  rename(id: string, name: string): "upstream" {
    const path = this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 claude session 文件: ${id}`);
    appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: name, sessionId: id }) + "\n");
    return "upstream";
  }
}

class CodexAdapter extends JsonlAdapter {
  readonly tool = "codex" as const;
  constructor(root: string, private indexFile: string, private stateFile: string) { super(root); }

  discover(): string[] {
    if (!existsSync(this.root)) return [];
    return [...new Bun.Glob("*/*/*/rollout-*.jsonl").scanSync({ cwd: this.root, absolute: true, dot: true })]
      .filter((path) => !this.isSubagent(path));
  }

  private isSubagent(path: string): boolean {
    const first = parseRecord(readLines(path)[0] ?? "");
    const payload = first && isRecord(first.payload) ? first.payload : undefined;
    return payload?.thread_source === "subagent";
  }

  parse(path: string): Omit<Metadata, "model"> | null {
    const lines = readLines(path);
    const meta = parseRecord(lines[0] ?? "");
    const payload = meta && isRecord(meta.payload) ? meta.payload : undefined;
    const id = payload && stringValue(payload.id);
    if (!meta || !payload || !id) return null;
    let first = "";
    for (const line of lines.slice(1, MAX_HEAD_LINES + 1)) {
      if (!line.includes("user")) continue;
      const record = parseRecord(line);
      const value = record?.payload;
      if (!isRecord(value)) continue;
      if (value.type === "user_message") first = stringValue(value.message).trim();
      else {
        const item = isRecord(value.item) ? value.item : value;
        if (item.role === "user") first = contentText(item.content);
      }
      if (first && !["<", "#", "⚠"].some((prefix) => first.startsWith(prefix))) break;
      first = "";
    }
    return {
      id,
      cwd: stringValue(payload.cwd) || "?",
      first_msg: first,
      birth: isoToEpoch(payload.timestamp) ?? isoToEpoch(meta.timestamp),
      upstream_name: "",
    };
  }

  loadNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const line of readLines(this.indexFile)) {
      const record = parseRecord(line), id = record && stringValue(record.id);
      if (!record || !id) continue;
      const name = stringValue(record.thread_name);
      if (name) names.set(id, name); else names.delete(id);
    }
    if (!existsSync(this.stateFile)) return names;
    let database: Database | undefined;
    try {
      database = new Database(this.stateFile, { readonly: true });
      const rows = database.query("SELECT id, title, first_user_message FROM threads").all() as Json[];
      for (const row of rows) {
        const id = stringValue(row.id), title = stringValue(row.title);
        if (!names.has(id) && title && title !== stringValue(row.first_user_message)) names.set(id, title);
      }
    } catch {} finally { database?.close(); }
    return names;
  }

  transcript(id: string): TranscriptMessage[] {
    return this.messages(id, (record) => {
      if (record.type !== "response_item" || !isRecord(record.payload) || record.payload.type !== "message") return;
      return record.payload;
    });
  }

  rename(): "local" { return "local"; }
}

class PiAdapter extends JsonlAdapter {
  readonly tool = "pi" as const;

  discover(): string[] {
    if (!existsSync(this.root)) return [];
    return [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: this.root, absolute: true, dot: true })];
  }

  parse(path: string): Omit<Metadata, "model"> | null {
    const lines = readLines(path), meta = parseRecord(lines[0] ?? ""), id = meta && stringValue(meta.id);
    if (!meta || meta.type !== "session" || !id) return null;
    let first = "";
    for (const line of lines.slice(1, MAX_HEAD_LINES + 1)) {
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

  transcript(id: string): TranscriptMessage[] {
    return this.messages(id, (record) => record.type === "message" && isRecord(record.message) ? record.message : undefined);
  }

  rename(id: string, name: string): "upstream" {
    const path = this.findFile(id);
    if (!path) throw new CatalogError("not_found", `找不到 pi session 文件: ${id}`);
    const text = readFileSync(path, "utf8"), newline = text.indexOf("\n");
    const meta = parseRecord(newline < 0 ? text : text.slice(0, newline));
    if (!meta) throw new CatalogError("invalid", `pi session metadata 无效: ${id}`);
    meta.name = name;
    const output = JSON.stringify(meta) + (newline < 0 ? "" : text.slice(newline));
    atomicWrite(path, output);
    return "upstream";
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
  private adapters: Adapter[];
  private marksFile: string;
  private metadata = new Map<string, { signature: string; value: Metadata | null }>();
  private index: { expires: number; rows: Session[] } | undefined;
  private now: () => Date;
  private rgPath: string | null | undefined;

  constructor(options: CatalogOptions = {}) {
    const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE;
    if (!home) throw new CatalogError("invalid", "无法确定用户目录");
    const claude = join(home, ".claude", "projects");
    const codex = join(home, ".codex");
    const pi = join(home, ".pi", "agent", "sessions");
    this.adapters = [
      new ClaudeAdapter(claude),
      new CodexAdapter(join(codex, "sessions"), join(codex, "session_index.jsonl"), join(codex, "state_5.sqlite")),
      new PiAdapter(pi),
    ];
    const dataDirectory = options.dataDirectory ?? userDataDirectory(home, options.environment, options.platform);
    this.marksFile = join(dataDirectory, "stars.json");
    this.now = options.now ?? (() => new Date());
    this.rgPath = options.rgPath;
  }

  async list(options: { fresh?: boolean; tool?: Tool } = {}): Promise<Session[]> {
    if (!options.fresh && !options.tool && this.index && this.index.expires > Date.now()) return structuredClone(this.index.rows);
    const rows = this.build(options.tool);
    if (!options.tool) this.index = { expires: Date.now() + INDEX_TTL_MS, rows };
    return structuredClone(rows);
  }

  async detail(id: string): Promise<Transcript> {
    const session = (await this.list({ fresh: true })).find((row) => row.id === id);
    if (!session) throw new CatalogError("not_found", `没有 session 匹配 '${id}'`);
    const adapter = this.adapters.find(({ tool }) => tool === session.tool)!;
    return { ...session, messages: adapter.transcript(id) };
  }

  async find(keyword: string, limit = 20): Promise<{ total: number; results: (Session & { snippet: string })[] }> {
    const rg = this.rgPath === undefined ? Bun.which("rg") : this.rgPath;
    if (!rg) throw new CatalogError("missing_rg", "需要 ripgrep (rg)，请安装并加入 PATH");
    const roots = this.adapters.map((adapter) => adapter.root).filter((root) => existsSync(root));
    const processResult = Bun.spawnSync([rg, "-l", "--no-messages", "--no-ignore", "--hidden", "--", keyword, ...roots]);
    if (processResult.exitCode > 1)
      throw new CatalogError("search_failed", processResult.stderr.toString().trim() || "ripgrep 搜索失败");
    const indexed = new Map((await this.list({ fresh: true })).map((session) => [session.id, session]));
    const hits: { session: Session; path: string; mtime: number }[] = [];
    const seen = new Set<string>();
    for (const path of processResult.stdout.toString().split(/\r?\n/).filter(Boolean)) {
      const adapter = this.adapters.find((candidate) => candidate.allowed(path));
      const metadata = adapter?.parse(path);
      const session = metadata && indexed.get(metadata.id);
      if (!session || seen.has(session.id)) continue;
      seen.add(session.id);
      hits.push({ session, path, mtime: statSync(path).mtimeMs });
    }
    const sorted = hits.sort((left, right) => right.mtime - left.mtime);
    const results = sorted.slice(0, limit).map(({ session, path }) => {
      const excerpt = Bun.spawnSync([rg, "-m1", "-o", "--no-ignore", "--hidden", `.{0,40}${escapeRegex(keyword)}.{0,60}`, path]);
      return { ...session, snippet: oneLine(excerpt.stdout.toString().trim().split(/\r?\n/)[0] ?? keyword, 100) };
    });
    return { total: sorted.length, results };
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
    const adapter = this.adapters.find(({ tool }) => tool === session.tool)!;
    if (adapter.rename(session.id, name.trim()) === "local") {
      const marks = this.loadMarks(), mark = marks[id] ?? { starred: false, note: "" };
      mark.starred ??= true;
      mark.name = name.trim();
      mark.added ??= added(this.now());
      marks[id] = mark;
      this.saveMarks(marks);
    }
    this.index = undefined;
  }

  private build(tool?: Tool): Session[] {
    const marks = this.loadMarks();
    const names = new Map(this.adapters.map((adapter) => [adapter.tool, adapter.loadNames()]));
    const files: Located[] = [];
    for (const adapter of this.adapters) if (!tool || adapter.tool === tool)
      for (const path of adapter.discover()) try { files.push({ adapter, path, stat: statSync(path) }); } catch {}
    files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    const live = new Set(files.map(({ adapter, path }) => `${adapter.tool}:${resolve(path)}`));
    const seen = new Set<string>(), rows: Session[] = [];
    for (const file of files) {
      if (file.stat.size < MIN_SIZE) continue;
      const metadata = this.cached(file);
      if (!metadata || seen.has(metadata.id)) continue;
      seen.add(metadata.id);
      const mark = marks[metadata.id];
      const upstream = metadata.upstream_name || names.get(file.adapter.tool)?.get(metadata.id) || "";
      rows.push({
        id: metadata.id,
        tool: file.adapter.tool,
        cwd: metadata.cwd,
        name: oneLine(mark?.name || upstream, 120),
        first_msg: oneLine(metadata.first_msg, 240),
        mtime: file.stat.mtimeMs / 1000,
        birth: metadata.birth ?? file.stat.mtimeMs / 1000,
        size_kb: Math.floor(file.stat.size / 1024),
        model: metadata.model,
        starred: isStarred(mark),
        star_note: mark?.note ?? "",
        archived: Boolean(mark?.archived),
        status: mark?.status ?? "",
      });
    }
    for (const key of this.metadata.keys()) if (!live.has(key)) this.metadata.delete(key);
    return rows;
  }

  private cached(file: Located): Metadata | null {
    const key = `${file.adapter.tool}:${resolve(file.path)}`;
    const raw = statSync(file.path, { bigint: true });
    const signature = `${raw.mtimeNs}:${raw.size}`;
    const previous = this.metadata.get(key);
    if (previous?.signature === signature) return previous.value;
    const parsed = file.adapter.parse(file.path);
    const value = parsed ? { ...parsed, model: tailModel(file.path, file.adapter.tool) } : null;
    this.metadata.set(key, { signature, value });
    return value;
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
    const session = (await this.list({ fresh: true })).find((row) => row.id === id);
    if (!session) throw new CatalogError("not_found", `没有 session 匹配 '${id}'`);
    return session;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
