import { sourceCopy } from "./sourceCopy.ts";

export const TOOLS = ["claude", "codex", "pi"] as const;
export type Tool = (typeof TOOLS)[number];

export const STATUSES = ["", "todo", "in progress", "review", "blocked", "done", "archived"] as const;
export type SessionStatus = (typeof STATUSES)[number];

export type PrimaryAction = { kind: "path" | "resume" | "fork"; value: string };
export type SourceDiagnostic = { source_id: string; root_id?: string; level: "info" | "error"; message: string; discovered?: number; valid?: number; skipped?: number };

export interface Session {
  id: string;
  tool: Tool;
  source_path: string;
  cwd: string;
  name: string;
  first_msg: string;
  mtime: number;
  birth: number;
  size_kb: number;
  model: string;
  thinking_level?: string;
  starred: boolean;
  star_note: string;
  archived: boolean;
  pinned?: boolean;
  status: SessionStatus;
  session_id?: string;
  source_id?: string;
  source_label?: string;
  source_scope?: string;
  source_kind?: "archive";
  root_id?: string;
  primary_action?: PrimaryAction;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface Transcript extends Session {
  messages: TranscriptMessage[];
}

export const EVENT_KINDS = ["user", "assistant", "thinking", "tool_call", "tool_output"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type MatchKind = EventKind | "meta";

export interface SessionEvent {
  /** Position in its thread's full event stream, 0-based; tool events take ordinals too. */
  ordinal: number;
  kind: EventKind;
  /** Clipped by excerpt(); `length` is set to the original length when it was. */
  text: string;
  length?: number;
  tool?: string;
  timestamp: string;
}

export interface SessionView extends Session {
  resume_command?: string;
}

export interface TranscriptView extends Transcript {
  resume_command?: string;
}

export interface SessionsEnvelope {
  generatedAt: string;
  home: string;
  sessions: SessionView[];
  diagnostics?: SourceDiagnostic[];
}

export const META_FIELDS = ["name", "star_note", "first_msg", "id", "session_id", "source_path"] as const;
export type MetaField = (typeof META_FIELDS)[number];
/** A hit in one of these means the Session was about the term, not that its id or path happens to contain it. */
export const TIER1_META: readonly MetaField[] = ["name", "star_note", "first_msg"];

export const emptyCounts = (): Record<MatchKind, number> => ({ user: 0, assistant: 0, thinking: 0, tool_call: 0, tool_output: 0, meta: 0 });

/** `thread` is "main" or a child thread id. */
export type SearchHit =
  | { kind: "meta"; field: MetaField; snippet: string }
  | { kind: EventKind; thread: string; ordinal: number; tool?: string; snippet: string };

export interface MatchSummary {
  /** 1: name/star_note/first_msg or a non-injected user message; 2: assistant only; 3: everything else. */
  tier: 1 | 2 | 3;
  /** Main thread events and meta fields; child threads are counted in `threads`. */
  counts: Record<MatchKind, number>;
  threads: { thread: string; label: string; hits: number }[];
  best: SearchHit[];
}

/**
 * Every candidate file lands in exactly one bucket: attributed to a result, or one of the counts below.
 * A candidate is a file with a raw hit, or an unreadable file, whose owner could still hold every term.
 */
export interface SearchCoverage {
  scanned_files: number;
  candidate_files: number;
  /** Raw hit, but no readable event in the file holds a term (padding, unprojected records). */
  unclassified_files: number;
  /** Some terms in readable events, but no readable event of the owner holds the rest. */
  partial_files: number;
  injected_only_files: number;
  /** ripgrep or the parser could not read the file; listed in `unreadable`. */
  unreadable_files: number;
  orphan_files: number;
  unreadable: string[];
  /** Most hits first. */
  orphans: { path: string; label: string; hits: number }[];
}

export interface SearchResult extends Session {
  /** The best hit's snippet; the dash deep-search list renders it. */
  snippet: string;
  match: MatchSummary;
}

export type SearchResultView = SearchResult & { resume_command?: string };

export interface SearchEnvelope {
  total: number;
  results: SearchResultView[];
  coverage: SearchCoverage;
}

type LineageEdgeBase = {
  upstream_id: string;
  downstream_id: string;
};

export type ArtifactLineageEdge = LineageEdgeBase & {
  relation: "artifact";
  path: string;
  produced_at: number;
  referenced_at: number;
  producer_turn: number;
  reference_turn: number;
  reference_source: "user";
  kind: "add" | "update";
};

export type ManualLineageEdge = LineageEdgeBase & {
  relation: "manual";
  created_at: number;
};

export type LineageEdge = ArtifactLineageEdge | ManualLineageEdge;

export interface LineageView {
  sessions: SessionView[];
  edges: LineageEdge[];
}

export interface LineageRefresh {
  sessions: number;
  scanned: number;
  unchanged: number;
  removed: number;
  writes: number;
  references: number;
  edges: number;
  elapsed_ms: number;
}

export interface MarkPatch {
  star?: boolean;
  note?: string;
  archive?: boolean;
  pin?: boolean;
  status?: SessionStatus;
}

export const isTool = (value: unknown): value is Tool =>
  typeof value === "string" && TOOLS.includes(value as Tool);

export const isStatus = (value: unknown): value is SessionStatus =>
  typeof value === "string" && STATUSES.includes(value as SessionStatus);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringFields = (value: Record<string, unknown>, fields: string[]) => fields.every((field) => typeof value[field] === "string");
const numberFields = (value: Record<string, unknown>, fields: string[]) => fields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]));

export function isSessionView(value: unknown): value is SessionView {
  if (!isRecord(value)) return false;
  const action = value.primary_action;
  const validAction = isRecord(action) && ["path", "resume", "fork"].includes(action.kind as string) && typeof action.value === "string";
  if (value.source_kind === "archive" && (!stringFields(value, ["session_id", "source_id", "source_label", "root_id"])
    || !validAction || action.kind === "resume" || value.resume_command !== undefined)) return false;
  return stringFields(value, ["id", "source_path", "cwd", "name", "first_msg", "model", "star_note"])
    && (typeof value.resume_command === "string" || validAction)
    && (value.resume_command === undefined || typeof value.resume_command === "string")
    && (action === undefined || validAction)
    && ["session_id", "source_id", "source_label", "source_scope", "root_id"].every((key) => value[key] === undefined || typeof value[key] === "string")
    && (value.source_kind === undefined || value.source_kind === "archive")
    && numberFields(value, ["mtime", "birth", "size_kb"])
    && isTool(value.tool) && isStatus(value.status)
    && typeof value.starred === "boolean" && typeof value.archived === "boolean"
    && (value.pinned === undefined || typeof value.pinned === "boolean");
}

export function parseSessionsEnvelope(value: unknown): SessionsEnvelope {
  if (!isRecord(value) || typeof value.generatedAt !== "string" || typeof value.home !== "string"
      || !Array.isArray(value.sessions) || !value.sessions.every(isSessionView))
    throw new Error("Session 列表响应无效");
  if (value.diagnostics !== undefined && (!Array.isArray(value.diagnostics) || !value.diagnostics.every((item) => isRecord(item) && stringFields(item, ["source_id", "message"]) && ["info", "error"].includes(item.level as string))))
    throw new Error(sourceCopy.errors.scanResponse);
  return value as unknown as SessionsEnvelope;
}

export function parseSearchEnvelope(value: unknown): SearchEnvelope {
  if (!isRecord(value) || !Number.isInteger(value.total) || (value.total as number) < 0
      || !Array.isArray(value.results) || !value.results.every((result) => isRecord(result)
        && isSessionView(result) && typeof result.snippet === "string" && isRecord(result.match) && [1, 2, 3].includes(result.match.tier as number))
      || !isRecord(value.coverage))
    throw new Error("Session 搜索响应无效");
  return value as unknown as SearchEnvelope;
}

export function parseTranscriptView(value: unknown): TranscriptView {
  if (!isSessionView(value) || !isRecord(value) || !Array.isArray(value.messages)
      || !value.messages.every((message) => isRecord(message)
        && (message.role === "user" || message.role === "assistant")
        && typeof message.text === "string" && typeof message.timestamp === "string"))
    throw new Error("Transcript 响应无效");
  return value as unknown as TranscriptView;
}

export function parseLineageView(value: unknown): LineageView {
  const edge = (item: unknown): boolean => isRecord(item) && stringFields(item, ["upstream_id", "downstream_id"])
    && (item.relation === "manual" ? numberFields(item, ["created_at"])
      : item.relation === "artifact" && stringFields(item, ["path", "reference_source", "kind"])
        && numberFields(item, ["produced_at", "referenced_at", "producer_turn", "reference_turn"])
        && item.reference_source === "user" && ["add", "update"].includes(item.kind as string));
  if (!isRecord(value) || !Array.isArray(value.sessions) || !value.sessions.every(isSessionView)
      || !Array.isArray(value.edges) || !value.edges.every(edge))
    throw new Error("Session 关系链响应无效");
  return value as unknown as LineageView;
}

export function parseLineageRefresh(value: unknown): LineageRefresh {
  if (!isRecord(value) || !numberFields(value, ["sessions", "scanned", "unchanged", "removed", "writes", "references", "edges", "elapsed_ms"]))
    throw new Error("Session 关系索引响应无效");
  return value as unknown as LineageRefresh;
}
