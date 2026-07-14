import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { dashboardStateFile, startDashboard, stopDashboard } from "../src/lifecycle.ts";
import { fixtureHome } from "./fixture-home.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port!; server.stop(true); return port;
}

describe("dashboard lifecycle", () => {
  test("starts, reuses, and stops only the nonce-matched child", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const stateDir = join(fixture.home, "state"), port = freePort();
    const options = {
      stateDir, port, open: false,
      command: [process.execPath, new URL("../src/cli.ts", import.meta.url).pathname],
      env: { ...process.env, HOME: fixture.home, USERPROFILE: fixture.home },
    };
    const first = await startDashboard(options); cleanups.push(async () => { await stopDashboard({ stateDir }); });
    expect(first.reused).toBe(false);
    expect((await fetch(first.url + `/health?nonce=${first.nonce}`)).status).toBe(200);
    const second = await startDashboard(options);
    expect(second).toMatchObject({ reused: true, pid: first.pid, nonce: first.nonce });
    expect(await stopDashboard({ stateDir })).toBe(true);
    expect(existsSync(dashboardStateFile(stateDir))).toBe(false);
  });

  test("rejects an unrelated live process instead of taking it over", async () => {
    const fixture = fixtureHome(); cleanups.push(fixture.cleanup);
    const stateDir = join(fixture.home, "unsafe-state"); mkdirSync(stateDir, { recursive: true });
    const unrelated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated") });
    cleanups.push(() => unrelated.stop(true));
    writeFileSync(dashboardStateFile(stateDir), JSON.stringify({ pid: process.pid, port: unrelated.port, nonce: crypto.randomUUID() }));
    await expect(startDashboard({ stateDir, port: unrelated.port!, open: false, command: [process.execPath] })).rejects.toThrow("仍存活但健康校验失败");
    expect(unrelated.pendingRequests).toBeGreaterThanOrEqual(0);
  });
});
