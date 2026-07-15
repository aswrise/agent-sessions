export const TOOLS = ["claude", "codex", "pi"] as const;
export type Tool = (typeof TOOLS)[number];

export const STATUSES = ["", "todo", "in progress", "review", "blocked", "done", "archived"] as const;
export type SessionStatus = (typeof STATUSES)[number];

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
  starred: boolean;
  star_note: string;
  archived: boolean;
  status: SessionStatus;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface Transcript extends Session {
  messages: TranscriptMessage[];
}

export interface SessionView extends Session {
  resume_command: string;
}

export interface TranscriptView extends Transcript {
  resume_command: string;
}

export interface SessionsEnvelope {
  generatedAt: string;
  home: string;
  sessions: SessionView[];
}

export interface SearchHitView extends SessionView {
  snippet: string;
}

export interface SearchEnvelope {
  total: number;
  results: SearchHitView[];
}

export interface MarkPatch {
  star?: boolean;
  note?: string;
  archive?: boolean;
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
  return stringFields(value, ["id", "source_path", "cwd", "name", "first_msg", "model", "star_note", "resume_command"])
    && numberFields(value, ["mtime", "birth", "size_kb"])
    && isTool(value.tool) && isStatus(value.status)
    && typeof value.starred === "boolean" && typeof value.archived === "boolean";
}

export function parseSessionsEnvelope(value: unknown): SessionsEnvelope {
  if (!isRecord(value) || typeof value.generatedAt !== "string" || typeof value.home !== "string"
      || !Array.isArray(value.sessions) || !value.sessions.every(isSessionView))
    throw new Error("Session 列表响应无效");
  return value as unknown as SessionsEnvelope;
}

export function parseSearchEnvelope(value: unknown): SearchEnvelope {
  if (!isRecord(value) || !Number.isInteger(value.total) || (value.total as number) < 0
      || !Array.isArray(value.results) || !value.results.every((result) => isRecord(result)
        && isSessionView(result) && typeof result.snippet === "string"))
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
