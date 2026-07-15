import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { CatalogError, SessionCatalog } from "../src/catalog.ts";
import { fixtureHome } from "./fixture-home.ts";

const oracle = JSON.parse(readFileSync(new URL("./oracle/catalog.json", import.meta.url), "utf8"));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function setup() {
  const fixture = fixtureHome();
  cleanups.push(fixture.cleanup);
  return { ...fixture, catalog: new SessionCatalog({ home: fixture.home }) };
}

describe("SessionCatalog", () => {
  test("matches the Python metadata and Transcript oracle", async () => {
    const { home, catalog } = setup();
    const database = join(home, ".codex/state_5.sqlite");
    const before = statSync(database).mtimeMs;
    const sessions = await catalog.list({ fresh: true });
    expect(sessions.map(({ source_path: _, ...session }) => session)).toEqual(oracle.sessions);
    expect(Object.fromEntries(sessions.map(({ id, source_path }) => [id, source_path]))).toEqual({
      "pi-c": join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl"),
      "codex-b": join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"),
      "claude-a": join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"),
    });
    expect(statSync(database).mtimeMs).toBe(before);

    for (const session of sessions) {
      const detail = await catalog.detail(session.id);
      expect(detail.messages.map((message) => ({
        role: message.role,
        timestamp: message.timestamp,
        text_sha256: createHash("sha256").update(message.text).digest("hex"),
      }))).toEqual(oracle.transcripts[session.id]);
    }
  });

  test("search excludes malformed, tiny, and Codex subagent files", async () => {
    const { catalog } = setup();
    const found = await catalog.find("fixture", 2);
    expect(found.total).toBe(3);
    expect(found.results.map((result) => result.id)).toEqual([
      "pi-c", "codex-b",
    ]);
    expect((await catalog.list({ fresh: true })).map((session) => session.id)).not.toContain("codex-child");
  });

  test("deep search combines summary fields with readable Transcript text", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), JSON.stringify({
      type: "assistant", sessionId: "claude-a", message: { role: "assistant", content: "special \"quoted\" C:\\temp\nnext" },
    }) + "\n");
    expect((await catalog.find("LEGACY NOTE")).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find("FIXTURE-ASSISTANT-CODEX")).results.map(({ id }) => id)).toEqual(["codex-b"]);
    expect((await catalog.find("\"quoted\"")).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find(String.raw`C:\temp`)).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find("temp\nnext")).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find("fixture-user-[codex")).results).toEqual([]);
    expect((await catalog.find("x".repeat(50))).results).toEqual([]);
  });

  test("refreshes names and marks without reparsing unchanged metadata", async () => {
    const { home, catalog } = setup();
    await catalog.list({ fresh: true });
    const path = join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl");
    const original = statSync(path);
    const text = readFileSync(path, "utf8").replace("Claude custom", "Claude manual");
    await Bun.write(path, text);
    // Preserve the metadata cache signature to prove names are merged separately.
    const { utimesSync } = await import("node:fs");
    utimesSync(path, original.atime, original.mtime);
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")?.name).toBe("Claude manual");

    await catalog.updateMark("claude-a", { star: false, note: "" });
    expect(JSON.parse(readFileSync(join(home, ".local/share/session-snapshots/stars.json"), "utf8"))["claude-a"]).toBeUndefined();
  });

  test("scans Claude titles once, then only rescans changed files", async () => {
    const fixture = fixtureHome();
    cleanups.push(fixture.cleanup);
    const realRg = Bun.which("rg")!;
    const counter = join(fixture.home, "rg-calls");
    const fail = join(fixture.home, "rg-fail");
    const fakeRg = join(fixture.home, "rg");
    writeFileSync(fakeRg, `#!/bin/sh
printf '%s\\n' "$*" >> '${counter}'
[ -f '${fail}' ] && exit 2
exec '${realRg}' "$@"
`);
    chmodSync(fakeRg, 0o755);
    const catalog = new SessionCatalog({ home: fixture.home, rgPath: fakeRg });

    await catalog.list({ fresh: true });
    await catalog.list({ fresh: true });
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);

    appendFileSync(join(fixture.home, ".claude/projects/-tmp-alpha/claude-a.jsonl"),
      JSON.stringify({ type: "custom-title", customTitle: "Incremental title", sessionId: "claude-a" }) + "\n");
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")?.name).toBe("Incremental title");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);

    writeFileSync(fail, "fail");
    appendFileSync(join(fixture.home, ".claude/projects/-tmp-alpha/claude-a.jsonl"),
      JSON.stringify({ type: "custom-title", customTitle: "Retried title", sessionId: "claude-a" }) + "\n");
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")?.name).toBe("Incremental title");
    rmSync(fail);
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")?.name).toBe("Retried title");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(4);
  });

  test("uses the Codex SQLite index when rollout metadata is unreadable", async () => {
    const { home, catalog } = setup();
    const rollout = join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl");
    const database = new Database(join(home, ".codex/state_5.sqlite"));
    for (const column of ["rollout_path", "cwd", "created_at", "model", "thread_source"])
      database.run(`ALTER TABLE threads ADD COLUMN ${column}`);
    database.run("UPDATE threads SET rollout_path = ?, cwd = ?, created_at = ?, model = ?, thread_source = ? WHERE id = ?",
      [rollout, "/tmp/from-sqlite", 123, "sqlite-model", "", "codex-b"]);
    database.close();
    const text = readFileSync(rollout, "utf8");
    writeFileSync(rollout, "not-json" + text.slice(text.indexOf("\n")));

    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "codex-b")).toMatchObject({
      cwd: "/tmp/from-sqlite", first_msg: "fixture-user-codex", birth: 123, model: "sqlite-model",
    });
    const updated = new Database(join(home, ".codex/state_5.sqlite"));
    updated.run("UPDATE threads SET model = ? WHERE id = ?", ["updated-model", "codex-b"]);
    updated.close();
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "codex-b")?.model).toBe("updated-model");
  });

  test("does not expose the mutable cached Session list", async () => {
    const { catalog } = setup();
    const rows = await catalog.list({ fresh: true });
    rows[0]!.name = "caller mutation";
    rows.pop();
    const cached = await catalog.list();
    expect(cached).toHaveLength(3);
    expect(cached[0]!.name).not.toBe("caller mutation");
  });

  test("prefers Codex thread_name over a legacy local name", async () => {
    const { catalog } = setup();
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "codex-b")?.name).toBe("Codex explicit");
  });

  test("detail reuses the current index until an explicit refresh", async () => {
    const { home, catalog } = setup();
    const before = (await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")!;
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"),
      JSON.stringify({ type: "custom-title", customTitle: "Changed after index", sessionId: "claude-a" }) + "\n");

    expect((await catalog.detail("claude-a")).name).toBe(before.name);
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "claude-a")?.name).toBe("Changed after index");
  });

  test("keeps each adapter's rename behavior behind the Catalog", async () => {
    const fixture = fixtureHome();
    cleanups.push(fixture.cleanup);
    const { home } = fixture;
    const codexPath = join(home, "fake-codex");
    writeFileSync(codexPath, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}' ;;
    *'"id":2'*)
      printf '%s\\n' "$line" > "$CODEX_HOME/rename-request.json"
      printf '%s\\n' '{"id":"codex-b","thread_name":"Codex new","updated_at":"2026-07-14T12:00:00Z"}' >> "$CODEX_HOME/session_index.jsonl"
      printf '%s\\n' '{"id":2,"result":{}}' ;;
  esac
done
`);
    chmodSync(codexPath, 0o755);
    const catalog = new SessionCatalog({ home, codexPath });
    const pi = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    if (process.platform !== "win32") chmodSync(pi, 0o640);
    await catalog.rename("claude-a", "Claude new");
    await catalog.rename("codex-b", "Codex new");
    await catalog.rename("pi-c", "Pi new");
    const rows = await catalog.list({ fresh: true });
    expect(Object.fromEntries(rows.map(({ id, name }) => [id, name]))).toEqual({
      "pi-c": "Pi new", "claude-a": "Claude new", "codex-b": "Codex new",
    });
    expect(readFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), "utf8")).toContain('"customTitle":"Claude new"');
    expect(JSON.parse(readFileSync(join(home, ".codex/rename-request.json"), "utf8"))).toMatchObject({
      method: "thread/name/set", params: { threadId: "codex-b", name: "Codex new" },
    });
    expect(JSON.parse(readFileSync(pi, "utf8").split("\n")[0]!).name).toBe("Pi new");
    if (process.platform !== "win32") expect(statSync(pi).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(join(home, ".local/share/session-snapshots/stars.json"), "utf8"))["codex-b"].name).toBeUndefined();
  });

  test("resolves only unique prefixes", async () => {
    const { catalog } = setup();
    expect((await catalog.resolve("claude-")).id).toBe("claude-a");
    await expect(catalog.resolve("c")).rejects.toEqual(new CatalogError("ambiguous", "id 前缀 'c' 匹配到 2 个 session，需要更长前缀"));
    await expect(catalog.resolve("missing")).rejects.toEqual(new CatalogError("not_found", "没有 session 匹配 'missing'"));
  });

  test("can remove legacy stars after the source session disappears", async () => {
    const { home, catalog } = setup();
    const marks = join(home, ".local/share/session-snapshots/stars.json");
    const value = JSON.parse(readFileSync(marks, "utf8"));
    value.orphan = { note: "legacy" };
    writeFileSync(marks, JSON.stringify(value));
    expect(await catalog.unstar("orphan")).toBe("orphan");
    expect((await catalog.listStars()).map(({ id }) => id)).not.toContain("orphan");
  });
});
