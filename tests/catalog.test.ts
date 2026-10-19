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

  test("reads Codex rollouts compressed to .jsonl.zst", async () => {
    const { home, catalog } = setup();
    const rollout = join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl");
    const expected = (await catalog.detail("codex-b")).messages;
    writeFileSync(rollout + ".zst", Bun.zstdCompressSync(readFileSync(rollout)));
    rmSync(rollout);
    const fresh = new SessionCatalog({ home });
    expect((await fresh.list({ fresh: true })).find(({ id }) => id === "codex-b")?.source_path).toBe(rollout + ".zst");
    expect((await fresh.detail("codex-b")).messages).toEqual(expected);
    expect((await fresh.find("FIXTURE-ASSISTANT-CODEX")).results.map(({ id }) => id)).toEqual(["codex-b"]);
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

  test("automatically refreshes Lineage before returning the global graph", async () => {
    const { home, catalog } = setup();
    const artifact = join(home, "handoff.md");
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), [
      JSON.stringify({ timestamp: "2026-07-14T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "handoff" } }),
      JSON.stringify({ timestamp: "2026-07-14T01:00:01Z", type: "event_msg", payload: { type: "user_message", message: "write handoff" } }),
      JSON.stringify({ timestamp: "2026-07-14T01:00:02Z", type: "event_msg", payload: { type: "patch_apply_end", turn_id: "handoff", success: true, changes: { [artifact]: { type: "add" } } } }),
    ].join("\n") + "\n");
    appendFileSync(join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl"), JSON.stringify({
      type: "message", timestamp: "2026-07-14T02:00:00Z", message: { role: "user", content: [{ type: "text", text: `continue ${artifact}` }] },
    }) + "\n");

    expect((await catalog.lineages()).edges).toEqual([
      expect.objectContaining({ upstream_id: "codex-b", downstream_id: "pi-c", path: artifact }),
    ]);
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

  test("keeps manual Lineage after refresh, cache deletion, and Catalog restart", async () => {
    const { home, catalog } = setup();
    await catalog.list({ fresh: true });
    await catalog.addManualLineage("claude-a", "codex-b");
    expect((await catalog.refreshLineage(true)).edges).toBe(1);
    rmSync(join(home, ".local/share/session-snapshots/lineage.sqlite"), { force: true });

    const lineage = await new SessionCatalog({ home }).lineage("codex-b", false);
    expect(lineage.edges).toEqual([expect.objectContaining({
      relation: "manual", upstream_id: "claude-a", downstream_id: "codex-b",
    })]);
    expect(readFileSync(join(home, ".local/share/session-snapshots/manual-lineages.json"), "utf8")).toContain("claude-a");
  });

  test("removes only the selected manual Lineage persistently", async () => {
    const { home, catalog } = setup();
    await catalog.addManualLineage("claude-a", "codex-b");
    await catalog.addManualLineage("pi-c", "codex-b");

    await catalog.removeManualLineage("claude-a", "codex-b");

    const lineage = await new SessionCatalog({ home }).lineage("codex-b", false);
    expect(lineage.edges).toEqual([expect.objectContaining({
      relation: "manual", upstream_id: "pi-c", downstream_id: "codex-b",
    })]);
  });

  test("rebuilds the derived cache before rejecting a cyclic manual Lineage", async () => {
    const { home, catalog } = setup();
    const handoff = join(home, "handoff.md");
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), [
      { type: "assistant", timestamp: "2026-07-14T01:01:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "write-handoff", name: "Write", input: { file_path: handoff } }] } },
      { type: "user", timestamp: "2026-07-14T01:02:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "write-handoff", content: "ok" }] } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), JSON.stringify({
      type: "response_item", timestamp: "2026-07-14T02:03:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `continue ${handoff}` }] },
    }) + "\n");
    rmSync(join(home, ".local/share/session-snapshots/lineage.sqlite"), { force: true });

    await expect(catalog.addManualLineage("codex-b", "claude-a"))
      .rejects.toEqual(new CatalogError("invalid", "手动关系不能形成循环"));
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
    expect(JSON.parse(readFileSync(pi, "utf8").trimEnd().split("\n").at(-1)!).name).toBe("Pi new");
    if (process.platform !== "win32") expect(statSync(pi).mode & 0o777).toBe(0o640);
    expect(JSON.parse(readFileSync(join(home, ".local/share/session-snapshots/stars.json"), "utf8"))["codex-b"].name).toBeUndefined();
  });

  test.each([false, true])("reads the model from native pi assistant messages without model_change (spaced=%s)", async (spaced) => {
    const { home, catalog } = setup();
    const path = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    const records = [
      { type: "session", version: 3, id: "pi-c", cwd: "/tmp/pi", timestamp: "2026-07-14T03:00:00Z" },
      { type: "message", message: { role: "user", content: "Find the model" } },
      { type: "message", message: { role: "assistant", model: "gpt-6.1-sol", content: [{ type: "text", text: "Done" }], provider: "openai-codex" } },
      { type: "message", message: { role: "toolResult", model: "not-the-model", provider: "fake", content: "x".repeat(2200) } },
    ];
    writeFileSync(path, records.map((record) => {
      const line = JSON.stringify(record);
      return spaced ? line.replaceAll('\":', '\": ') : line;
    }).join("\n") + "\n");
    expect((await catalog.detail("pi-c")).model).toBe("openai-codex/gpt-6.1-sol");
  });

  test("reads reordered native pi model_change fields after the last assistant reply", async () => {
    const { home, catalog } = setup();
    const path = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    appendFileSync(path, JSON.stringify({ type: "model_change", modelId: "new-model", id: "selected", provider: "new-provider" }) + "\n");
    expect((await catalog.detail("pi-c")).model).toBe("new-provider/new-model");
  });

  test("reads the latest native pi name even beyond the metadata head and refreshes it", async () => {
    const { home, catalog } = setup();
    const path = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    appendFileSync(path, (JSON.stringify({ type: "custom", data: {} }) + "\n").repeat(410));
    appendFileSync(path, JSON.stringify({ type: "session_info", id: "name-old", parentId: null, name: "Pi native old" }) + "\n");
    appendFileSync(path, JSON.stringify({ type: "session_info", id: "name-new", parentId: "name-old", name: "Pi native latest" }) + "\n");
    expect((await catalog.detail("pi-c")).name).toBe("Pi native latest");
    appendFileSync(path, JSON.stringify({ type: "session_info", id: "name-next", parentId: "name-new", name: "Pi external rename" }) + "\n");
    expect((await catalog.list({ fresh: true })).find(({ id }) => id === "pi-c")?.name).toBe("Pi external rename");
  });

  test.each(["", "   ", undefined])("honors a cleared native pi name (%s) over an old header name", async (name) => {
    const { home, catalog } = setup();
    const path = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    appendFileSync(path, JSON.stringify({ type: "session_info", id: "clear", parentId: null, name }) + "\n");
    expect((await catalog.detail("pi-c")).name).toBe("");
  });

  test.each([true, false])("renames pi with a native append-only session_info entry without rewriting history (newline=%s)", async (newline) => {
    const { home, catalog } = setup();
    const path = join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl");
    appendFileSync(path, JSON.stringify({ type: "message", id: "leaf", parentId: null, message: { role: "assistant", content: "Existing reply" } }) + "\n");
    if (!newline) writeFileSync(path, readFileSync(path, "utf8").trimEnd());
    const before = readFileSync(path, "utf8");
    const messages = (await catalog.detail("pi-c")).messages;
    await catalog.rename("pi-c", "  Pi native renamed  ");
    const after = readFileSync(path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const entry = JSON.parse(after.slice(before.length).trim());
    expect(entry).toMatchObject({ type: "session_info", name: "Pi native renamed", parentId: "leaf" });
    expect(typeof entry.id).toBe("string");
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    expect((await catalog.detail("pi-c")).name).toBe("Pi native renamed");
    expect((await catalog.detail("pi-c")).messages).toEqual(messages);
    expect((await new SessionCatalog({ home }).detail("pi-c")).name).toBe("Pi native renamed");
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
