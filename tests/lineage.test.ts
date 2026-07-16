import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Session, Tool } from "../src/contracts.ts";
import { LineageIndex } from "../src/lineage.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-sessions-lineage-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, records: unknown[]) => {
    const path = join(root, `${name}.jsonl`);
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return path;
  };
  const session = (id: string, tool: Tool, source_path: string, birth: number): Session => ({
    id, tool, source_path, cwd: root, name: id, first_msg: id, birth, mtime: birth,
    size_kb: 1, model: "fixture", starred: false, star_note: "", archived: false, status: "",
  });
  return { root, write, session, index: new LineageIndex(join(root, "lineage.sqlite")) };
}

function codexTurn(turn: string, at: string, user: string, writes: { path: string; type?: "add" | "update" | "delete" }[] = []) {
  return [
    { timestamp: at, type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }], internal_chat_message_metadata_passthrough: { turn_id: turn } } },
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: user } },
    ...writes.map((write) => ({ timestamp: at, type: "event_msg", payload: {
      type: "patch_apply_end", turn_id: turn, success: true,
      changes: { [write.path]: { type: write.type ?? "add" } },
    } })),
  ];
}

describe("LineageIndex", () => {
  test("links assistant writes from the last three turns to user references in the first two turns", () => {
    const { root, write, session, index } = setup();
    const ignored = join(root, "ignored.md"), handoff = join(root, "handoff.md"), plan = join(root, "plan.md"), deleted = join(root, "deleted.md"), windowsDoc = String.raw`C:\handoff.html`;
    const aPath = write("a", [
      ...codexTurn("a1", "2026-07-15T01:00:00Z", "first", [{ path: ignored }]),
      ...codexTurn("a2", "2026-07-15T02:00:00Z", "second"),
      ...codexTurn("a3", "2026-07-15T03:00:00Z", "third"),
      ...codexTurn("a4", "2026-07-15T04:00:00Z", "handoff", [{ path: handoff }, { path: windowsDoc }, { path: deleted, type: "delete" }]),
      { timestamp: "2026-07-15T05:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "a-empty-1" } },
      { timestamp: "2026-07-15T06:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "a-empty-2" } },
      { timestamp: "2026-07-15T07:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "a-empty-3" } },
    ]);
    const bPath = write("b", [
      { timestamp: "2026-07-16T00:10:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "b-empty-1" } },
      { timestamp: "2026-07-16T00:20:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "b-empty-2" } },
      { timestamp: "2026-07-16T00:30:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "b-empty-3" } },
      ...codexTurn("b1", "2026-07-16T01:00:00Z", "start"),
      ...codexTurn("b2", "2026-07-16T02:00:00Z", `read ${handoff}:12, ${windowsDoc}, but not ${deleted}`),
      ...codexTurn("b3", "2026-07-16T03:00:00Z", "write the plan", [{ path: plan }]),
      ...codexTurn("b4", "2026-07-16T04:00:00Z", `too late ${ignored}`),
    ]);
    const cPath = write("c", [
      { timestamp: "2026-07-17T01:00:00Z", type: "event_msg", payload: { type: "thread_goal_updated", goal: { objective: `implement ${plan}` } } },
      ...codexTurn("c1", "2026-07-17T01:00:00Z", `implement ${plan}`),
    ]);
    const sessions = [
      session("a", "codex", aPath, 1), session("b", "codex", bPath, 2), session("c", "codex", cPath, 3),
    ];

    expect(index.refresh(sessions, true)).toMatchObject({ scanned: 3, sessions: 3, edges: 3 });
    expect(index.lineage("b")).toEqual({
      session_ids: ["a", "b", "c"],
      edges: [
        expect.objectContaining({ upstream_id: "a", downstream_id: "b", path: handoff, reference_source: "user" }),
        expect.objectContaining({ upstream_id: "a", downstream_id: "b", path: windowsDoc, reference_source: "user" }),
        expect.objectContaining({ upstream_id: "b", downstream_id: "c", path: plan, reference_source: "user" }),
      ],
    });
    expect(new LineageIndex(join(root, "lineage.sqlite")).all()).toMatchObject({
      session_ids: ["a", "b", "c"], edges: expect.any(Array),
    });
  });

  test("ignores goal and assistant references, third user turn, and user-only producer mentions", () => {
    const { root, write, session, index } = setup();
    const written = join(root, "written.md"), mentioned = join(root, "mentioned.md");
    const producerPath = write("producer", codexTurn("p1", "2026-07-15T01:00:00Z", `I mentioned ${mentioned}`, [{ path: written }]));
    const assistantConsumerPath = write("assistant-consumer", [
      { timestamp: "2026-07-15T02:00:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `read ${written}` }] } },
    ]);
    const lateConsumerPath = write("late-consumer", [
      { timestamp: "2026-07-15T03:00:00Z", type: "event_msg", payload: { type: "thread_goal_updated", goal: { objective: `use ${written}` } } },
      ...codexTurn("c1", "2026-07-15T03:01:00Z", "first"),
      ...codexTurn("c2", "2026-07-15T03:02:00Z", "second"),
      ...codexTurn("c3", "2026-07-15T03:03:00Z", `third ${written} ${mentioned}`),
    ]);
    const sessions = [
      session("producer", "codex", producerPath, 1),
      session("assistant-consumer", "codex", assistantConsumerPath, 2),
      session("late-consumer", "codex", lateConsumerPath, 3),
    ];

    expect(index.refresh(sessions, true)).toMatchObject({ writes: 1, references: 1, edges: 0 });
  });

  test("uses the most recent prior writer and refreshes only changed sessions", () => {
    const { root, write, session, index } = setup();
    const shared = join(root, "shared.html");
    const aPath = write("a", codexTurn("a1", "2026-07-15T01:00:00Z", "a", [{ path: shared }]));
    const bPath = write("b", codexTurn("b1", "2026-07-15T02:00:00Z", "b", [{ path: shared, type: "update" }]));
    const cPath = write("c", [
      ...codexTurn("c1", "2026-07-15T03:00:00Z", shared),
      ...codexTurn("c2", "2026-07-15T04:00:00Z", `still using ${shared}`),
    ]);
    const sessions = [session("a", "codex", aPath, 1), session("b", "codex", bPath, 2), session("c", "codex", cPath, 3)];

    expect(index.refresh(sessions, true).scanned).toBe(3);
    expect(index.lineage("c").edges).toEqual([
      expect.objectContaining({ upstream_id: "b", downstream_id: "c", path: shared }),
    ]);
    expect(index.refresh(sessions).scanned).toBe(0);

    writeFileSync(cPath, readFile(cPath) + "\n");
    expect(index.refresh(sessions).scanned).toBe(1);
    expect(index.refresh(sessions.slice(1)).removed).toBe(1);
  });

  test("extracts successful Claude and pi writes but ignores injected and tool-result paths", () => {
    const { root, write, session, index } = setup();
    const claudeDoc = join(root, "claude.md"), piDoc = join(root, "pi.html");
    const claudePath = write("claude", [
      { type: "user", timestamp: "2026-07-15T01:00:00Z", message: { role: "user", content: "make a handoff" } },
      { type: "assistant", timestamp: "2026-07-15T01:01:00Z", message: { role: "assistant", content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: claudeDoc } }] } },
      { type: "user", timestamp: "2026-07-15T01:02:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] }, toolUseResult: { type: "create", filePath: claudeDoc } },
    ]);
    const piPath = write("pi", [
      { type: "message", timestamp: "2026-07-15T02:00:00Z", message: { role: "user", content: [{ type: "text", text: `continue ${claudeDoc}` }] } },
      { type: "message", timestamp: "2026-07-15T02:01:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "write", arguments: { path: piDoc } }] } },
      { type: "message", timestamp: "2026-07-15T02:02:00Z", message: { role: "toolResult", toolCallId: "p1", toolName: "write", isError: false } },
    ]);
    const consumerPath = write("consumer", [
      { type: "response_item", timestamp: "2026-07-15T03:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `# AGENTS.md instructions ${join(root, "noise.md")}` }] } },
      { type: "response_item", timestamp: "2026-07-15T03:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `use ${piDoc}` }] } },
    ]);
    const sessions = [
      session("claude", "claude", claudePath, 1), session("pi", "pi", piPath, 2), session("consumer", "codex", consumerPath, 3),
    ];

    index.refresh(sessions, true);
    expect(index.lineage("pi").edges).toEqual([
      expect.objectContaining({ upstream_id: "claude", downstream_id: "pi", path: claudeDoc }),
      expect.objectContaining({ upstream_id: "pi", downstream_id: "consumer", path: piDoc }),
    ]);
  });
});

const readFile = (path: string): string => readFileSync(path, "utf8");
