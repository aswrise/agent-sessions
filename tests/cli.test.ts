import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureHome } from "./fixture-home.ts";
import packageJson from "../package.json" with { type: "json" };

const cleanups: (() => void)[] = [];
const executable = fileURLToPath(new URL("../sessions", import.meta.url));
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function run(home: string, args: string[], path = process.env.PATH ?? "", env: Record<string, string> = {}) {
  const { CLAUDE_CODE_SESSION_ID: _, ...inherited } = process.env;
  const result = Bun.spawnSync([process.execPath, executable, ...args], {
    env: { ...inherited, HOME: home, USERPROFILE: home, PATH: path, NO_COLOR: "1", ...env },
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function command(args: string[], path = process.env.PATH ?? "") {
  const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
  return { fixture, ...run(fixture.home, args, path) };
}

describe("CLI process seam", () => {
  test("lists, finds, and prints safe resume commands", async () => {
    const listed = await command(["list", "-n", "2"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("codex-b");
    expect(listed.stdout).toContain(process.platform === "win32"
      ? "Set-Location -LiteralPath '/tmp/beta'; if ($?) { & 'codex' 'resume' 'codex-b' '-m' 'gpt-fixture' }"
      : "cd -- /tmp/beta && codex resume codex-b -m gpt-fixture -c 'model_reasoning_effort=\"high\"'");
    expect(listed.stdout).not.toContain("pi-c");

    const found = await command(["find", "fixture", "-n", "10"]);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain("共 3 个匹配 session");
    const lines = found.stdout.split("\n");
    expect(lines.filter((line) => /^[★ ] \S/.test(line)).map((line) => line.split(" ")[1])).toEqual(["pi-c", "codex-b", "claude-a"]);
    expect(lines.filter((line) => line.startsWith("孤儿")).join("\n")).toContain("rollout-subagent.jsonl");
  });

  test("finds by AND terms with filters, leaves out the calling Session, and reads windows", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const ids = (stdout: string) => stdout.split("\n").filter((line) => /^[★ ] \S/.test(line)).map((line) => line.split(" ")[1]);
    expect(ids(run(fixture.home, ["find", "fixture-user-claude", "fixture-child-output"]).stdout)).toEqual(["claude-a"]);
    expect(ids(run(fixture.home, ["find", "fixture", "--tool", "codex,pi", "--cwd", "/tmp/beta"]).stdout)).toEqual(["codex-b"]);
    expect(ids(run(fixture.home, ["find", "fixture"], undefined, { CLAUDE_CODE_SESSION_ID: "pi-c" }).stdout)).toEqual(["codex-b", "claude-a"]);
    expect(ids(run(fixture.home, ["find", "fixture", "--self"], undefined, { CLAUDE_CODE_SESSION_ID: "pi-c" }).stdout)).toEqual(["pi-c", "codex-b", "claude-a"]);
    const json = JSON.parse(run(fixture.home, ["find", "fixture-child-output", "--json"]).stdout);
    expect(json).toMatchObject({ total: 1, results: [{ id: "claude-a", resume_command: expect.any(String), match: { tier: 3, threads: [{ thread: "sub1" }] } }], coverage: { orphan_files: 0 } });

    const windows = run(fixture.home, ["show", "claude", "fixture-child-output", "-C", "0"]);
    expect(windows.exitCode).toBe(0);
    expect(windows.stdout).toContain("── sub1 (Find launch agent) #2-2");
    expect(windows.stdout).toContain("#2 out  0 fixture-child-output");
    expect(windows.stdout).not.toContain("fixture-assistant-claude");
    const at = run(fixture.home, ["show", "claude", "--at", "sub1:1", "--json"]);
    expect(JSON.parse(at.stdout).windows).toEqual([expect.objectContaining({ thread: "sub1", from: 1, to: 1,
      events: [expect.objectContaining({ ordinal: 1, kind: "tool_call", tool: "Bash" })] })]);
    expect(run(fixture.home, ["show", "claude", "--at", "nope:1"]).exitCode).toBe(1);
  });

  test("reads bare --since and --until dates as whole local days", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    // codex-b starts at 2026-07-14T02:00Z, 10:00 on 07-14 in Shanghai and 22:00 on 07-13 in New York.
    const ids = (zone: string, args: string[]) => run(fixture.home, ["find", "fixture-user-codex", ...args], undefined, { TZ: zone }).stdout
      .split("\n").filter((line) => /^[★ ] \S/.test(line)).map((line) => line.split(" ")[1]);
    expect(ids("Asia/Shanghai", ["--until", "2026-07-14"])).toEqual(["codex-b"]);
    expect(ids("Asia/Shanghai", ["--until", "2026-07-13"])).toEqual([]);
    expect(ids("America/New_York", ["--until", "2026-07-13"])).toEqual(["codex-b"]);
  });

  test("lists files it could not read after the results", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const offloaded = join(fixture.home, ".claude/projects/-tmp-alpha/claude-a/tool-results/toolu_big.txt");
    chmodSync(offloaded, 0o000);
    try {
      const found = run(fixture.home, ["find", "fixture-offloaded-result"]);
      expect(found.exitCode).toBe(0);
      expect(found.stdout.split("\n")).toContain(`不可读 ${offloaded}`);
    } finally { chmodSync(offloaded, 0o644); }
  });

  test("keeps stderr free of source statistics unless -v, and prints help anywhere", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const sources = join(fixture.home, "sources.json");
    writeFileSync(sources, JSON.stringify({ version: 1, sources: [{ id: "old", label: "old", roots: [{ id: "claude", tool: "claude", path: join(fixture.home, ".claude/projects") }] }] }));
    const env = { AGENT_SESSIONS_SOURCES_FILE: sources };
    const quiet = run(fixture.home, ["find", "fixture"], undefined, env);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stderr).toBe("");
    expect(run(fixture.home, ["find", "fixture", "-v"], undefined, env).stderr).toContain("[old/claude]");
    const help = run(fixture.home, ["find", "fixture", "--help"]);
    expect(help.stdout).toContain("sessions show <id-prefix> --at");
    expect(help.stdout).not.toContain("共");
  });

  test("provides stable JSON list, find, and show output for terminal agents", async () => {
    const listed = await command(["list", "-n", "2", "--json"]);
    expect(listed.exitCode).toBe(0);
    const listValue = JSON.parse(listed.stdout);
    expect(listValue.sessions).toHaveLength(2);
    expect(listValue.sessions[0]).toMatchObject({ id: "codex-b", resume_command: "cd -- /tmp/beta && codex resume codex-b -m gpt-fixture -c 'model_reasoning_effort=\"high\"'" });

    const found = await command(["find", "FIXTURE-ASSISTANT-CODEX", "--json"]);
    expect(found.exitCode).toBe(0);
    const findValue = JSON.parse(found.stdout);
    expect(findValue).toMatchObject({ total: 1, results: [{ id: "codex-b", snippet: "fixture-assistant-codex" }] });

    const shown = await command(["show", "claude-", "--json"]);
    expect(shown.exitCode).toBe(0);
    const showValue = JSON.parse(shown.stdout);
    expect(showValue).toMatchObject({ id: "claude-a", resume_command: "cd -- '/tmp/alpha project' && claude -r claude-a --model claude-fixture --effort medium" });
    expect(showValue.messages.map(({ text }: { text: string }) => text)).toEqual(["fixture-user-claude", "fixture-assistant-claude"]);

    const readable = await command(["show", "codex-"]);
    expect(readable.stdout).toContain("[user] fixture-user-codex");
    expect(readable.stdout).toContain("[assistant] fixture-assistant-codex");

    const indexed = await command(["index", "--json"]);
    expect(indexed.exitCode).toBe(0);
    expect(JSON.parse(indexed.stdout)).toMatchObject({ sessions: 3, scanned: 3, edges: 0 });
    const lineage = await command(["lineage", "codex-", "--json"]);
    expect(lineage.exitCode).toBe(0);
    expect(JSON.parse(lineage.stdout)).toMatchObject({ sessions: [{ id: "codex-b" }], edges: [] });
  });

  test("preserves marks, archive hiding, help, snapshot, and failures", async () => {
    const help = await command(["--help"]); expect(help.stdout).toContain("sessions show <id-prefix> [--json]");
    const version = await command(["--version"]); expect(version.stdout.trim()).toBe(`sessions ${packageJson.version}`);
    const missing = await command(["find", "fixture"], "/missing");
    expect(missing.exitCode).toBe(1); expect(missing.stderr).toContain("需要 ripgrep (rg)");
    const invalid = await command(["unknown"]); expect(invalid.exitCode).toBe(1); expect(invalid.stderr).toContain("Usage:");

    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    expect(run(fixture.home, ["star", "claude", "kept"]).stdout).toContain("★ claude-a  (kept)");
    expect(run(fixture.home, ["stars"]).stdout).toContain("claude-a");
    expect(run(fixture.home, ["unstar", "claude"]).stdout).toContain("已取消 claude-a");
    const remaining = run(fixture.home, ["stars"]).stdout;
    expect(remaining).not.toContain("claude-a"); expect(remaining).toContain("pi-c");
    const ambiguous = run(fixture.home, ["star", "c"]);
    expect(ambiguous.exitCode).toBe(1); expect(ambiguous.stderr).toContain("匹配到 2 个 session");

    const marks = join(fixture.home, ".local/share/session-snapshots/stars.json");
    writeFileSync(marks, JSON.stringify({ "pi-c": { archived: true } }));
    expect(run(fixture.home, ["list"]).stdout).not.toContain("pi-c");

    const snapshot = join(fixture.home, ".local/share/session-snapshots/last-active.txt");
    mkdirSync(join(fixture.home, ".local/share/session-snapshots"), { recursive: true }); writeFileSync(snapshot, "fixture snapshot");
    expect(run(fixture.home, []).stdout.trim()).toBe("fixture snapshot");
  });
});
