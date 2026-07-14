export const TOOLS = ["claude", "codex", "pi"] as const;
export type Tool = (typeof TOOLS)[number];

export const STATUSES = ["", "todo", "in progress", "review", "blocked", "done", "archived"] as const;
export type SessionStatus = (typeof STATUSES)[number];

export interface Session {
  id: string;
  tool: Tool;
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
  sessions: SessionView[];
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
