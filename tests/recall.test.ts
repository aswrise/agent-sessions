import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionCatalog } from "../src/catalog.ts";

const TERMS = ["zeta7", "quux9", "say\"hi", "c:\\tmp9", "召回词", "Kappa3"];
type Placement = "projected" | "injected" | "noise";
type Tool = "claude" | "codex" | "pi" | "agy";
type GeneratedFile = { path: string; placed: Map<string, Set<Placement>>; unreadable?: true };
type GeneratedOwner = { id?: string; orphan: boolean; threads: GeneratedFile[][] };

const SEEDS = Number(process.env.RECALL_SEEDS ?? 6);
const roots: string[] = [];
const locked: string[] = [];
const cleanup = () => {
  locked.splice(0).forEach((path) => chmodSync(path, 0o644));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
};
afterEach(cleanup);

function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Injected text starts with "<" so no adapter takes it as the first message, which find would rightly match as a meta field.
/** Builds random Claude, Codex and pi homes and records, for every planted term, whether find is meant to see it. */
function generate(seed: number): { home: string; owners: GeneratedOwner[] } {
  const random = prng(seed), pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const root = mkdtempSync(join(tmpdir(), "agent-sessions-recall-")), home = join(root, "home");
  roots.push(root);
  const owners: GeneratedOwner[] = [];
  const agyParents: [string, string][] = [];
  let serial = 0;
  const write = (path: string, lines: string[]) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, lines.join("\n") + "\n"); };
  const plant = (file: GeneratedFile, placement: Placement) => {
    const terms = TERMS.filter(() => random() < 0.25);
    for (const term of terms) (file.placed.get(term) ?? file.placed.set(term, new Set()).get(term)!).add(placement);
    return `filler ${terms.map((term) => random() < 0.5 ? term.toUpperCase() : term).join(" mid ")} end`;
  };
  const records = (tool: Tool, file: GeneratedFile): string[] => Array.from({ length: 2 + Math.floor(random() * 6) }, () => {
    const slot = pick(["user", "assistant", "thinking", "call", "output", "injected", "noise"] as const);
    const placement: Placement = slot === "injected" ? "injected" : slot === "noise" ? "noise" : "projected";
    const text = plant(file, placement);
    if (tool === "claude") switch (slot) {
      case "user": return { type: "user", message: { role: "user", content: text } };
      case "assistant": return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
      case "thinking": return { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
      case "call": return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: text } }] } };
      case "output": return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] }, toolUseResult: { stdout: text } };
      case "injected": return { type: "user", message: { role: "user", content: `<skill>\n${text}` } };
      case "noise": return { type: "attachment", attachment: { type: "text", content: text } };
    }
    if (tool === "codex") switch (slot) {
      case "user": return { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } };
      case "assistant": case "thinking": return { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } };
      case "call": return { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: text } };
      case "output": return random() < 0.5
        ? { type: "response_item", payload: { type: "function_call_output", output: text } }
        : { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["sh"], aggregated_output: text } } };
      case "injected": return { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>${text}` }] } };
      case "noise": return { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", text } } };
    }
    if (tool === "agy") switch (slot) {
      case "user": return { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignore\n</ADDITIONAL_METADATA>` };
      case "assistant": return { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: text };
      case "thinking": return { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", thinking: text };
      case "call": return { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: text } }] };
      case "output": return { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", content: text };
      case "injected": return random() < 0.5
        ? { step_index: 5, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", content: `<EXTREMELY_IMPORTANT>${text}</EXTREMELY_IMPORTANT>` }
        : { step_index: 5, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", content: text };
      case "noise": return { step_index: 6, source: "SYSTEM", type: "AMBIENT_NOISE", status: "DONE", data: text };
    }
    switch (slot) {
      case "user": return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
      case "assistant": return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
      case "thinking": return { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: text }] } };
      case "call": return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "p", name: "bash", arguments: { command: text } }] } };
      case "output": return { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } };
      case "injected": return { type: "message", message: { role: "user", content: [{ type: "text", text: `<skill>${text}` }] } };
      case "noise": return { type: "custom", data: text };
    }
  }).map((record) => JSON.stringify(record));
  const padding = JSON.stringify({ padding: "p".repeat(2100) });
  for (let index = 0; index < 12; index++) {
    const tool = pick(["claude", "codex", "pi", "agy"] as const), id = `s${seed}x${serial++}`, owner: GeneratedOwner = { id, orphan: false, threads: [[]] };
    const main: GeneratedFile = { path: "", placed: new Map() };
    owner.threads[0]!.push(main);
    if (tool === "claude") {
      main.path = join(home, ".claude/projects/-tmp-p", `${id}.jsonl`);
      write(main.path, [JSON.stringify({ type: "system", sessionId: id, cwd: "/tmp/p" }), ...records("claude", main), padding]);
    } else if (tool === "codex") {
      main.path = join(home, ".codex/sessions/2026/07/14", `rollout-${id}.jsonl`);
      const meta: Record<string, unknown> = { id, cwd: "/tmp/p" };
      if (random() < 0.3) {
        // The older segment is a row of its own and also part of the continuing row's main thread, up to end_byte_offset.
        const older: GeneratedFile = { path: join(home, ".codex/sessions/2026/07/14", `rollout-${id}o.jsonl`), placed: new Map() };
        const body = [JSON.stringify({ type: "session_meta", payload: { id: `${id}o`, cwd: "/tmp/p" } }), ...records("codex", older)].join("\n") + "\n";
        mkdirSync(dirname(older.path), { recursive: true });
        writeFileSync(older.path, body + padding + "\n");
        meta.history_base = { thread_id: `${id}o`, end_byte_offset: Buffer.byteLength(body) };
        owner.threads[0]!.push(older);
        owners.push({ id: `${id}o`, orphan: false, threads: [[older]] });
      }
      write(main.path, [JSON.stringify({ type: "session_meta", payload: meta }), ...records("codex", main), padding]);
    } else if (tool === "agy") {
      main.path = join(home, `.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`);
      write(main.path, [...records("agy", main), padding]);
    } else {
      main.path = join(home, ".pi/agent/sessions/-tmp-p", `${id}.jsonl`);
      write(main.path, [JSON.stringify({ type: "session", id, cwd: "/tmp/p" }), ...records("pi", main), padding]);
    }
    owners.push(owner);
    for (let child = 0; tool !== "pi" && child < Math.floor(random() * 3); child++) {
      const orphan = random() < 0.3, parent = orphan ? `gone${serial++}` : id, file: GeneratedFile = { path: "", placed: new Map() };
      if (orphan) owners.push({ orphan: true, threads: [[file]] }); else owner.threads.push([file]);
      if (tool === "codex") {
        file.path = join(home, ".codex/sessions/2026/07/14", `rollout-kid${serial++}.jsonl`);
        write(file.path, [JSON.stringify({ type: "session_meta", payload: { id: `kid${serial++}`, thread_source: "subagent", parent_thread_id: parent } }), ...records("codex", file)]);
      } else if (tool === "agy") {
        const kidId = `kid${serial++}`;
        agyParents.push([kidId, parent]);
        file.path = join(home, `.gemini/antigravity-cli/brain/${kidId}/.system_generated/logs/transcript_full.jsonl`);
        write(file.path, records("agy", file));
      } else if (random() < 0.7) {
        file.path = join(home, ".claude/projects/-tmp-p", parent, "subagents", `agent-a${serial++}.jsonl`);
        write(file.path, records("claude", file).map((line) => line.replace(/^\{/, '{"isSidechain":true,')));
      } else {
        file.path = join(home, ".claude/projects/-tmp-p", parent, "tool-results", `r${serial++}.txt`);
        write(file.path, ["plain", plant(file, "projected"), "tail"]);
      }
      if (random() < 0.15) {
        chmodSync(file.path, 0); locked.push(file.path); file.unreadable = true;
        // A Codex child names its parent inside the file, so an unreadable one belongs to no Session.
        if (tool === "codex" && !orphan) { owner.threads.pop(); owners.push({ orphan: true, threads: [[file]] }); }
      }
    }
  }
  if (agyParents.length) {
    const dbPath = join(home, ".gemini/antigravity-cli/conversation_summaries.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, workspace_uris TEXT)");
    const insert = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)");
    for (const [kidId, parent] of agyParents) insert.run(kidId, parent, JSON.stringify(["file:///tmp/p"]));
    db.close();
  }
  return { home, owners };
}

/** The naive oracle: does the file's bytes contain the term, as written or JSON-escaped, ignoring case? */
function rawContains(file: GeneratedFile, term: string): boolean {
  if (file.unreadable) return true;
  const text = readFileSync(file.path, "utf8").toLowerCase();
  return [term, JSON.stringify(term).slice(1, -1)].some((form) => text.includes(form.toLowerCase()));
}

describe("find recall property", () => {
  test("attributes or counts every raw hit and returns exactly the Sessions whose readable events hold every term", async () => {
    for (let seed = Number(process.env.RECALL_FROM ?? 1); seed <= SEEDS; seed++) {
      const { home, owners } = generate(seed), catalog = new SessionCatalog({ home });
      const random = prng(seed * 7919);
      for (let round = 0; round < 6; round++) {
        const terms = TERMS.filter(() => random() < 0.3).slice(0, 3);
        if (!terms.length) terms.push(TERMS[round % TERMS.length]!);
        const { results, coverage } = await catalog.find({ terms }, 1000);
        const label = `seed ${seed} terms ${JSON.stringify(terms)}`;
        const touched = (file: GeneratedFile) => terms.some((term) => rawContains(file, term));
        const termsIn = (files: GeneratedFile[], placements: Placement[]) => new Set(terms.filter((term) =>
          files.some((file) => !file.unreadable && placements.some((placement) => file.placed.get(term)?.has(placement)))));
        const expected = { results: [] as string[], orphan_files: 0, injected_only_files: 0, partial_files: 0, unclassified_files: 0, unreadable_files: 0, candidate_files: 0 };
        for (const owner of owners) {
          if (!terms.every((term) => owner.threads.flat().some((file) => rawContains(file, term)))) continue;
          const read = owner.threads.map((files) => files.filter(touched)).filter((files) => files.length);
          const readable = read.filter((files) => !files.some((file) => file.unreadable));
          const seen = termsIn(readable.flat(), ["projected"]), any = termsIn(readable.flat(), ["projected", "injected"]);
          for (const files of read) {
            expected.candidate_files += files.length;
            if (!readable.includes(files)) expected.unreadable_files += files.length;
            else if (seen.size === terms.length) { if (owner.orphan) expected.orphan_files += files.length; }
            else if (any.size === terms.length) expected.injected_only_files += files.length;
            else if (termsIn(files, ["projected"]).size) expected.partial_files += files.length;
            else expected.unclassified_files += files.length;
          }
          if (seen.size === terms.length && !owner.orphan) expected.results.push(owner.id!);
        }
        expect({
          results: results.map(({ id }) => id).sort(),
          orphan_files: coverage.orphan_files,
          injected_only_files: coverage.injected_only_files,
          partial_files: coverage.partial_files,
          unclassified_files: coverage.unclassified_files,
          unreadable_files: coverage.unreadable_files,
          candidate_files: coverage.candidate_files,
        }, label).toEqual({ ...expected, results: expected.results.sort() });
        for (const result of results) {
          const owner = owners.find(({ id }) => id === result.id)!;
          expect(terms.every((term) => owner.threads.flat().some((file) => !file.unreadable && rawContains(file, term))), label).toBe(true);
        }
      }
      cleanup();
    }
  });
});
