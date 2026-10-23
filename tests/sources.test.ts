import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionCatalog } from "../src/catalog.ts";
import { parseSessionsEnvelope, parseTranscriptView } from "../src/contracts.ts";
import { userDataDirectory } from "../src/paths.ts";
import { primaryAction, withResumeCommand } from "../src/resume.ts";
import { startServer } from "../src/server.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function jsonl(path: string, records: unknown[], live = false): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n" + (live ? JSON.stringify({ padding: "x".repeat(2200) }) : ""));
  return path;
}
function pi(path: string, id: string, text = id, cwd = "/old/project", live = false): string {
  return jsonl(path, [{ type: "session", id, cwd, name: text, timestamp: "2020-01-01T00:00:00Z" },
    { type: "message", message: { role: "user", content: "first" } },
    { type: "message", message: { role: "assistant", content: `deep ${text}` } }], live);
}
function codex(path: string, id: string, text: string, live = false): string {
  return jsonl(path, [{ type: "session_meta", payload: { id, cwd: "/old/project", timestamp: "2020-01-01T00:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }], live);
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "archive-sources-")), home = join(root, "home"), dataDirectory = join(root, "app");
  mkdirSync(home);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const sourcesFile = join(root, "sources.json");
  const configure = (sources: unknown[]) => write(sourcesFile, { version: 1, sources });
  const catalog = new SessionCatalog({ home, dataDirectory, sourcesFile, codexPath: null });
  return { root, home, dataDirectory, sourcesFile, configure, catalog };
}
function source(id: string, path: string, tool = "pi") {
  return { id, label: `Snapshot ${id}`, scope: id, roots: [{ id: `${tool}-1`, tool, path }] };
}
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

describe("configured archive sources", () => {
  test("keeps implicit live roots without config and honors option, environment, and default config locations", async () => {
    const f = setup();
    pi(join(f.home, ".pi/agent/sessions/project/live.jsonl"), "live-id", "live", undefined, true);
    expect((await new SessionCatalog({ home: f.home, dataDirectory: f.dataDirectory }).list()).map((row) => row.id)).toEqual(["live-id"]);
    const archive = join(f.root, "old"); pi(join(archive, "tiny.jsonl"), "old-id");
    const defaultFile = join(userDataDirectory(f.home), "sources.json");
    write(defaultFile, { version: 1, sources: [source("default", archive)] });
    expect((await new SessionCatalog({ home: f.home, dataDirectory: f.dataDirectory }).list()).find((row) => row.session_id === "old-id")?.source_id).toBe("default");
    f.configure([source("option", archive)]);
    const envFile = join(f.root, "environment.json"); write(envFile, { version: 1, sources: [source("environment", archive)] });
    const environment = { AGENT_SESSIONS_SOURCES_FILE: envFile };
    expect((await new SessionCatalog({ home: f.home, dataDirectory: f.dataDirectory, environment }).list()).find((row) => row.session_id)?.source_id).toBe("environment");
    expect((await new SessionCatalog({ home: f.home, dataDirectory: f.dataDirectory, environment, sourcesFile: f.sourcesFile }).list()).find((row) => row.session_id)?.source_id).toBe("option");
  });

  test("loads all sources immediately and discovers new files and changed config on every HTTP list", async () => {
    const f = setup(), a = join(f.root, "a"), b = join(f.root, "b");
    pi(join(a, "one.jsonl"), "one"); pi(join(b, "nested/two.jsonl"), "two");
    f.configure([source("cp", a), source("per", b)]);
    const server = startServer({ catalog: f.catalog, home: f.home, port: 0 }); cleanups.push(() => server.stop(true));
    const list = async () => parseSessionsEnvelope(await (await fetch(`http://127.0.0.1:${server.port}/api/sessions`)).json());
    expect((await list()).sessions.map((row) => row.source_id).sort()).toEqual(["cp", "per"]);
    pi(join(b, "three.jsonl"), "three");
    const c = join(f.root, "c"); pi(join(c, "four.jsonl"), "four");
    f.configure([source("cp", a), source("per", b), source("review", c)]);
    expect((await list()).sessions.map((row) => row.session_id).sort()).toEqual(["four", "one", "three", "two"]);
    expect((await f.catalog.find("deep", 100)).total).toBe(4);
  });

  test("isolates duplicate Codex IDs, names, transcripts, marks, routes, and search across live and two roots", async () => {
    const f = setup(), a = join(f.root, "a"), b = join(f.root, "b"), id = "same";
    const livePath = codex(join(f.home, ".codex/sessions/2020/01/01/rollout-live.jsonl"), id, "live-secret", true);
    codex(join(a, "copy.jsonl"), id, "a-secret"); codex(join(b, "nested/copy.jsonl"), id, "b-secret");
    writeFileSync(join(a, "session_index.jsonl"), JSON.stringify({ id, thread_name: "A name" }));
    writeFileSync(join(b, "session_index.jsonl"), JSON.stringify({ id, thread_name: "B name" }));
    writeFileSync(join(f.home, ".codex/session_index.jsonl"), JSON.stringify({ id, thread_name: "Live name" }));
    const before = (await f.catalog.list())[0]!;
    f.configure([source("cp", a, "codex"), source("per", b, "codex")]);
    const rows = await f.catalog.list({ fresh: true });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.source_path === livePath)).toEqual(before);
    const archived = rows.filter((row) => row.source_kind === "archive");
    expect(archived.map((row) => row.name).sort()).toEqual(["A name", "B name"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    for (const row of rows) {
      const text = row.source_id === "cp" ? "a-secret" : row.source_id === "per" ? "b-secret" : "live-secret";
      expect((await f.catalog.detail(row.id)).messages.at(-1)?.text).toBe(text);
      expect((await f.catalog.find(text)).results.map((hit) => hit.id)).toEqual([row.id]);
      await f.catalog.updateMark(row.id, { star: true, note: text, status: "review" });
    }
    const refreshed = await f.catalog.list({ fresh: true });
    expect(refreshed.map((row) => row.star_note).sort()).toEqual(["a-secret", "b-secret", "live-secret"]);
    const server = startServer({ catalog: f.catalog, home: f.home, port: 0 }); cleanups.push(() => server.stop(true));
    for (const row of archived) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/session?id=${encodeURIComponent(row.id)}`);
      expect(parseTranscriptView(await response.json()).name).toBe(row.name);
    }
  });

  test("preserves the newest live duplicate, raw marks, and resume ID while archive copies stay independent", async () => {
    const f = setup(), old = join(f.root, "old");
    const older = pi(join(f.home, ".pi/agent/sessions/one/a.jsonl"), "collision", "one", undefined, true);
    const newer = pi(join(f.home, ".pi/agent/sessions/two/b.jsonl"), "collision", "two", undefined, true);
    utimesSync(older, 100, 100); utimesSync(newer, 200, 200);
    pi(join(old, "a.jsonl"), "collision", "archive one"); pi(join(old, "b.jsonl"), "collision", "archive two");
    f.configure([source("old", old)]);
    write(join(f.dataDirectory, "stars.json"), { collision: { starred: true, note: "legacy note", status: "review" } });
    const rows = await f.catalog.list();
    expect(rows).toHaveLength(3);
    const live = rows.filter((row) => row.source_kind !== "archive");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: "collision", source_path: newer, name: "two", starred: true, star_note: "legacy note", status: "review" });
    expect(live[0]!.session_id).toBeUndefined();
    expect(primaryAction(live[0]!).value).toContain(process.platform === "win32" ? "'--session' 'collision'" : "--session collision");
    expect((await f.catalog.detail("collision")).messages.at(-1)?.text).toBe("deep two");
    expect(rows.filter((row) => row.source_kind === "archive").every((row) => row.id.startsWith("archive:") && row.session_id === "collision" && !row.starred && !row.star_note)).toBe(true);
    await f.catalog.updateMark("collision", { note: "only live" });
    expect((await f.catalog.list({ fresh: true })).filter((row) => row.star_note === "only live").map((row) => row.id)).toEqual(["collision"]);
  });

  test("keeps legacy live Codex source metadata visible while excluding the same subagent forms from archives", async () => {
    const f = setup(), old = join(f.root, "codex");
    const variants = [
      { id: "guardian-review", source: { subagent: { other: "guardian" } } },
      { id: "string-source", source: "subagent" },
      { id: "thread-child", thread_source: "subagent" },
    ];
    for (const metadata of variants) {
      const records = [
        { type: "session_meta", payload: { ...metadata, cwd: "/old/project" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${metadata.id} transcript` }] } },
      ];
      jsonl(join(f.home, `.codex/sessions/2020/01/01/rollout-${metadata.id}.jsonl`), records, true);
      jsonl(join(old, `${metadata.id}.jsonl`), records);
    }
    f.configure([source("old", old, "codex")]);
    const rows = await f.catalog.list();
    expect(rows.map((row) => row.id).sort()).toEqual(["guardian-review", "string-source"]);
    expect(rows.every((row) => row.source_kind === undefined && row.session_id === undefined)).toBe(true);
    expect((await f.catalog.find("guardian-review transcript")).results.map((row) => row.id)).toEqual(["guardian-review"]);
    expect((await f.catalog.detail("guardian-review")).messages[0]?.text).toBe("guardian-review transcript");
  });

  test("keeps Claude titles attached to their exact file when a sibling with the same original ID is untitled", async () => {
    const f = setup(), old = join(f.root, "claude");
    const event = { type: "user", sessionId: "same", cwd: "/old", message: { role: "user", content: "hello" } };
    const a = jsonl(join(old, "a.jsonl"), [event, { type: "custom-title", sessionId: "same", customTitle: "Only A title" }]);
    const b = jsonl(join(old, "b.jsonl"), [event]);
    f.configure([source("old", old, "claude")]);
    const rows = await f.catalog.list();
    expect(rows.find((row) => row.source_path === a)?.name).toBe("Only A title");
    expect(rows.find((row) => row.source_path === b)?.name).toBe("");
  });

  test("keeps separate snapshot files stable while deduplicating overlapping roots with live precedence", async () => {
    const f = setup(), old = join(f.root, "old");
    const live = pi(join(f.home, ".pi/agent/sessions/project/live.jsonl"), "same", "live", undefined, true);
    pi(join(old, "one.jsonl"), "same"); pi(join(old, "nested/two.jsonl"), "same");
    f.configure([source("overlap", join(f.home, ".pi/agent/sessions")), source("old", old), source("duplicate", old)]);
    const rows = await f.catalog.list();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.source_path === live)?.id).toBe("same");
    const ids = ["same", ...rows.filter((row) => row.source_kind === "archive").map((row) => row.id).sort()];
    for (const row of rows) utimesSync(row.source_path, 500, 500);
    const equalTime = await f.catalog.list({ fresh: true });
    expect(equalTime.map((row) => row.id)).toEqual(ids);
    expect((await f.catalog.list({ fresh: true })).map((row) => row.id)).toEqual(ids);
  });

  test("accepts tiny flat and nested archives and excludes malformed files and subagents", async () => {
    const f = setup(), old = join(f.root, "old");
    pi(join(old, "tiny.jsonl"), "tiny"); pi(join(old, "nested/tiny.jsonl"), "nested");
    writeFileSync(join(old, "broken.jsonl"), "not a session");
    const claude = join(f.root, "claude");
    const event = { type: "user", sessionId: "claude-tiny", cwd: "/old", message: { role: "user", content: "tiny Claude" } };
    jsonl(join(claude, "flat.jsonl"), [event]);
    jsonl(join(claude, "agent-child.jsonl"), [event]);
    jsonl(join(claude, "project/subagents/child.jsonl"), [event]);
    jsonl(join(claude, "side.jsonl"), [{ ...event, isSidechain: true }]);
    const codexRoot = join(f.root, "codex");
    codex(join(codexRoot, "valid.jsonl"), "codex-tiny", "valid");
    jsonl(join(codexRoot, "child.jsonl"), [{ type: "session_meta", payload: { id: "child", source: { subagent: { spawn: {} } } } }]);
    jsonl(join(codexRoot, "child2.jsonl"), [{ type: "session_meta", payload: { id: "child2", thread_source: "subagent" } }]);
    f.configure([source("old", old), source("claude", claude, "claude"), source("codex", codexRoot, "codex")]);
    expect((await f.catalog.list()).map((row) => row.session_id).sort()).toEqual(["claude-tiny", "codex-tiny", "nested", "tiny"]);
    expect(f.catalog.sourceDiagnostics().some((item) => (item.skipped ?? 0) > 0)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("skips escaping file, directory, and metadata symlinks on POSIX", async () => {
    const f = setup(), old = join(f.root, "old"), outside = join(f.root, "outside"), codexRoot = join(f.root, "codex");
    pi(join(old, "tiny.jsonl"), "tiny"); pi(join(outside, "escape.jsonl"), "escape");
    symlinkSync(join(outside, "escape.jsonl"), join(old, "escape.jsonl")); symlinkSync(outside, join(old, "linked-dir"));
    codex(join(codexRoot, "same.jsonl"), "same", "root-only");
    writeFileSync(join(outside, "index.jsonl"), JSON.stringify({ id: "same", thread_name: "escaped-name" }));
    symlinkSync(join(outside, "index.jsonl"), join(codexRoot, "session_index.jsonl"));
    f.configure([source("old", old), source("codex", codexRoot, "codex")]);
    const rows = await f.catalog.list();
    expect(rows.map((row) => row.session_id).sort()).toEqual(["same", "tiny"]);
    expect(rows.find((row) => row.session_id === "same")?.name).toBe("");
    expect((await f.catalog.find("escape")).total).toBe(0);
  });

  test("reports missing and invalid sources while retaining working sources and reloads repaired config", async () => {
    const f = setup(), a = join(f.root, "a"); pi(join(a, "one.jsonl"), "one");
    f.configure([source("good", a), source("missing", join(f.root, "missing")), { id: "bad", roots: [{ id: "x", tool: "unknown", path: a }] }]);
    expect(await f.catalog.list()).toHaveLength(1);
    expect(f.catalog.sourceDiagnostics().filter((item) => item.source_id === "missing" || item.source_id === "bad")).toHaveLength(2);
    writeFileSync(f.sourcesFile, "{"); expect(await f.catalog.list({ fresh: true })).toHaveLength(0);
    expect(f.catalog.sourceDiagnostics()[0]?.source_id).toBe("config");
    f.configure([source("fixed", a)]); expect((await f.catalog.list({ fresh: true }))[0]?.source_id).toBe("fixed");
    rmSync(f.sourcesFile); await f.catalog.list({ fresh: true }); expect(f.catalog.sourceDiagnostics()[0]?.message).toContain("不存在");
  });

  test("blocks archive rename before effects and keeps source hashes and mtimes unchanged across all operations", async () => {
    const f = setup(), old = join(f.root, "old"), path = pi(join(old, "tiny.jsonl"), "old");
    f.configure([source("old", old)]);
    const before = { hash: digest(path), mtime: statSync(path).mtimeMs };
    const row = (await f.catalog.list())[0]!;
    await f.catalog.detail(row.id); await f.catalog.find("deep"); await f.catalog.refreshLineage();
    await f.catalog.updateMark(row.id, { star: true, note: "safe", status: "done" });
    await expect(f.catalog.rename(row.id, "changed")).rejects.toThrow("只读");
    const server = startServer({ catalog: f.catalog, home: f.home, port: 0 }); cleanups.push(() => server.stop(true));
    expect((await fetch(`http://127.0.0.1:${server.port}/rename`, { method: "POST", body: JSON.stringify({ id: row.id, name: "changed" }) })).status).toBe(400);
    expect({ hash: digest(path), mtime: statSync(path).mtimeMs }).toEqual(before);
    const view = withResumeCommand((await f.catalog.list({ fresh: true }))[0]!);
    expect(view.resume_command).toBeUndefined(); expect(primaryAction(view)).toEqual({ kind: "path", value: path });
  });

  test("reads archive-local Codex WAL metadata without changing source databases or sidecars", async () => {
    const f = setup(), old = join(f.root, "codex");
    codex(join(old, "copy.jsonl"), "same", "archive transcript");
    const database = new Database(join(old, "state_5.sqlite"), { create: true });
    cleanups.push(() => database.close());
    database.run("PRAGMA journal_mode=WAL");
    database.run("CREATE TABLE threads (id TEXT, title TEXT, first_user_message TEXT, rollout_path TEXT, cwd TEXT, created_at REAL, model TEXT, thread_source TEXT)");
    database.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("same", "Archive WAL title", "archive first", join(old, "copy.jsonl"), "/old", 1, "old-model", "cli");
    const files = [...new Bun.Glob("*").scanSync({ cwd: old, absolute: true })].sort();
    expect(files.some((path) => path.endsWith("-wal"))).toBe(true);
    const fingerprint = () => files.map((path) => ({ path, hash: digest(path), mtime: statSync(path).mtimeMs }));
    const before = fingerprint();
    f.configure([source("old", old, "codex")]);
    const row = (await f.catalog.list())[0]!;
    expect(row.name).toBe("Archive WAL title");
    expect((await f.catalog.detail(row.id)).messages.at(-1)?.text).toBe("archive transcript");
    await f.catalog.find("archive transcript"); await f.catalog.updateMark(row.id, { note: "independent" });
    await expect(f.catalog.rename(row.id, "no")).rejects.toThrow("只读");
    expect(fingerprint()).toEqual(before);
    expect([...new Bun.Glob(".codex-metadata-*").scanSync({ cwd: f.dataDirectory, onlyFiles: false, dot: true })]).toEqual([]);
  });

  test("binds archive Codex database fields to an exact canonical file and ignores foreign rollout paths", async () => {
    const f = setup(), old = join(f.root, "codex");
    const a = codex(join(old, "a.jsonl"), "same", "A transcript"), b = codex(join(old, "b.jsonl"), "same", "B transcript");
    const stale = codex(join(old, "stale.jsonl"), "stale", "Stale transcript");
    appendFileSync(b, "\n" + JSON.stringify({ type: "turn_context", payload: { model: "b-file-model", effort: "low" } }) + "\n");
    const database = new Database(join(old, "state_5.sqlite"), { create: true });
    database.run("CREATE TABLE threads (id TEXT, title TEXT, first_user_message TEXT, rollout_path TEXT, model TEXT)");
    database.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("same", "A database title", "A database first", realpathSync(a), "a-model");
    database.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run("stale", "Foreign title", "Foreign first", "C:\\old\\stale.jsonl", "foreign-model");
    database.close();
    f.configure([source("old", old, "codex")]);
    const rows = await f.catalog.list();
    expect(rows.find((row) => row.source_path === a)).toMatchObject({ name: "A database title", first_msg: "A database first", model: "a-model" });
    expect(rows.find((row) => row.source_path === b)).toMatchObject({ name: "", first_msg: "first", model: "b-file-model" });
    expect(rows.find((row) => row.source_path === stale)).toMatchObject({ name: "", first_msg: "first", model: "" });
    expect((await f.catalog.detail(rows.find((row) => row.source_path === b)!.id)).messages.at(-1)?.text).toBe("B transcript");
  });

  test("excludes an archive database subagent only when both its canonical file and original ID match", async () => {
    const f = setup(), old = join(f.root, "codex");
    const child = codex(join(old, "child.jsonl"), "same", "child-only-secret");
    const sibling = codex(join(old, "sibling.jsonl"), "same", "sibling-secret");
    const reused = codex(join(old, "reused.jsonl"), "current-id", "reused-secret");
    const database = new Database(join(old, "state_5.sqlite"), { create: true });
    database.run("CREATE TABLE threads (id TEXT, title TEXT, first_user_message TEXT, rollout_path TEXT, thread_source TEXT)");
    const insert = database.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?)");
    insert.run("same", "Child", "child first", realpathSync(child), "subagent");
    insert.run("former-id", "Former child", "former first", realpathSync(reused), "subagent");
    database.close();
    f.configure([source("old", old, "codex")]);
    const rows = await f.catalog.list();
    expect(rows.map((row) => row.source_path).sort()).toEqual([reused, sibling].sort());
    expect((await f.catalog.find("child-only-secret")).total).toBe(0);
    expect((await f.catalog.find("sibling-secret")).results.map((row) => row.source_path)).toEqual([sibling]);
    expect((await f.catalog.find("reused-secret")).results.map((row) => row.source_path)).toEqual([reused]);
  });

  test("keeps source-scoped automatic lineage and retains manual relations and marks while a root is offline", async () => {
    const f = setup(), a = join(f.root, "a"), b = join(f.root, "b");
    const artifact = "/shared/handoff.md";
    jsonl(join(a, "writer.jsonl"), [
      { type: "session", id: "writer", cwd: "/old" },
      { type: "message", timestamp: "2020-01-01T00:00:00Z", message: { role: "user", content: "write" } },
      { type: "message", timestamp: "2020-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: artifact, content: "handoff" } }] } },
      { type: "message", timestamp: "2020-01-01T00:00:02Z", message: { role: "toolResult", toolCallId: "call", toolName: "write", isError: false, content: [{ type: "text", text: "ok" }] } },
    ]);
    jsonl(join(a, "reader.jsonl"), [{ type: "session", id: "reader", cwd: "/old" }, { type: "message", timestamp: "2020-01-02T00:00:00Z", message: { role: "user", content: `read ${artifact}` } }]);
    jsonl(join(b, "reader.jsonl"), [{ type: "session", id: "reader", cwd: "/old" }, { type: "message", timestamp: "2020-01-02T00:00:00Z", message: { role: "user", content: `read ${artifact}` } }]);
    f.configure([source("a", a), source("b", b)]);
    const rows = await f.catalog.list(), writer = rows.find((row) => row.session_id === "writer")!, readerA = rows.find((row) => row.source_id === "a" && row.session_id === "reader")!, readerB = rows.find((row) => row.source_id === "b")!;
    const automatic = await f.catalog.lineages();
    expect(automatic.edges.map((edge) => [edge.upstream_id, edge.downstream_id])).toEqual([[writer.id, readerA.id]]);
    await f.catalog.addManualLineage(writer.id, readerB.id); await f.catalog.updateMark(readerB.id, { note: "offline survives", star: true });
    const manualBefore = readFileSync(join(f.dataDirectory, "manual-lineages.json"), "utf8"), marksBefore = readFileSync(join(f.dataDirectory, "stars.json"), "utf8");
    renameSync(b, b + "-offline"); await f.catalog.refreshLineage(); await f.catalog.lineages();
    expect(readFileSync(join(f.dataDirectory, "manual-lineages.json"), "utf8")).toBe(manualBefore);
    expect(readFileSync(join(f.dataDirectory, "stars.json"), "utf8")).toBe(marksBefore);
    renameSync(b + "-offline", b);
    expect((await f.catalog.list({ fresh: true })).find((row) => row.id === readerB.id)?.star_note).toBe("offline survives");
    expect((await f.catalog.lineages()).edges.some((edge) => edge.relation === "manual" && edge.downstream_id === readerB.id)).toBe(true);
  });

  test("uses safe pi fork mapping, longest directory boundary, quoting, and independent existing writable continuation", async () => {
    const f = setup(), old = join(f.root, "old"), mapped = join(f.root, "mapped project's space"), continuation = join(f.root, "continue here");
    mkdirSync(mapped); mkdirSync(continuation); mkdirSync(join(mapped, "sub"));
    const path = pi(join(old, "archive's session.jsonl"), "pi-old", "name", "/old/project/sub");
    const configured = { ...source("pi", old), cwdMappings: [{ from: "/old", to: join(f.root, "missing") }, { from: "/old/project", to: mapped }], continuationDirectory: continuation };
    f.configure([configured]);
    const row = (await f.catalog.list())[0]!, action = primaryAction(row);
    expect(action.kind).toBe("fork");
    const quoted = (value: string) => `'${value.replaceAll("'", process.platform === "win32" ? "''" : `'"'"'`)}'`;
    expect(action.value).toBe(process.platform === "win32"
      ? `Set-Location -LiteralPath ${quoted(realpathSync(join(mapped, "sub")))}; if ($?) { & 'pi' '--fork' ${quoted(path)} '--session-dir' ${quoted(realpathSync(continuation))} }`
      : `cd -- ${quoted(realpathSync(join(mapped, "sub")))} && pi --fork ${quoted(path)} --session-dir ${quoted(realpathSync(continuation))}`);
    expect(action.value).not.toContain("--model");
    f.configure([{ ...configured, cwdMappings: [{ from: "/old/pro", to: mapped }] }]);
    expect((await f.catalog.list({ fresh: true }))[0]?.primary_action?.kind).toBe("path");
    for (const directory of [old, join(old, "nested"), join(f.home, ".pi/agent/sessions"), join(f.root, "missing")]) {
      if (!directory.endsWith("missing")) mkdirSync(directory, { recursive: true });
      f.configure([{ ...configured, continuationDirectory: directory }]);
      expect((await f.catalog.list({ fresh: true }))[0]?.primary_action?.kind).toBe("path");
    }
  });

  test.skipIf(process.platform === "win32")("rejects pi continuation symlinks into archive stores on POSIX", async () => {
    const f = setup(), old = join(f.root, "old"), mapped = join(f.root, "mapped"), alias = join(f.root, "alias");
    mkdirSync(mapped); pi(join(old, "session.jsonl"), "old"); symlinkSync(old, alias);
    f.configure([{ ...source("pi", old), cwdMappings: [{ from: "/old/project", to: mapped }], continuationDirectory: alias }]);
    expect((await f.catalog.list())[0]?.primary_action?.kind).toBe("path");
  });

  test("maps historical Windows cwd directories without matching partial directory names", async () => {
    const f = setup(), old = join(f.root, "old"), mapped = join(f.root, "mapped"), continuation = join(f.root, "continue");
    mkdirSync(join(mapped, "sub"), { recursive: true }); mkdirSync(continuation);
    pi(join(old, "session.jsonl"), "windows", "Windows project", "C:\\old\\Project\\sub");
    const configured = { ...source("windows", old), cwdMappings: [{ from: "C:\\old\\Project", to: mapped }], continuationDirectory: continuation };
    f.configure([configured]);
    expect((await f.catalog.list())[0]?.primary_action?.kind).toBe("fork");
    f.configure([{ ...configured, cwdMappings: [{ from: "C:\\old\\Pro", to: mapped }] }]);
    expect((await f.catalog.list({ fresh: true }))[0]?.primary_action?.kind).toBe("path");
  });

  test("Claude archives of any date and Codex archives always copy paths", async () => {
    const f = setup(), claude = join(f.root, "claude"), codexRoot = join(f.root, "codex");
    for (const year of [2000, 2030]) jsonl(join(claude, `${year}.jsonl`), [{ type: "user", sessionId: `${year}`, cwd: "/old", timestamp: `${year}-01-01T00:00:00Z`, message: { role: "user", content: "hello" } }]);
    codex(join(codexRoot, "session.jsonl"), "codex", "hello");
    f.configure([source("claude", claude, "claude"), source("codex", codexRoot, "codex")]);
    const rows = await f.catalog.list(); expect(rows).toHaveLength(3);
    for (const row of rows) { expect(primaryAction(row)).toEqual({ kind: "path", value: row.source_path }); expect(withResumeCommand(row).resume_command).toBeUndefined(); }
  });

  test("CLI lists and searches all archives by default and preserves result limit semantics", async () => {
    const f = setup(), old = join(f.root, "old");
    pi(join(old, "one.jsonl"), "one"); pi(join(old, "two.jsonl"), "two");
    f.configure([source("review", old)]);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { cwd: dirname(import.meta.dir), env: { ...process.env, HOME: f.home, AGENT_SESSIONS_SOURCES_FILE: f.sourcesFile } });
    const listed = run("list", "--json", "-n", "1"); expect(listed.exitCode).toBe(0);
    const envelope = JSON.parse(listed.stdout.toString()); expect(envelope.sessions).toHaveLength(1); expect(envelope.sessions[0].source_id).toBe("review");
    const found = run("find", "deep", "--json", "-n", "1"); expect(found.exitCode).toBe(0);
    expect(JSON.parse(found.stdout.toString())).toMatchObject({ total: 2, results: [{ primary_action: { kind: "path" } }] });
    const text = run("list", "-n", "1").stdout.toString(); expect(text).toContain("↳ " + envelope.sessions[0].source_path); expect(text).not.toContain("pi --session archive:");
  });
});
