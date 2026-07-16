import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, normalize } from "node:path";
import type { LineageEdge, LineageRefresh, Session } from "./contracts.ts";

type Json = Record<string, unknown>;
type WriteKind = "add" | "update";
type TextInput = { text: string; at: number };
type Write = { path: string; at: number; turn: number; kind: WriteKind };
type Turn = { texts: TextInput[]; writes: Omit<Write, "turn">[] };
type Facts = { references: Reference[]; writes: Write[] };
type Reference = { session_id: string; path: string; at: number; turn: number; source: "user" };
const INDEX_VERSION = 3;
const AMBIENT_ARTIFACTS = new Set(["agents.md", "claude.md", "memory.md", "skill.md"]);

interface LineageGraph {
  session_ids: string[];
  edges: LineageEdge[];
}

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const epoch = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? fallback : parsed / 1000;
};
const isArtifact = (path: string): boolean =>
  /\.(?:md|html)$/i.test(path) && !AMBIENT_ARTIFACTS.has(basename(path).toLowerCase());

function parseLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return;
  }
}

function records(path: string): Json[] {
  return readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const record = parseLine(line);
    return record ? [record] : [];
  });
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

function injected(text: string): boolean {
  const value = text.trimStart();
  return [
    "# AGENTS.md instructions", "<environment_context", "<skill>", "<permissions",
    "<codex_internal_context", "<multi_agent", "<recommended_plugins", "<plugins_instructions",
    "<skills_instructions", "<collaboration_mode", "## Memory", "# Model Set Context",
    "You are `/root`", "You are /root", "Base directory for this skill:", "⚠", "PONYTAIL",
  ].some((prefix) => value.startsWith(prefix));
}

function artifactPaths(text: string): string[] {
  const found = text.match(/(?:\/[^\s"'<>|]+?|[a-z]:\\[^\s"'<>|]+?)\.(?:md|html)(?::\d+(?::\d+)?)?/giu) ?? [];
  return [...new Set(found.map((value) => normalize(value.replace(/:\d+(?::\d+)?$/, ""))).filter(isArtifact))];
}

function facts(session: Session): Facts {
  const parsed = records(session.source_path);
  const turns = session.tool === "codex"
    ? codexTurns(parsed, session.birth)
    : session.tool === "claude"
      ? claudeTurns(parsed, session.birth)
      : piTurns(parsed, session.birth);
  const effective = turns.filter((turn) => turn.texts.length > 0);
  const references = effective.slice(0, 2).flatMap((turn, turnIndex) => turn.texts.flatMap((input) =>
    artifactPaths(input.text).map((path) => ({
      session_id: session.id, path, at: input.at, turn: turnIndex, source: "user" as const,
    }))));
  const offset = Math.max(0, effective.length - 3);
  const writes = effective.slice(-3).flatMap((turn, index) => turn.writes.map((write) => ({
    ...write, turn: offset + index,
  })));
  return { references, writes };
}

function codexTurns(input: Json[], birth: number): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  const goalObjectives = new Set<string>();
  const hasUserEvents = input.some((record) => record.type === "event_msg"
    && isRecord(record.payload) && record.payload.type === "user_message");
  let current: Turn | undefined;
  const create = (id = ""): Turn => {
    if (id && byId.has(id)) return byId.get(id)!;
    const turn = { texts: [], writes: [] } satisfies Turn;
    turns.push(turn);
    if (id) byId.set(id, turn);
    current = turn;
    return turn;
  };

  input.forEach((record, line) => {
    const payload = isRecord(record.payload) ? record.payload : undefined;
    const at = epoch(record.timestamp, birth + line / 1_000_000);
    if (record.type === "event_msg" && payload?.type === "task_started") {
      create(stringValue(payload.turn_id));
      return;
    }
    if (record.type === "event_msg" && payload?.type === "thread_goal_updated" && isRecord(payload.goal)) {
      const text = stringValue(payload.goal.objective).trim();
      if (text && !goalObjectives.has(text)) {
        goalObjectives.add(text);
        create().texts.push({ text, at });
      }
      return;
    }
    if (record.type === "event_msg" && payload?.type === "user_message") {
      const text = stringValue(payload.message).trim();
      if (!text || injected(text)) return;
      const turn = current && current.texts.length === 0 ? current : create();
      turn.texts.push({ text, at });
      return;
    }
    if (!hasUserEvents && record.type === "response_item" && payload?.type === "message" && payload.role === "user") {
      const text = contentText(payload.content);
      if (text && !injected(text)) create().texts.push({ text, at });
      return;
    }
    if (record.type === "event_msg" && payload?.type === "patch_apply_end" && payload.success === true) {
      const turn = byId.get(stringValue(payload.turn_id)) ?? current;
      if (!turn || !isRecord(payload.changes)) return;
      for (const [path, change] of Object.entries(payload.changes)) {
        if (!isArtifact(path) || !isRecord(change)) continue;
        if (change.type !== "add" && change.type !== "update") continue;
        turn.writes.push({ path: normalize(path), at, kind: change.type });
      }
    }
  });
  return turns;
}

function claudeTurns(input: Json[], birth: number): Turn[] {
  const turns: Turn[] = [];
  const pending = new Map<string, { turn: Turn; path: string; kind: WriteKind }>();
  let current: Turn | undefined;
  input.forEach((record, line) => {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = message?.content;
    const at = epoch(record.timestamp, birth + line / 1_000_000);
    if (message?.role === "user" && !(Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "tool_result"))) {
      const text = contentText(content);
      if (text && !injected(text)) {
        current = { texts: [{ text, at }], writes: [] };
        turns.push(current);
      }
    }
    if (message?.role === "assistant" && Array.isArray(content) && current) {
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_use" || !isRecord(part.input)) continue;
        const name = stringValue(part.name).toLowerCase();
        const path = stringValue(part.input.file_path || part.input.path);
        if (["write", "edit"].includes(name) && isArtifact(path))
          pending.set(stringValue(part.id), { turn: current, path: normalize(path), kind: name === "edit" ? "update" : "add" });
      }
    }
    if (message?.role === "user" && Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_result" || part.is_error === true) continue;
        const call = pending.get(stringValue(part.tool_use_id));
        if (call) call.turn.writes.push({ path: call.path, at, kind: call.kind });
      }
      if (isRecord(record.toolUseResult)) {
        const path = stringValue(record.toolUseResult.filePath);
        const call = [...pending.values()].find((value) => value.path === normalize(path));
        if (call && !call.turn.writes.some((write) => write.path === call.path))
          call.turn.writes.push({ path: call.path, at, kind: record.toolUseResult.type === "create" ? "add" : call.kind });
      }
    }
  });
  return turns;
}

function piTurns(input: Json[], birth: number): Turn[] {
  const turns: Turn[] = [];
  const pending = new Map<string, { turn: Turn; path: string; kind: WriteKind }>();
  let current: Turn | undefined;
  input.forEach((record, line) => {
    if (record.type !== "message" || !isRecord(record.message)) return;
    const message = record.message;
    const content = message.content;
    const at = epoch(record.timestamp, birth + line / 1_000_000);
    if (message.role === "user") {
      const text = contentText(content);
      if (text && !injected(text)) {
        current = { texts: [{ text, at }], writes: [] };
        turns.push(current);
      }
    }
    if (message.role === "assistant" && Array.isArray(content) && current) {
      for (const part of content) {
        if (!isRecord(part) || part.type !== "toolCall" || !isRecord(part.arguments)) continue;
        const name = stringValue(part.name).toLowerCase();
        const path = stringValue(part.arguments.path || part.arguments.file_path);
        if (["write", "edit"].includes(name) && isArtifact(path))
          pending.set(stringValue(part.id), { turn: current, path: normalize(path), kind: name === "edit" ? "update" : "add" });
      }
    }
    if (message.role === "toolResult" && message.isError !== true) {
      const call = pending.get(stringValue(message.toolCallId));
      if (call) call.turn.writes.push({ path: call.path, at, kind: call.kind });
    }
  });
  return turns;
}

export class LineageIndex {
  constructor(private readonly path: string) {}

  refresh(sessions: Session[], force = false): LineageRefresh {
    const started = performance.now();
    const db = this.open();
    try {
      const prior = new Map((db.query("SELECT session_id, signature FROM lineage_scans").all() as { session_id: string; signature: string }[])
        .map((row) => [row.session_id, row.signature]));
      const ids = new Set(sessions.map((session) => session.id));
      const removed = [...prior.keys()].filter((id) => !ids.has(id));
      const changed = sessions.flatMap((session) => {
        const stat = statSync(session.source_path);
        const signature = `${INDEX_VERSION}:${session.tool}:${session.source_path}:${stat.size}:${stat.mtimeMs}`;
        return force || prior.get(session.id) !== signature ? [{ session, signature, facts: facts(session) }] : [];
      });
      const transaction = db.transaction(() => {
        for (const id of [...removed, ...changed.map((item) => item.session.id)]) {
          db.query("DELETE FROM lineage_writes WHERE session_id = ?").run(id);
          db.query("DELETE FROM lineage_references WHERE session_id = ?").run(id);
          db.query("DELETE FROM lineage_scans WHERE session_id = ?").run(id);
        }
        for (const item of changed) {
          db.query("INSERT INTO lineage_scans VALUES (?, ?, ?)").run(item.session.id, item.session.source_path, item.signature);
          for (const write of item.facts.writes)
            db.query("INSERT INTO lineage_writes VALUES (?, ?, ?, ?, ?)").run(item.session.id, write.path, write.at, write.turn, write.kind);
          for (const reference of item.facts.references)
            db.query("INSERT INTO lineage_references VALUES (?, ?, ?, ?, ?)").run(reference.session_id, reference.path, reference.at, reference.turn, reference.source);
        }
        // ponytail: 全量重建关系边；仅在事实量导致刷新可测变慢时改为按受影响路径重建。
        db.run("DELETE FROM lineage_edges");
        const references = db.query("SELECT * FROM lineage_references ORDER BY at, session_id, path").all() as Reference[];
        const inserted = new Set<string>();
        for (const reference of references) {
          const writer = db.query(`SELECT session_id, path, at, turn, kind FROM lineage_writes
            WHERE path = ? AND session_id != ? AND at < ? ORDER BY at DESC, session_id DESC LIMIT 1`)
            .get(reference.path, reference.session_id, reference.at) as { session_id: string; path: string; at: number; turn: number; kind: WriteKind } | null;
          const key = writer ? `${writer.session_id}\0${reference.session_id}\0${reference.path}` : "";
          if (writer && !inserted.has(key)) {
            inserted.add(key);
            db.query("INSERT INTO lineage_edges VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(writer.session_id, reference.session_id, reference.path, writer.at, reference.at, writer.turn, reference.turn, reference.source, writer.kind);
          }
        }
      });
      transaction();
      const count = (table: string): number => (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      return {
        sessions: sessions.length, scanned: changed.length, unchanged: sessions.length - changed.length,
        removed: removed.length, writes: count("lineage_writes"), references: count("lineage_references"),
        edges: count("lineage_edges"), elapsed_ms: Math.round(performance.now() - started),
      };
    } finally {
      db.close();
    }
  }

  lineage(sessionId: string): LineageGraph {
    const db = this.open();
    try {
      const all = db.query("SELECT * FROM lineage_edges ORDER BY referenced_at, upstream_id, downstream_id, path").all() as LineageEdge[];
      const visited = new Set([sessionId]);
      for (const id of visited) for (const edge of all) {
        if (edge.upstream_id === id) visited.add(edge.downstream_id);
        if (edge.downstream_id === id) visited.add(edge.upstream_id);
      }
      return {
        session_ids: [...visited].sort(),
        edges: all.filter((edge) => visited.has(edge.upstream_id) && visited.has(edge.downstream_id)),
      };
    } finally {
      db.close();
    }
  }

  all(): LineageGraph {
    const db = this.open();
    try {
      const edges = db.query("SELECT * FROM lineage_edges ORDER BY referenced_at, upstream_id, downstream_id, path").all() as LineageEdge[];
      return {
        session_ids: [...new Set(edges.flatMap((edge) => [edge.upstream_id, edge.downstream_id]))].sort(),
        edges,
      };
    } finally {
      db.close();
    }
  }

  private open(): Database {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run(`CREATE TABLE IF NOT EXISTS lineage_scans (session_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lineage_writes (session_id TEXT NOT NULL, path TEXT NOT NULL, at REAL NOT NULL, turn INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lineage_writes_path_at ON lineage_writes(path, at);
      CREATE TABLE IF NOT EXISTS lineage_references (session_id TEXT NOT NULL, path TEXT NOT NULL, at REAL NOT NULL, turn INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lineage_references_path_at ON lineage_references(path, at);
      CREATE TABLE IF NOT EXISTS lineage_edges (upstream_id TEXT NOT NULL, downstream_id TEXT NOT NULL, path TEXT NOT NULL,
        produced_at REAL NOT NULL, referenced_at REAL NOT NULL, producer_turn INTEGER NOT NULL, reference_turn INTEGER NOT NULL,
        reference_source TEXT NOT NULL, kind TEXT NOT NULL);`);
    return db;
  }
}
