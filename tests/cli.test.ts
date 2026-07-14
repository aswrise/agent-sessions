import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureHome } from "./fixture-home.ts";
import packageJson from "../package.json" with { type: "json" };

const cleanups: (() => void)[] = [];
const executable = fileURLToPath(new URL("../sessions", import.meta.url));
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function run(home: string, args: string[], path = process.env.PATH ?? "") {
  const result = Bun.spawnSync([process.execPath, executable, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path, NO_COLOR: "1" },
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
      : "cd -- /tmp/beta && codex resume codex-b -m gpt-fixture");
    expect(listed.stdout).not.toContain("pi-c");

    const found = await command(["find", "fixture", "-n", "10"]);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain("共 3 个匹配 session");
    expect(found.stdout).not.toContain("codex-child");
  });

  test("preserves marks, archive hiding, help, snapshot, and failures", async () => {
    const help = await command(["--help"]); expect(help.stdout).toContain("sessions dash --stop");
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
