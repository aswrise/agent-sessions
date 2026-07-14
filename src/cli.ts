#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CatalogError, SessionCatalog } from "./catalog.ts";
import { isTool, type Session, type Tool } from "./contracts.ts";
import { formatResumeCommand } from "./resume.ts";
import { serveResident, startDashboard, stopDashboard } from "./lifecycle.ts";
import { userDataDirectory } from "./paths.ts";

const VERSION = "1.0.0";
const HELP = `Agent Sessions

Usage:
  sessions                         print the active-session snapshot
  sessions list [-n 20] [claude|codex|pi]
  sessions find <keyword> [-n 20]
  sessions star <id-prefix> [note]
  sessions unstar <id-prefix>
  sessions stars
  sessions dash [--no-open]
  sessions dash --stop
`;

function home(): string {
  const value = process.env.HOME ?? process.env.USERPROFILE;
  if (!value) throw new Error("无法确定用户目录");
  return value;
}

function stamp(epoch: number): string {
  const date = new Date(epoch * 1000), pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function printEntry(row: Session, snippet?: string): void {
  console.log(`${row.starred ? "★" : " "} [${stamp(row.mtime)}] ${row.tool.padEnd(6)} ${row.cwd}`);
  console.log(`    ${snippet ?? (row.name || row.first_msg)}`);
  console.log(`    ↳ ${formatResumeCommand(row)}\n`);
}

function limit(args: string[]): number {
  const index = args.indexOf("-n");
  if (index < 0) return 20;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error("-n 必须是正整数");
  args.splice(index, 2); return value;
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
    if (["-h", "--help"].includes(args[0]!)) { console.log(HELP); return 0; }
    if (args[0] === "--version") { console.log(`sessions ${VERSION}`); return 0; }
    if (args[0] === "_serve") {
      await serveResident({ port: Number(internal(args, "--port")), nonce: internal(args, "--nonce"), stateFile: internal(args, "--state"), ...(options.html === undefined ? {} : { html: options.html }) });
      return 0;
    }
    const n = limit(args), command = args.shift(), catalog = new SessionCatalog({ home: home() });
    if (command === "list") {
      const rawTool = args[0]; if (rawTool && !isTool(rawTool)) throw new Error(`未知工具: ${rawTool}`);
      const tool: Tool | undefined = rawTool && isTool(rawTool) ? rawTool : undefined;
      const rows = await catalog.list({ fresh: true, ...(tool ? { tool } : {}) });
      rows.filter((row) => !row.archived).slice(0, n).forEach((row) => printEntry(row));
      return 0;
    }
    if (command === "find" && args.length) {
      const results = await catalog.find(args.join(" "), n);
      if (!results.length) { console.log("没有匹配的 session"); return 0; }
      console.log(`共 ${results.length} 个匹配 session，显示最近 ${results.length} 个：\n`);
      results.forEach((row) => printEntry(row, row.snippet)); return 0;
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
