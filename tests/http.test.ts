import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionCatalog } from "../src/catalog.ts";
import { formatResumeCommand } from "../src/resume.ts";
import { startServer } from "../src/server.ts";
import { fixtureHome } from "./fixture-home.ts";

const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));

async function setup() {
  const fixture = fixtureHome();
  const server = startServer({ catalog: new SessionCatalog({ home: fixture.home }), port: 0, nonce: "fixture-nonce", html: "<!doctype html><main>fixture app</main>", platform: "linux", home: fixture.home });
  stops.push(() => { server.stop(true); fixture.cleanup(); });
  return { home: fixture.home, base: `http://127.0.0.1:${server.port}` };
}

describe("resume commands", () => {
  test("quotes POSIX and native Windows PowerShell values", () => {
    const session = { tool: "pi", id: "id'; touch nope", cwd: "/tmp/a b's", model: "provider/model x" } as const;
    expect(formatResumeCommand(session, "linux")).toBe("cd -- '/tmp/a b'\"'\"'s' && pi --session 'id'\"'\"'; touch nope' --model 'provider/model x'");
    expect(formatResumeCommand(session, "win32")).toBe("Set-Location -LiteralPath '/tmp/a b''s'; if ($?) { & 'pi' '--session' 'id''; touch nope' '--model' 'provider/model x' }");
    expect(() => formatResumeCommand({ ...session, id: "bad\0id" }, "linux")).toThrow("NUL");
  });
});

describe("Bun HTTP seam", () => {
  test("serves the app, list, detail, and nonce health over GET", async () => {
    const { base, home } = await setup();
    expect(await (await fetch(base + "/")).text()).toContain("fixture app");
    expect((await fetch(base + "/health?nonce=fixture-nonce")).status).toBe(200);
    expect((await fetch(base + "/health?nonce=wrong")).status).toBe(404);
    expect((await fetch(base + "/", { method: "HEAD" })).status).toBe(404);
    const envelope = await (await fetch(base + "/api/sessions?fresh=1")).json();
    expect(envelope.sessions.map(({ id }: { id: string }) => id)).toEqual(["pi-c", "codex-b", "claude-a"]);
    expect(envelope.sessions.find(({ id }: { id: string }) => id === "codex-b").source_path)
      .toBe(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"));
    expect(envelope.generatedAt).toBeString();
    expect(envelope.home).toBe(home);
    const detail = await (await fetch(base + "/api/session?id=codex-b")).json();
    expect(detail.id).toBe("codex-b");
    expect(detail.messages).toHaveLength(2);
    expect(detail.resume_command).toBe("cd -- /tmp/beta && codex resume codex-b -m gpt-fixture");
  });

  test("validates routes and applies mutations", async () => {
    const { base } = await setup();
    expect((await fetch(base + "/missing")).status).toBe(404);
    expect((await fetch(base + "/api/session?id=missing")).status).toBe(404);
    expect((await fetch(base + "/star", { method: "POST", body: "{" })).status).toBe(400);
    expect((await fetch(base + "/star", { method: "POST", body: JSON.stringify({ star: true }) })).status).toBe(400);
    expect((await fetch(base + "/star", { method: "POST", body: JSON.stringify({ id: "codex-b", status: "waiting" }) })).status).toBe(400);
    expect((await fetch(base + "/star", { method: "POST", body: JSON.stringify({ id: "missing", star: true }) })).status).toBe(404);
    expect((await fetch(base + "/star", { method: "POST", body: JSON.stringify({ id: "codex-b", star: true, note: "kept", archive: true, status: "done" }) })).status).toBe(200);
    expect((await fetch(base + "/rename", { method: "POST", body: JSON.stringify({ id: "claude-a", name: "HTTP name" }) })).status).toBe(200);
    expect((await fetch(base + "/api/star", { method: "POST", body: JSON.stringify({ id: "codex-b", star: true }) })).status).toBe(404);
    const rows = (await (await fetch(base + "/api/sessions?fresh=1")).json()).sessions;
    expect(rows.find(({ id }: { id: string }) => id === "codex-b"))
      .toMatchObject({ starred: true, star_note: "kept", archived: true, status: "done", name: "Codex explicit" });
    expect(rows.find(({ id }: { id: string }) => id === "claude-a")).toMatchObject({ name: "HTTP name" });
  });

  test("searches readable Transcript text through a validated GET route", async () => {
    const { base } = await setup();
    const response = await fetch(base + "/api/search?q=FIXTURE-ASSISTANT-CODEX&limit=10");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      results: [{ id: "codex-b", snippet: "fixture-assistant-codex", resume_command: "cd -- /tmp/beta && codex resume codex-b -m gpt-fixture" }],
    });
    expect((await fetch(base + "/api/search")).status).toBe(400);
    expect((await fetch(base + "/api/search?q=fixture&limit=0")).status).toBe(400);
    expect((await fetch(base + "/api/search?q=fixture&limit=501")).status).toBe(200);
    expect((await fetch(base + "/api/search?q=fixture&limit=1.5")).status).toBe(400);
  });

  test("returns safe JSON when detail parsing fails", async () => {
    const catalog = {
      list: async () => [],
      detail: async () => { throw new Error("private parser detail"); },
    } as unknown as SessionCatalog;
    const server = startServer({ catalog, port: 0, platform: "linux" });
    stops.push(() => server.stop(true));
    const response = await fetch(`http://127.0.0.1:${server.port}/api/session?id=broken`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "操作失败" });
  });

  test("returns a safe 500 when persistence fails", async () => {
    const fixture = fixtureHome();
    const data = join(fixture.home, ".local/share/session-snapshots");
    rmSync(data, { recursive: true });
    mkdirSync(dirname(data), { recursive: true });
    writeFileSync(data, "not a directory");
    const server = startServer({ catalog: new SessionCatalog({ home: fixture.home }), port: 0, nonce: "n", html: "ok", platform: "linux" });
    stops.push(() => { server.stop(true); fixture.cleanup(); });
    const response = await fetch(`http://127.0.0.1:${server.port}/star`, { method: "POST", body: JSON.stringify({ id: "claude-a", star: false }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "操作失败" });
  });
});
