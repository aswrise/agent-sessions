import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
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
    const found = await catalog.find({ terms: ["fixture"] }, 2);
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
    expect((await fresh.find({ terms: ["FIXTURE-ASSISTANT-CODEX"] })).results.map(({ id }) => id)).toEqual(["codex-b"]);
  });

  test("finds a large .jsonl.zst whose match ripgrep reports only as zstd's broken pipe", async () => {
    const { home } = setup();
    const rollout = join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl");
    // Incompressible filler keeps zstd writing after ripgrep has matched and closed the pipe.
    const filler = Array.from({ length: 2000 }, () => JSON.stringify({ type: "event_msg", timestamp: "t9", payload: { type: "token_count", info: randomBytes(768).toString("hex") } })).join("\n");
    writeFileSync(rollout + ".zst", Bun.zstdCompressSync(readFileSync(rollout, "utf8") + filler + "\n"));
    rmSync(rollout);
    const { results, coverage } = await new SessionCatalog({ home }).find({ terms: ["FIXTURE-ASSISTANT-CODEX"] });
    expect(results.map(({ id }) => id)).toEqual(["codex-b"]);
    expect(coverage.unreadable_files).toBe(0);
  });

  test("finds Sessions whose only hit is a tool call or tool output, for every tool", async () => {
    const { home, catalog } = setup();
    const append = (path: string, records: unknown[]) => appendFileSync(join(home, path), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    append(".claude/projects/-tmp-alpha/claude-a.jsonl", [
      { type: "assistant", timestamp: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "u1", name: "Bash", input: { command: "launchctl print claude-call-needle" } }] } },
      { type: "user", timestamp: "t2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "claude-output-needle" }] }] }, toolUseResult: { stdout: "claude-output-needle" } },
    ]);
    append(".codex/sessions/2026/07/14/rollout-codex-b.jsonl", [
      { type: "response_item", timestamp: "t1", payload: { type: "custom_tool_call", name: "exec", input: "tools.exec_command({cmd:'codex-call-needle'})", call_id: "c" } },
      { type: "event_msg", timestamp: "t2", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "ls"], aggregated_output: "codex-command-needle" } } },
      { type: "event_msg", timestamp: "t3", payload: { type: "item_completed", item: { type: "McpToolCall", server: "browser", tool: "open", arguments: { url: "codex-mcp-needle" }, result: { content: [{ type: "text", text: "ok" }] } } } },
      { type: "event_msg", timestamp: "t4", payload: { type: "item_completed", item: { type: "AgentMessage", text: "codex-duplicate-needle" } } },
    ]);
    append(".pi/agent/sessions/-tmp-gamma/pi-c.jsonl", [
      { type: "message", timestamp: "t1", message: { role: "assistant", content: [{ type: "toolCall", id: "p", name: "bash", arguments: { command: "pi-call-needle" } }] } },
      { type: "message", timestamp: "t2", message: { role: "toolResult", toolCallId: "p", toolName: "bash", content: [{ type: "text", text: "pi-output-needle" }] } },
    ]);
    const hit = async (term: string) => {
      const { results } = await catalog.find({ terms: [term] });
      return results.map(({ id, match }) => ({ id, tier: match.tier, best: match.best[0] && { kind: match.best[0].kind, tool: match.best[0].kind === "meta" ? "" : match.best[0].tool ?? "" } }));
    };
    expect(await hit("claude-call-needle")).toEqual([{ id: "claude-a", tier: 3, best: { kind: "tool_call", tool: "Bash" } }]);
    expect(await hit("claude-output-needle")).toEqual([{ id: "claude-a", tier: 3, best: { kind: "tool_output", tool: "" } }]);
    expect(await hit("codex-call-needle")).toEqual([{ id: "codex-b", tier: 3, best: { kind: "tool_call", tool: "exec" } }]);
    expect(await hit("codex-command-needle")).toEqual([{ id: "codex-b", tier: 3, best: { kind: "tool_output", tool: "command" } }]);
    expect(await hit("codex-mcp-needle")).toEqual([{ id: "codex-b", tier: 3, best: { kind: "tool_output", tool: "browser.open" } }]);
    expect(await hit("pi-call-needle")).toEqual([{ id: "pi-c", tier: 3, best: { kind: "tool_call", tool: "bash" } }]);
    expect(await hit("pi-output-needle")).toEqual([{ id: "pi-c", tier: 3, best: { kind: "tool_output", tool: "bash" } }]);
    const duplicate = await catalog.find({ terms: ["codex-duplicate-needle"] });
    expect(duplicate.results).toEqual([]);
    expect(duplicate.coverage).toMatchObject({ candidate_files: 1, unclassified_files: 1 });
  });

  test("ANDs terms across a Session, its child threads, and offloaded tool results", async () => {
    const { home, catalog } = setup();
    const split = await catalog.find({ terms: ["fixture-user-claude", "FIXTURE-CHILD-OUTPUT"] });
    expect(split.results.map(({ id, match }) => ({ id, tier: match.tier, threads: match.threads }))).toEqual([
      { id: "claude-a", tier: 1, threads: [{ thread: "sub1", label: "Find launch agent", hits: 1 }] },
    ]);
    expect((await catalog.find({ terms: ["fixture-child-output", "fixture-user-codex"] })).results).toEqual([]);

    const offloaded = await catalog.find({ terms: ["fixture-offloaded-result"] });
    expect(offloaded.results[0]!.match.best[0]).toMatchObject({ kind: "tool_output", thread: "toolu_big.txt", ordinal: 1 });
    expect((await catalog.find({ terms: ["fixture-kid-output"] })).results.map(({ id, match }) => [id, match.threads])).toEqual([
      ["codex-b", [{ thread: "codex-kid", label: "Euclid", hits: 1 }]],
    ]);
    expect((await catalog.list({ fresh: true })).map(({ id }) => id).sort()).toEqual(["claude-a", "codex-b", "pi-c"]);
    expect((await catalog.find({ terms: ["fixture-grandkid-text"] })).results.map(({ id, match }) => [id, match.threads])).toEqual([
      ["codex-b", [{ thread: "codex-grandkid", label: "/root/kid/grand", hits: 1 }]],
    ]);

    const orphan = await catalog.find({ terms: ["fixture-subagent-secret"] });
    expect(orphan.results).toEqual([]);
    expect(orphan.coverage).toMatchObject({ orphan_files: 1, orphans: [{ path: join(home, ".codex/sessions/2026/07/14/rollout-subagent.jsonl"), label: "codex-child", hits: 1 }] });
  });

  test("counts injected-only and unprojected hits instead of dropping them", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), JSON.stringify({
      type: "user", message: { role: "user", content: "# AGENTS.md instructions\ninjected-needle" },
    }) + "\n");
    const injected = await catalog.find({ terms: ["injected-needle"] });
    expect(injected.results).toEqual([]);
    expect(injected.coverage).toMatchObject({ candidate_files: 1, injected_only_files: 1, unclassified_files: 0 });

    const padding = await catalog.find({ terms: ["x".repeat(50)] });
    expect(padding.results).toEqual([]);
    const { coverage } = padding;
    expect(coverage.candidate_files).toBe(coverage.unclassified_files + coverage.injected_only_files + coverage.orphan_files);
    // Every padded JSONL file: three rows, three Codex threads, one Claude subagent; the offloaded .txt has no padding.
    expect(coverage).toMatchObject({ scanned_files: 8, candidate_files: 7 });
  });

  test("filters by time, tool, cwd, and excluded ids before scanning", async () => {
    const { catalog } = setup();
    const ids = async (query: Partial<Parameters<typeof catalog.find>[0]>) =>
      (await catalog.find({ terms: ["fixture"], ...query }, 10)).results.map(({ id }) => id);
    const rows = await catalog.list({ fresh: true }), codex = rows.find(({ id }) => id === "codex-b")!;
    expect(await ids({ tools: ["codex", "pi"] })).toEqual(["pi-c", "codex-b"]);
    expect(await ids({ cwd: "/tmp/beta" })).toEqual(["codex-b"]);
    expect(await ids({ cwd: "/tmp/bet" })).toEqual([]);
    expect(await ids({ exclude: ["pi-c"] })).toEqual(["codex-b", "claude-a"]);
    expect(await ids({ since: 150 })).toEqual(["pi-c", "codex-b"]);
    expect(await ids({ since: 150, until: codex.birth })).toEqual(["codex-b"]);
  });

  test("excerpt returns merged, clipped windows around hits and lands on find's ordinals", async () => {
    const { home, catalog } = setup();
    const long = "a".repeat(1000) + " window-needle " + "b".repeat(1000);
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), [
      ...Array.from({ length: 12 }, (_, index) => ({ type: "assistant", timestamp: `f${index}`, message: { role: "assistant", content: `filler ${index}` } })),
      { type: "assistant", timestamp: "n1", message: { role: "assistant", content: long } },
      { type: "assistant", timestamp: "n2", message: { role: "assistant", content: "second window-needle" } },
      ...Array.from({ length: 10 }, (_, index) => ({ type: "assistant", timestamp: `g${index}`, message: { role: "assistant", content: `filler ${index}` } })),
      { type: "user", timestamp: "n3", message: { role: "user", content: "late window-needle" } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    // Main stream: 2 original messages, 12 fillers, ordinals 14 and 15 are hits, 10 fillers, ordinal 26 is a hit.
    const excerpt = await catalog.excerpt("claude-a", { around: ["WINDOW-NEEDLE"], context: 1, chars: 100 });
    expect(excerpt.threads.map(({ thread, events, hits }) => ({ thread, events, hits }))).toEqual([
      { thread: "main", events: 27, hits: [14, 15, 26] },
      { thread: "sub1", events: 3, hits: [] },
      { thread: "toolu_big.txt", events: 3, hits: [] },
    ]);
    expect(excerpt.windows.map(({ thread, from, to, hits }) => ({ thread, from, to, hits }))).toEqual([
      { thread: "main", from: 13, to: 16, hits: [14, 15] },
      { thread: "main", from: 25, to: 26, hits: [26] },
    ]);
    const clipped = excerpt.windows[0]!.events.find(({ ordinal }) => ordinal === 14)!;
    expect(clipped.text).toContain("window-needle");
    expect(clipped.text.length).toBeLessThanOrEqual(102);
    expect(clipped.length).toBe(long.length);
    expect(excerpt.omitted_windows).toBe(0);
    const capped = await catalog.excerpt("claude-a", { around: ["window-needle"], context: 0, windows: 1 });
    // Adjacent hits 14 and 15 share one window even without context.
    expect([capped.windows.length, capped.omitted_windows]).toEqual([1, 1]);
    const whole = await catalog.excerpt("claude-a", { around: ["window-needle"], context: 0, chars: 0 });
    expect(whole.windows[0]!.events[0]!.text).toBe(long);

    const best = (await catalog.find({ terms: ["late window-needle"] })).results[0]!.match.best[0]!;
    expect(best).toMatchObject({ kind: "user", thread: "main", ordinal: 26 });
    const landed = await catalog.excerpt("claude-a", { at: { from: 26, to: 26 } });
    expect(landed.windows[0]!.events).toEqual([{ ordinal: 26, kind: "user", text: "late window-needle", timestamp: "n3" }]);
  });

  test("excerpt clips context events harder than hits", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), [
      { type: "assistant", timestamp: "c1", message: { role: "assistant", content: "c".repeat(500) } },
      { type: "assistant", timestamp: "c2", message: { role: "assistant", content: "h".repeat(250) + " context-needle " + "h".repeat(250) } },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const [context, hit] = (await catalog.excerpt("claude-a", { around: ["context-needle"], context: 1 })).windows[0]!.events.slice(-2);
    expect(context!.text.length).toBeLessThan(hit!.text.length);
    expect(hit!.text.length).toBeLessThanOrEqual(302);
    expect([context!.length, hit!.length]).toEqual([500, 516]);
  });

  test("excerpt reads child threads by id or prefix and rejects unknown positions", async () => {
    const { catalog } = setup();
    const child = await catalog.excerpt("claude-a", { at: { thread: "sub", from: 1, to: 1 }, context: 1 });
    expect(child.windows.map(({ thread, label, from, to, events }) => ({ thread, label, from, to, kinds: events.map(({ kind }) => kind) }))).toEqual([
      { thread: "sub1", label: "Find launch agent", from: 0, to: 2, kinds: ["user", "tool_call", "tool_output"] },
    ]);
    const offloaded = await catalog.excerpt("claude-a", { around: ["fixture-offloaded-result"], context: 0 });
    expect(offloaded.windows).toEqual([{ thread: "toolu_big.txt", label: "toolu_big.txt", from: 1, to: 1, hits: [1],
      events: [{ ordinal: 1, kind: "tool_output", text: "fixture-offloaded-result", timestamp: "" }] }]);
    for (const at of [{ thread: "missing", from: 0, to: 0 }, { from: 99, to: 99 }, { from: 2, to: 1 }])
      await expect(catalog.excerpt("claude-a", { at })).rejects.toMatchObject({ code: "invalid" });
  });

  test("deep search combines summary fields with readable Transcript text", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), JSON.stringify({
      type: "assistant", sessionId: "claude-a", message: { role: "assistant", content: "special \"quoted\" C:\\temp\nnext" },
    }) + "\n");
    expect((await catalog.find({ terms: ["LEGACY NOTE"] })).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find({ terms: ["CODEX-B"] })).results.map(({ id }) => id)).toContain("codex-b");
    const rollout = (await catalog.list()).find(({ id }) => id === "codex-b")!;
    expect((await catalog.find({ terms: [basename(rollout.source_path, ".jsonl")] })).results.map(({ id }) => id)).toContain("codex-b");
    expect((await catalog.find({ terms: ["FIXTURE-ASSISTANT-CODEX"] })).results.map(({ id }) => id)).toEqual(["codex-b"]);
    expect((await catalog.find({ terms: ["\"quoted\""] })).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find({ terms: [String.raw`C:\temp`] })).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find({ terms: ["temp\nnext"] })).results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect((await catalog.find({ terms: ["fixture-user-[codex"] })).results).toEqual([]);
    expect((await catalog.find({ terms: ["x".repeat(50)] })).results).toEqual([]);
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

  test("persists pins across Catalog restart and drops the mark once unpinned", async () => {
    const { home, catalog } = setup();
    const marks = join(home, ".local/share/session-snapshots/stars.json");
    await catalog.updateMark("claude-a", { star: false, note: "", pin: true });
    expect((await new SessionCatalog({ home }).list({ fresh: true })).find(({ id }) => id === "claude-a")?.pinned).toBe(true);
    await catalog.updateMark("claude-a", { pin: false });
    expect(JSON.parse(readFileSync(marks, "utf8"))["claude-a"]).toBeUndefined();
    expect((await new SessionCatalog({ home }).list({ fresh: true })).find(({ id }) => id === "claude-a")?.pinned).toBeUndefined();
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

describe("SessionCatalog search robustness", () => {
  const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const padding = lines([{ padding: "x".repeat(2200) }]);

  test("detail keeps tool calls, tool output, and thinking out of the Transcript for every tool", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".claude/projects/-tmp-alpha/claude-a.jsonl"), lines([
      { type: "assistant", timestamp: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: "claude-thinking-secret" }, { type: "tool_use", id: "u1", name: "Bash", input: { command: "claude-call-secret" } }] } },
      { type: "user", timestamp: "t2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: [{ type: "text", text: "claude-output-secret" }] }] }, toolUseResult: { stdout: "claude-output-secret" } },
    ]));
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines([
      { type: "response_item", timestamp: "t1", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"codex-call-secret\"}", call_id: "c" } },
      { type: "response_item", timestamp: "t2", payload: { type: "function_call_output", call_id: "c", output: "codex-output-secret" } },
      { type: "event_msg", timestamp: "t3", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["zsh", "-lc", "codex-command-secret"], aggregated_output: "codex-aggregated-secret" } } },
    ]));
    appendFileSync(join(home, ".pi/agent/sessions/-tmp-gamma/pi-c.jsonl"), lines([
      { type: "message", timestamp: "t1", message: { role: "assistant", content: [{ type: "thinking", thinking: "pi-thinking-secret" }, { type: "toolCall", id: "p", name: "bash", arguments: { command: "pi-call-secret" } }] } },
      { type: "message", timestamp: "t2", message: { role: "toolResult", toolCallId: "p", toolName: "bash", content: [{ type: "text", text: "pi-output-secret" }] } },
    ]));
    for (const id of ["claude-a", "codex-b", "pi-c"]) {
      const { messages } = await catalog.detail(id);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.filter(({ text }) => text.includes("secret"))).toEqual([]);
    }
    // The same records stay searchable.
    expect((await catalog.find({ terms: ["pi-output-secret"] })).results.map(({ id }) => id)).toEqual(["pi-c"]);
  });

  test("scans every file when a search spans more than one ripgrep batch", async () => {
    const { home, catalog } = setup();
    const directory = join(home, ".claude/projects/-tmp-alpha/claude-a/tool-results");
    for (let index = 0; index < 140; index++) writeFileSync(join(directory, `r${String(index).padStart(3, "0")}.txt`), `filler\nbatch-needle ${index}\n`);
    const { results, coverage } = await catalog.find({ terms: ["batch-needle"] });
    expect(results.map(({ id }) => id)).toEqual(["claude-a"]);
    expect(results[0]!.match.threads.length).toBe(140);
    expect(coverage).toMatchObject({ scanned_files: 148, candidate_files: 140, unreadable_files: 0 });
  });

  test("survives a child chain that loops back on itself", async () => {
    const { home, catalog } = setup();
    const directory = join(home, ".codex/sessions/2026/07/14");
    for (const [id, parent] of [["loop-a", "loop-b"], ["loop-b", "loop-a"]])
      writeFileSync(join(directory, `rollout-2026-07-14T07-00-00-${id}.jsonl`), lines([
        { timestamp: "2026-07-14T07:00:00Z", payload: { id, cwd: "/tmp/loop", thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: parent } } }, parent_thread_id: parent, agent_nickname: id } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "loop-needle" }] } },
      ]));
    const { results, coverage } = await catalog.find({ terms: ["loop-needle"] });
    expect(results).toEqual([]);
    expect(coverage.orphans.map(({ label }) => label).sort()).toEqual(["loop-a", "loop-b"]);
  });

  test("keeps results and reports an unreadable child directory or file instead of failing", async () => {
    const { home, catalog } = setup();
    const subagents = join(home, ".claude/projects/-tmp-alpha/claude-a/subagents"), offloaded = join(home, ".claude/projects/-tmp-alpha/claude-a/tool-results/toolu_big.txt");
    chmodSync(subagents, 0o000);
    chmodSync(offloaded, 0o000);
    try {
      const kept = await catalog.find({ terms: ["fixture-user-claude"] });
      expect(kept.results.map(({ id }) => id)).toEqual(["claude-a"]);
      expect(catalog.sourceDiagnostics().filter(({ level, message }) => level === "error" && message.includes(subagents))).toHaveLength(1);

      const blocked = await catalog.find({ terms: ["fixture-offloaded-result"] });
      expect(blocked.results).toEqual([]);
      expect(blocked.coverage).toMatchObject({ unreadable_files: 2 });
      expect([...blocked.coverage.unreadable].sort()).toEqual([offloaded, subagents].sort());
      expect(blocked.coverage.candidate_files).toBe(2);
    } finally {
      chmodSync(subagents, 0o755);
      chmodSync(offloaded, 0o644);
    }
  });

  test("ANDs terms across the history_base segments of a continued Codex rollout", async () => {
    const { home, catalog } = setup();
    const directory = join(home, ".codex/sessions/2026/07/15");
    mkdirSync(directory, { recursive: true });
    const older = lines([
      { timestamp: "2026-07-15T01:00:00Z", payload: { id: "seg-old", cwd: "/tmp/seg", timestamp: "2026-07-15T01:00:00Z" } },
      { type: "response_item", timestamp: "2026-07-15T01:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "segment-old-needle" }] } },
    ]);
    writeFileSync(join(directory, "rollout-2026-07-15T01-00-00-seg-old.jsonl"), older + padding);
    writeFileSync(join(directory, "rollout-2026-07-15T02-00-00-seg-new.jsonl"), lines([
      { timestamp: "2026-07-15T02:00:00Z", payload: { id: "seg-new", cwd: "/tmp/seg", timestamp: "2026-07-15T02:00:00Z", history_base: { thread_id: "seg-old", end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(older) } } },
      { type: "response_item", timestamp: "2026-07-15T02:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "segment-new-needle" }] } },
    ]) + padding);
    const split = await catalog.find({ terms: ["segment-old-needle", "segment-new-needle"] });
    expect(split.results.map(({ id }) => id)).toEqual(["seg-new"]);
    expect(split.coverage.candidate_files).toBe(split.coverage.partial_files + 2);
    const excerpt = await catalog.excerpt("seg-new", { around: ["segment-old-needle"] });
    expect(excerpt.windows.map(({ thread, hits }) => ({ thread, hits }))).toEqual([{ thread: "main", hits: [0] }]);
  });

  test("follows a history_base whose older segment Codex compressed to .jsonl.zst", async () => {
    const { home, catalog } = setup();
    const directory = join(home, ".codex/sessions/2026/07/15");
    mkdirSync(directory, { recursive: true });
    const older = lines([
      { timestamp: "2026-07-15T01:00:00Z", payload: { id: "zst-old", cwd: "/tmp/seg", timestamp: "2026-07-15T01:00:00Z" } },
      { type: "response_item", timestamp: "2026-07-15T01:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "zst-old-needle" }] } },
    ]);
    writeFileSync(join(directory, "rollout-2026-07-15T01-00-00-zst-old.jsonl.zst"), Bun.zstdCompressSync(older + padding));
    writeFileSync(join(directory, "rollout-2026-07-15T02-00-00-zst-new.jsonl"), lines([
      { timestamp: "2026-07-15T02:00:00Z", payload: { id: "zst-new", cwd: "/tmp/seg", timestamp: "2026-07-15T02:00:00Z", history_base: { thread_id: "zst-old", end_ordinal_exclusive: 1, end_byte_offset: Buffer.byteLength(older) } } },
      { type: "response_item", timestamp: "2026-07-15T02:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "zst-new-needle" }] } },
    ]) + padding);
    const { results, coverage } = await catalog.find({ terms: ["zst-old-needle", "zst-new-needle"] });
    expect(results.map(({ id }) => id)).toEqual(["zst-new"]);
    expect(coverage.unreadable_files).toBe(0);
  });

  test("searches .jsonl.zst in process when the zstd program ripgrep needs is missing", async () => {
    const { home } = setup();
    const rollout = join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl");
    writeFileSync(rollout + ".zst", Bun.zstdCompressSync(readFileSync(rollout)));
    rmSync(rollout);
    // Bun.which and Bun.spawn read the PATH the process started with, so run find in a child without zstd.
    const script = `const { SessionCatalog } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/catalog.ts")).href)});
      const { results, coverage } = await new SessionCatalog({ home: ${JSON.stringify(home)}, rgPath: ${JSON.stringify(Bun.which("rg"))} }).find({ terms: ["FIXTURE-ASSISTANT-CODEX"] });
      console.log(JSON.stringify({ ids: results.map(({ id }) => id), unreadable: coverage.unreadable_files }));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: "/nonexistent", HOME: home } });
    expect(JSON.parse(child.stdout.toString())).toEqual({ ids: ["codex-b"], unreadable: 0 });
  });

  test("repeated searches over continued Codex rollouts keep the open file count flat", async () => {
    const { home, catalog } = setup();
    const directory = join(home, ".codex/sessions/2026/07/15");
    mkdirSync(directory, { recursive: true });
    const older = lines([{ timestamp: "2026-07-15T01:00:00Z", payload: { id: "fd-old", cwd: "/tmp/fd", timestamp: "2026-07-15T01:00:00Z" } }]);
    writeFileSync(join(directory, "rollout-2026-07-15T01-00-00-fd-old.jsonl"), older + padding);
    writeFileSync(join(directory, "rollout-2026-07-15T02-00-00-fd-new.jsonl"), lines([
      { timestamp: "2026-07-15T02:00:00Z", payload: { id: "fd-new", cwd: "/tmp/fd", timestamp: "2026-07-15T02:00:00Z", history_base: { thread_id: "fd-old", end_ordinal_exclusive: 0, end_byte_offset: Buffer.byteLength(older) } } },
      { type: "response_item", timestamp: "2026-07-15T02:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fd-needle" }] } },
    ]) + padding);
    const open = () => readdirSync("/dev/fd").length;
    await catalog.find({ terms: ["fd-needle"] });
    const before = open();
    for (let round = 0; round < 40; round++) await catalog.find({ terms: ["fd-needle"] });
    expect(open() - before).toBeLessThan(5);
  });

  test("separates owners that hold only some terms in readable events from raw hits with no readable event", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines([
      { type: "event_msg", timestamp: "t1", payload: { type: "item_completed", item: { type: "AgentMessage", text: "unprojected-needle" } } },
    ]));
    const { results, coverage } = await catalog.find({ terms: ["fixture-user-codex", "unprojected-needle"] });
    expect(results).toEqual([]);
    expect(coverage).toMatchObject({ candidate_files: 1, partial_files: 1, unclassified_files: 0 });
    expect((await catalog.find({ terms: ["unprojected-needle"] })).coverage).toMatchObject({ candidate_files: 1, partial_files: 0, unclassified_files: 1 });
  });

  test("keeps a window for every term when the window limit cuts the rest", async () => {
    const { home, catalog } = setup();
    const say = (text: string) => ({ type: "response_item", timestamp: "t1", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
    const gap = Array.from({ length: 6 }, () => say("unrelated"));
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines([
      say("pick-alpha one"), ...gap, say("pick-alpha two"), ...gap, say("pick-alpha three"), ...gap, say("pick-beta last"),
    ]));
    const excerpt = await catalog.excerpt("codex-b", { around: ["pick-alpha", "pick-beta"], context: 0, windows: 2 });
    const text = excerpt.windows.flatMap(({ events }) => events.map(({ text: value }) => value)).join("\n");
    expect(text).toContain("pick-alpha one");
    expect(text).toContain("pick-beta last");
    expect(excerpt.omitted_windows).toBe(2);
  });

  test("a clipped event keeps a span for every term it holds", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines([
      { type: "response_item", timestamp: "t1", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `span-left ${"x".repeat(3000)} span-right` }] } },
    ]));
    const excerpt = await catalog.excerpt("codex-b", { around: ["span-left", "span-right"], context: 0, chars: 200 });
    const event = excerpt.windows[0]!.events[0]!;
    expect(event.text).toContain("span-left");
    expect(event.text).toContain("span-right");
    expect(event.text.length).toBeLessThan(260);
  });

  test("a long run of adjacent hits splits into bounded windows", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines(Array.from({ length: 60 }, (_, index) => (
      { type: "response_item", timestamp: "t1", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `run-needle ${index}` }] } }))));
    const excerpt = await catalog.excerpt("codex-b", { around: ["run-needle"], windows: 100 });
    expect(excerpt.windows.length).toBeGreaterThan(1);
    for (const { from, to } of excerpt.windows) expect(to - from + 1).toBeLessThanOrEqual(24);
    expect(excerpt.windows.flatMap(({ hits }) => hits)).toHaveLength(60);
  });

  test("centres tool output clips and snippets on the hit in the output, not the echoed command", async () => {
    const { home, catalog } = setup();
    appendFileSync(join(home, ".codex/sessions/2026/07/14/rollout-codex-b.jsonl"), lines([
      { type: "event_msg", timestamp: "t1", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["zsh", "-lc", "launchctl print clip-needle"], aggregated_output: "y".repeat(2000) + " clip-needle found-here " + "z".repeat(40) } } },
    ]));
    const { results } = await catalog.find({ terms: ["clip-needle"] });
    expect(results[0]!.match.best[0]!.snippet).toContain("found-here");
    const [window] = (await catalog.excerpt("codex-b", { around: ["clip-needle"], context: 0 })).windows;
    expect(window!.events[0]!.text).toContain("found-here");
    expect(window!.events[0]!.text.length).toBeLessThanOrEqual(302);
  });

  test("discovers agy sessions (<2KB), unwraps envelopes, reads WAL SQLite + pbtxt, projects events, and handles subagents", async () => {
    const { home, catalog } = setup();
    const agyRoot = join(home, ".gemini/antigravity-cli");
    const writeLog = (id: string, name: string, records: unknown[]) => {
      const dir = join(agyRoot, "brain", id, ".system_generated", "logs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    };
    writeLog("agy-main", "transcript_full.jsonl", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T08:00:00Z", content: "<USER_REQUEST>\nmain agy question\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta-only-needle\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nignored\n</USER_SETTINGS_CHANGE>" },
      { step_index: 1, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", created_at: "2026-11-25T08:00:01Z", content: "<EXTREMELY_IMPORTANT>hook-injected-needle</EXTREMELY_IMPORTANT>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T08:00:02Z", model: "gemini-4-neon-high", thinking: "pondering", content: "main agy answer", tool_calls: [{ name: "read_file", args: { Path: "/tmp/file.ts" } }] },
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T08:00:03Z", content: "tool-out-needle" },
      { step_index: 4, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-11-25T08:00:04Z", content: "checkpoint-injected-needle" },
      { step_index: 5, source: "SYSTEM", type: "UNKNOWN_FUTURE_STEP", status: "DONE", created_at: "2026-11-25T08:00:05Z", content: "future-noise-needle" },
    ]);
    // Sibling compact file must be ignored when transcript_full.jsonl exists.
    writeLog("agy-main", "transcript.jsonl", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T08:00:00Z", content: "compact-only-needle" },
    ]);
    // Fallback session with only transcript.jsonl (< 2KB)
    writeLog("agy-compact", "transcript.jsonl", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T07:00:00Z", content: "compact fallback" },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T07:00:01Z", model: "gemini-3.8-flash-low", content: "ok" },
    ]);
    // Child and orphan subagent sessions
    writeLog("agy-child", "transcript_full.jsonl", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T08:01:00Z", content: "child task" },
      { step_index: 1, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T08:01:02Z", content: "agy-child-needle" },
    ]);
    writeLog("agy-orphan", "transcript_full.jsonl", [
      { step_index: 0, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T08:02:00Z", content: "agy-orphan-needle" },
    ]);

    const db = new Database(join(agyRoot, "conversation_summaries.db"), { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, parent_conversation_id TEXT, agent_name TEXT)");
    db.run("CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)");
    const ws = join(home, "work/repo");
    mkdirSync(ws, { recursive: true });
    db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run("agy-main", "DB Title", JSON.stringify([pathToFileURL(ws).href]), "", "");
    db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run("agy-child", "Child Title", JSON.stringify([pathToFileURL(ws).href]), "agy-main", "Codebase Researcher");
    db.query("INSERT INTO conversation_parents VALUES (?, ?)").run("agy-orphan", "missing-parent");
    db.close();

    mkdirSync(join(agyRoot, "annotations"), { recursive: true });
    // Octal UTF-8 for "中" is \344\270\255
    writeFileSync(join(agyRoot, "annotations/agy-main.pbtxt"), 'title:"Agy \\344\\270\\255 Title"  plan_execute:true\n');

    const rows = (await catalog.list({ fresh: true })).filter((row) => row.tool === "agy");
    expect(rows.map((row) => row.id).sort()).toEqual(["agy-compact", "agy-main"]);
    const main = rows.find((row) => row.id === "agy-main")!;
    expect(main).toMatchObject({
      tool: "agy",
      cwd: ws,
      name: "Agy 中 Title",
      first_msg: "main agy question",
      model: "gemini-4-neon-high",
    });

    const detail = await catalog.detail("agy-main");
    expect(detail.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "main agy question" },
      { role: "assistant", text: "main agy answer" },
    ]);

    // Envelopes/injected records do not leak into search results, while tool outputs and child threads match.
    expect((await catalog.find({ terms: ["meta-only-needle"] })).results).toEqual([]);
    expect((await catalog.find({ terms: ["hook-injected-needle"] })).coverage).toMatchObject({ injected_only_files: 1, unclassified_files: 0 });
    expect((await catalog.find({ terms: ["checkpoint-injected-needle"] })).coverage).toMatchObject({ injected_only_files: 1, unclassified_files: 0 });
    expect((await catalog.find({ terms: ["future-noise-needle"] })).coverage).toMatchObject({ unclassified_files: 1 });
    expect((await catalog.find({ terms: ["compact-only-needle"] })).results).toEqual([]);
    expect((await catalog.find({ terms: ["agy-child-needle"] })).results.map(({ id, match }) => ({ id, threads: match.threads }))).toEqual([
      { id: "agy-main", threads: [{ thread: "agy-child", label: "Codebase Researcher", hits: 1 }] },
    ]);
    expect((await catalog.find({ terms: ["agy-orphan-needle"] })).coverage).toMatchObject({ orphan_files: 1 });
  });

  test("renames agy sessions natively on disk (pbtxt + sqlite) and optionally via ConversationService", async () => {
    const { home } = setup();
    const agyRoot = join(home, ".gemini/antigravity-cli");
    const dir = join(agyRoot, "brain/agy-rename-1/.system_generated/logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "transcript_full.jsonl"), JSON.stringify({
      step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T08:00:00Z", content: "hello",
    }) + "\n");
    mkdirSync(join(agyRoot, "annotations"), { recursive: true });
    writeFileSync(join(agyRoot, "annotations/agy-rename-1.pbtxt"), 'title:"Old Title"  plan_execute:true\n');
    const db = new Database(join(agyRoot, "conversation_summaries.db"), { create: true });
    db.run("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT)");
    db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?)").run("agy-rename-1", "Old Title", JSON.stringify([pathToFileURL(home).href]));
    db.close();

    const diskCatalog = new SessionCatalog({ home, agyLsAddress: null, agyCsrfToken: null });
    await diskCatalog.updateMark("agy-rename-1", { star: true });
    const marksFile = join(home, ".local/share/session-snapshots/stars.json");
    writeFileSync(marksFile, JSON.stringify({ "agy-rename-1": { starred: true, name: "Stale Local Name" } }));

    await diskCatalog.rename("agy-rename-1", 'New "Quoted" Title');
    expect(readFileSync(join(agyRoot, "annotations/agy-rename-1.pbtxt"), "utf8")).toBe('title:"New \\"Quoted\\" Title"  plan_execute:true\n');
    const checkDb = new Database(join(agyRoot, "conversation_summaries.db"), { readonly: true });
    expect(checkDb.query("SELECT title FROM conversation_summaries WHERE conversation_id = ?").get("agy-rename-1")).toEqual({ title: 'New "Quoted" Title' });
    checkDb.close();
    expect(JSON.parse(readFileSync(marksFile, "utf8"))["agy-rename-1"].name).toBeUndefined();
    expect((await diskCatalog.list({ fresh: true })).find((row) => row.id === "agy-rename-1")?.name).toBe('New "Quoted" Title');

    const rpcCalls: unknown[] = [];
    const mockLs = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/product.v1.ConversationService/UpdateConversation"
          && req.headers.get("x-antigravity-csrf-token") === "test-csrf") {
          rpcCalls.push(await req.json());
          return Response.json({ ok: true });
        }
        return new Response("nope", { status: 403 });
      },
    });
    cleanups.push(() => mockLs.stop(true));
    const rpcCatalog = new SessionCatalog({ home, agyLsAddress: `127.0.0.1:${mockLs.port}`, agyCsrfToken: "test-csrf" });
    await rpcCatalog.rename("agy-rename-1", "RPC Renamed");
    expect(rpcCalls).toEqual([{ conversationId: "agy-rename-1", annotations: { title: "RPC Renamed" } }]);
  });
});
