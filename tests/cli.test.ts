import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { fixtureHome } from "./fixture-home.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function command(args: string[], path = process.env.PATH ?? "") {
  const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
  const result = Bun.spawnSync([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
    env: { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home, PATH: path, NO_COLOR: "1" },
  });
  return { fixture, exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("CLI process seam", () => {
  test("lists, finds, and prints safe resume commands", async () => {
    const listed = await command(["list", "-n", "2"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("codex-b");
    expect(listed.stdout).toContain("cd -- /tmp/beta && codex resume codex-b -m gpt-fixture");
    expect(listed.stdout).not.toContain("pi-c");

    const found = await command(["find", "fixture", "-n", "10"]);
    expect(found.exitCode).toBe(0);
    expect(found.stdout).toContain("共 3 个匹配 session");
    expect(found.stdout).not.toContain("codex-child");
  });

  test("preserves marks commands, help, default snapshot, and failures", async () => {
    const help = await command(["--help"]); expect(help.stdout).toContain("sessions dash --stop");
    const version = await command(["--version"]); expect(version.stdout.trim()).toBe("sessions 1.0.0");
    const missing = await command(["find", "fixture"], "/missing");
    expect(missing.exitCode).toBe(1); expect(missing.stderr).toContain("需要 ripgrep (rg)");
    const invalid = await command(["unknown"]); expect(invalid.exitCode).toBe(1); expect(invalid.stderr).toContain("Usage:");

    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const snapshot = join(fixture.home, ".local/share/session-snapshots/last-active.txt");
    mkdirSync(join(fixture.home, ".local/share/session-snapshots"), { recursive: true }); writeFileSync(snapshot, "fixture snapshot");
    const result = Bun.spawnSync([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname], { env: { ...process.env, HOME: fixture.home } });
    expect(result.stdout.toString().trim()).toBe("fixture snapshot");
  });
});
