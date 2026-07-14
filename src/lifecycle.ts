import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { SessionCatalog } from "./catalog.ts";
import { startServer } from "./server.ts";

export type DashboardState = { pid: number; port: number; nonce: string };
type StartOptions = {
  stateDir?: string;
  port?: number;
  open?: boolean;
  command?: string[];
  env?: Record<string, string | undefined>;
};

export function platformStateDirectory(env = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "agent-sessions");
  if (platform === "darwin") return join(home, "Library", "Application Support", "agent-sessions");
  return join(env.XDG_STATE_HOME || env.XDG_DATA_HOME || join(home, ".local", "state"), "agent-sessions");
}

export const dashboardStateFile = (stateDir = platformStateDirectory()): string => join(stateDir, "dashboard.json");

function validState(value: unknown): value is DashboardState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Number.isInteger(state.pid) && Number(state.pid) > 0 && Number.isInteger(state.port) && Number(state.port) > 0 && Number(state.port) < 65_536
    && typeof state.nonce === "string" && /^[0-9a-f-]{36}$/.test(state.nonce);
}

function readState(file: string): DashboardState | undefined {
  try { const value: unknown = JSON.parse(readFileSync(file, "utf8")); return validState(value) ? value : undefined; } catch { return; }
}

function writeState(file: string, state: DashboardState): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, file);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function healthy(state: DashboardState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health?nonce=${state.nonce}`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return typeof value === "object" && value !== null && (value as Record<string, unknown>).ok === true && (value as Record<string, unknown>).nonce === state.nonce;
  } catch { return false; }
}

async function portOccupied(port: number): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/health?nonce=${crypto.randomUUID()}`, { signal: AbortSignal.timeout(500) }); return true; }
  catch { return false; }
}

function defaultCommand(): string[] {
  return /^bun(?:\.exe)?$/.test(basename(process.execPath)) ? [process.execPath, import.meta.path.replace("lifecycle.ts", "cli.ts")] : [process.execPath];
}

async function openBrowser(url: string): Promise<void> {
  const wsl = Boolean(process.env.WSL_DISTRO_NAME) || (process.platform === "linux" && readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft"));
  const executable = process.platform === "win32" || wsl ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const path = Bun.which(executable);
  if (!path) { console.log(url); return; }
  try { const child = Bun.spawn([path, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref(); }
  catch { console.log(url); }
}

export async function startDashboard(options: StartOptions = {}): Promise<DashboardState & { url: string; reused: boolean }> {
  const stateDir = options.stateDir ?? platformStateDirectory(options.env);
  const file = dashboardStateFile(stateDir), previous = readState(file);
  if (previous) {
    if (await healthy(previous)) {
      const url = `http://127.0.0.1:${previous.port}/`;
      if (options.open !== false) await openBrowser(url);
      return { ...previous, url, reused: true };
    }
    if (alive(previous.pid)) throw new Error("dashboard 进程仍存活但健康校验失败；拒绝终止未验证进程");
    rmSync(file, { force: true });
  } else if (existsSync(file)) rmSync(file, { force: true });

  const port = options.port ?? 7867;
  if (await portOccupied(port)) throw new Error(`端口 ${port} 已被其他进程占用`);
  const nonce = crypto.randomUUID(), command = options.command ?? defaultCommand();
  const child = Bun.spawn([...command, "_serve", "--port", String(port), "--nonce", nonce, "--state", file], {
    env: options.env ?? process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  child.unref();
  const expected = { pid: child.pid, port, nonce };
  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(100);
    const state = readState(file);
    if (state?.pid === expected.pid && state.nonce === nonce && await healthy(state)) {
      const url = `http://127.0.0.1:${state.port}/`;
      if (options.open !== false) await openBrowser(url);
      return { ...state, url, reused: false };
    }
    if (!alive(child.pid)) break;
  }
  if (alive(child.pid)) process.kill(child.pid, "SIGTERM");
  throw new Error("dashboard 启动失败");
}

export async function stopDashboard(options: { stateDir?: string } = {}): Promise<boolean> {
  const file = dashboardStateFile(options.stateDir), state = readState(file);
  if (!state) { rmSync(file, { force: true }); return false; }
  if (!alive(state.pid)) { rmSync(file, { force: true }); return false; }
  if (!await healthy(state)) throw new Error("dashboard 进程仍存活但健康校验失败；拒绝终止未验证进程");
  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 30 && alive(state.pid); attempt++) await Bun.sleep(100);
  if (alive(state.pid)) throw new Error("dashboard 未能正常停止");
  rmSync(file, { force: true });
  return true;
}

export async function serveResident(options: { port: number; nonce: string; stateFile: string; html?: string }): Promise<void> {
  const catalog = new SessionCatalog();
  const server = startServer({ catalog, port: options.port, nonce: options.nonce, ...(options.html === undefined ? {} : { html: options.html }) });
  const state: DashboardState = { pid: process.pid, port: server.port!, nonce: options.nonce };
  writeState(options.stateFile, state);
  const shutdown = () => {
    server.stop(true);
    const current = readState(options.stateFile);
    if (current?.pid === process.pid && current.nonce === options.nonce) rmSync(options.stateFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  await new Promise(() => {});
}
