import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PrimaryAction, Tool } from "./contracts.ts";
import { contained, cwdMappingSuffix, type ArchiveSource } from "./sources.ts";

type ResumeInput = { tool: Tool; id: string; session_id?: string; cwd: string; model?: string; thinking_level?: string; primary_action?: PrimaryAction };

function rejectNul(values: string[]): void {
  if (values.some((value) => value.includes("\0"))) throw new Error("resume command values cannot contain NUL");
}

function posix(value: string): string {
  if (!value) return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

const powershell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function args({ tool, id, session_id, model = "", thinking_level = "" }: ResumeInput): string[] {
  id = session_id ?? id;
  if (tool === "codex") return ["codex", "resume", id, ...(model ? ["-m", model] : []), ...(thinking_level ? ["-c", `model_reasoning_effort=${JSON.stringify(thinking_level)}`] : [])];
  if (tool === "pi") return ["pi", "--session", id, ...(model ? ["--model", model] : [])];
  return ["claude", "-r", id, ...(model ? ["--model", model] : []), ...(thinking_level ? ["--effort", thinking_level] : [])];
}

export function formatResumeCommand(input: ResumeInput, platform: NodeJS.Platform = process.platform): string {
  const command = args(input);
  rejectNul([input.cwd, ...command]);
  if (platform === "win32")
    return `Set-Location -LiteralPath ${powershell(input.cwd)}; if ($?) { & ${command.map(powershell).join(" ")} }`;
  return `cd -- ${posix(input.cwd)} && ${command.map(posix).join(" ")}`;
}

export function primaryAction(input: ResumeInput, platform: NodeJS.Platform = process.platform): PrimaryAction {
  return input.primary_action ?? { kind: "resume", value: formatResumeCommand(input, platform) };
}

export function withResumeCommand<T extends ResumeInput>(input: T, platform: NodeJS.Platform = process.platform): T & { resume_command?: string } {
  return input.primary_action ? { ...input } : { ...input, resume_command: formatResumeCommand(input, platform) };
}

export function archiveAction(input: { tool: Tool; cwd: string; path: string }, source: ArchiveSource, archiveRoots: string[], livePi: string, platform: NodeJS.Platform): PrimaryAction {
  const fallback: PrimaryAction = { kind: "path", value: input.path };
  if (input.tool !== "pi" || !source.continuationDirectory) return fallback;
  const mapping = source.cwdMappings.map((mapping) => ({ ...mapping, suffix: cwdMappingSuffix(mapping.from, input.cwd) }))
    .filter((mapping) => mapping.suffix !== undefined).sort((a, b) => b.from.length - a.from.length)[0];
  if (!mapping) return fallback;
  try {
    const cwd = realpathSync(join(mapping.to, mapping.suffix!));
    const continuation = realpathSync(source.continuationDirectory);
    if (!statSync(cwd).isDirectory() || !statSync(continuation).isDirectory()) return fallback;
    accessSync(continuation, constants.W_OK);
    for (const root of [...archiveRoots, livePi]) {
      let realRoot = root;
      try { realRoot = realpathSync(root); } catch {}
      if (contained(realRoot, continuation)) return fallback;
    }
    const command = ["pi", "--fork", input.path, "--session-dir", continuation];
    rejectNul([cwd, ...command]);
    return { kind: "fork", value: platform === "win32"
      ? `Set-Location -LiteralPath ${powershell(cwd)}; if ($?) { & ${command.map(powershell).join(" ")} }`
      : `cd -- ${posix(cwd)} && ${command.map(posix).join(" ")}` };
  } catch { return fallback; }
}
