import type { Tool } from "./contracts.ts";

type ResumeInput = { tool: Tool; id: string; cwd: string; model?: string };

function rejectNul(values: string[]): void {
  if (values.some((value) => value.includes("\0"))) throw new Error("resume command values cannot contain NUL");
}

function posix(value: string): string {
  if (!value) return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

const powershell = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function args({ tool, id, model = "" }: ResumeInput): string[] {
  if (tool === "codex") return ["codex", "resume", id, ...(model ? ["-m", model] : [])];
  if (tool === "pi") return ["pi", "--session", id, ...(model ? ["--model", model] : [])];
  return ["claude", "-r", id, ...(model ? ["--model", model] : [])];
}

export function formatResumeCommand(input: ResumeInput, platform: NodeJS.Platform = process.platform): string {
  const command = args(input);
  rejectNul([input.cwd, ...command]);
  if (platform === "win32")
    return `Set-Location -LiteralPath ${powershell(input.cwd)}; if ($?) { & ${command.map(powershell).join(" ")} }`;
  return `cd -- ${posix(input.cwd)} && ${command.map(posix).join(" ")}`;
}

export function withResumeCommand<T extends ResumeInput>(input: T, platform: NodeJS.Platform = process.platform): T & { resume_command: string } {
  return { ...input, resume_command: formatResumeCommand(input, platform) };
}
