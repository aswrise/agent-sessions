import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionCatalog } from "../src/catalog.ts";

const TERMS = ["zeta7", "quux9", "say\"hi", "c:\\tmp9", "召回词", "Kappa3"];
type Placement = "projected" | "injected" | "noise";
type Tool = "claude" | "codex" | "pi";
type GeneratedFile = { path: string; placed: Map<string, Set<Placement>> };
type GeneratedOwner = { id?: string; orphan: boolean; files: GeneratedFile[] };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

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
  for (let index = 0; index < 10; index++) {
    const tool = pick(["claude", "codex", "pi"] as const), id = `s${seed}x${serial++}`, owner: GeneratedOwner = { id, orphan: false, files: [] };
    const main: GeneratedFile = { path: "", placed: new Map() };
    owner.files.push(main);
    if (tool === "claude") {
      main.path = join(home, ".claude/projects/-tmp-p", `${id}.jsonl`);
      write(main.path, [JSON.stringify({ type: "system", sessionId: id, cwd: "/tmp/p" }), ...records("claude", main), padding]);
    } else if (tool === "codex") {
      main.path = join(home, ".codex/sessions/2026/07/14", `rollout-${id}.jsonl`);
      write(main.path, [JSON.stringify({ type: "session_meta", payload: { id, cwd: "/tmp/p" } }), ...records("codex", main), padding]);
    } else {
      main.path = join(home, ".pi/agent/sessions/-tmp-p", `${id}.jsonl`);
      write(main.path, [JSON.stringify({ type: "session", id, cwd: "/tmp/p" }), ...records("pi", main), padding]);
    }
    owners.push(owner);
    for (let child = 0; tool !== "pi" && child < Math.floor(random() * 3); child++) {
      const orphan = random() < 0.3, parent = orphan ? `gone${serial++}` : id, file: GeneratedFile = { path: "", placed: new Map() };
      const target = orphan ? { orphan: true, files: [file] } : owner;
      if (orphan) owners.push(target); else owner.files.push(file);
      if (tool === "codex") {
        file.path = join(home, ".codex/sessions/2026/07/14", `rollout-kid${serial++}.jsonl`);
        write(file.path, [JSON.stringify({ type: "session_meta", payload: { id: `kid${serial++}`, thread_source: "subagent", parent_thread_id: parent } }), ...records("codex", file)]);
      } else if (random() < 0.7) {
        file.path = join(home, ".claude/projects/-tmp-p", parent, "subagents", `agent-a${serial++}.jsonl`);
        write(file.path, records("claude", file).map((line) => line.replace(/^\{/, '{"isSidechain":true,')));
      } else {
        file.path = join(home, ".claude/projects/-tmp-p", parent, "tool-results", `r${serial++}.txt`);
        write(file.path, ["plain", plant(file, "projected"), "tail"]);
      }
    }
  }
  return { home, owners };
}

/** The naive oracle: does the file's bytes contain the term, as written or JSON-escaped, ignoring case? */
function rawContains(path: string, term: string): boolean {
  const text = readFileSync(path, "utf8").toLowerCase();
  return [term, JSON.stringify(term).slice(1, -1)].some((form) => text.includes(form.toLowerCase()));
}

describe("find recall property", () => {
  test("attributes or counts every raw hit and returns exactly the Sessions whose readable events hold every term", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { home, owners } = generate(seed), catalog = new SessionCatalog({ home });
      const random = prng(seed * 7919);
      for (let round = 0; round < 6; round++) {
        const terms = TERMS.filter(() => random() < 0.3).slice(0, 2);
        if (!terms.length) terms.push(TERMS[round % TERMS.length]!);
        const { results, coverage } = await catalog.find({ terms }, 1000);
        const has = (owner: GeneratedOwner, placements: Placement[]) => terms.every((term) =>
          owner.files.some((file) => placements.some((placement) => file.placed.get(term)?.has(placement))));
        const rawOwner = (owner: GeneratedOwner) => terms.every((term) => owner.files.some((file) => rawContains(file.path, term)));
        const candidates = (owner: GeneratedOwner) => owner.files.filter((file) => terms.some((term) => rawContains(file.path, term))).length;
        const label = `seed ${seed} terms ${JSON.stringify(terms)}`;

        const expected = owners.filter((owner) => !owner.orphan && has(owner, ["projected"])).map((owner) => owner.id).sort();
        expect(results.map(({ id }) => id).sort(), label).toEqual(expected as string[]);
        const failed = owners.filter((owner) => rawOwner(owner) && !has(owner, ["projected"]));
        expect({
          orphan_files: coverage.orphan_files,
          injected_only_files: coverage.injected_only_files,
          unclassified_files: coverage.unclassified_files,
        }, label).toEqual({
          orphan_files: owners.filter((owner) => owner.orphan && has(owner, ["projected"])).length,
          injected_only_files: failed.filter((owner) => has(owner, ["projected", "injected"])).reduce((sum, owner) => sum + candidates(owner), 0),
          unclassified_files: failed.filter((owner) => !has(owner, ["projected", "injected"])).reduce((sum, owner) => sum + candidates(owner), 0),
        });
        const attributed = owners.filter((owner) => results.some(({ id }) => id === owner.id)).reduce((sum, owner) => sum + candidates(owner), 0);
        expect(coverage.candidate_files, label).toBe(attributed + coverage.orphan_files + coverage.injected_only_files + coverage.unclassified_files);
        for (const owner of owners) for (const file of owner.files) if (terms.every((term) => rawContains(file.path, term)))
          expect(results.some(({ id }) => id === owner.id) || failed.includes(owner) || owner.orphan, label).toBe(true);
        for (const result of results)
          expect(rawOwner(owners.find((owner) => owner.id === result.id)!), label).toBe(true);
      }
    }
  });
});
