import type { EventKind, MetaField, SearchHit, Session } from "./contracts.ts";

export type Term = { text: string; lower: string };
export type MatchEvent = { kind: EventKind; text: string; tool?: string; injected?: true };

const META_FIELDS: MetaField[] = ["name", "star_note", "first_msg", "id", "session_id", "source_path"];
const RANK: Record<SearchHit["kind"], number> = { meta: 0, user: 1, assistant: 2, thinking: 3, tool_call: 4, tool_output: 5 };

export function parseTerms(raw: string[]): Term[] {
  const seen = new Set<string>();
  return raw.map((text) => text.trim()).filter((text) => {
    const lower = text.toLowerCase();
    if (!text || seen.has(lower)) return false;
    seen.add(lower);
    return true;
  }).map((text) => ({ text, lower: text.toLowerCase() }));
}

/** The term as written and as it appears inside a JSON string; ripgrep cannot match a raw line break. */
export function rgPatterns(term: Term): string[] {
  return [...new Set([term.text, JSON.stringify(term.text).slice(1, -1)])].filter((pattern) => !/[\r\n]/.test(pattern));
}

/** Indexes of the terms the text contains. */
export function matchedTerms(text: string, terms: Term[]): number[] {
  const lower = text.toLowerCase();
  return terms.flatMap((term, index) => lower.includes(term.lower) ? [index] : []);
}

export function snippet(value: string, terms: Term[]): string {
  const text = value.replace(/\s+/g, " ").trim(), lower = text.toLowerCase();
  const term = terms.find((item) => lower.includes(item.lower));
  const index = term ? lower.indexOf(term.lower) : -1;
  if (index < 0) return text.length > 100 ? text.slice(0, 100) + "…" : text;
  const start = Math.max(0, index - 40), end = Math.min(text.length, index + term!.text.length + 60);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function metaHits(row: Session, terms: Term[]): { seen: Set<number>; hits: SearchHit[] } {
  const seen = new Set<number>(), hits: SearchHit[] = [];
  for (const field of META_FIELDS) {
    const value = row[field] ?? "", matched = matchedTerms(value, terms);
    if (!matched.length) continue;
    matched.forEach((index) => seen.add(index));
    hits.push({ kind: "meta", field, snippet: snippet(value, terms) });
  }
  return { seen, hits };
}

/** Keeps the best few hits: more terms first, then name/note/first message, user, assistant, thinking, tools, id/path fields; main thread before children. */
export class BestHits {
  private entries: { key: number[]; hit: SearchHit }[] = [];
  constructor(private size = 3) {}

  add(hit: SearchHit, termCount: number): void {
    const rank = hit.kind === "meta" ? ["name", "star_note", "first_msg"].includes(hit.field) ? 0 : 6 : RANK[hit.kind];
    const key = [-termCount, rank, hit.kind !== "meta" && hit.thread !== "main" ? 1 : 0, hit.kind === "meta" ? 0 : hit.ordinal];
    this.entries.push({ key, hit });
    this.entries.sort((left, right) => {
      const index = left.key.findIndex((value, position) => value !== right.key[position]);
      return index < 0 ? 0 : left.key[index]! - right.key[index]!;
    });
    this.entries.length = Math.min(this.entries.length, this.size);
  }

  get hits(): SearchHit[] { return this.entries.map(({ hit }) => hit); }
}

export type ThreadTally = { counts: Record<EventKind, number>; hits: number; seen: Set<number>; injected: Set<number> };

export function tally(events: MatchEvent[], terms: Term[], thread: string, best: BestHits): ThreadTally {
  const result: ThreadTally = { counts: { user: 0, assistant: 0, thinking: 0, tool_call: 0, tool_output: 0 }, hits: 0, seen: new Set(), injected: new Set() };
  events.forEach((event, ordinal) => {
    const matched = matchedTerms(event.text, terms);
    if (!matched.length) return;
    if (event.injected) { matched.forEach((index) => result.injected.add(index)); return; }
    matched.forEach((index) => result.seen.add(index));
    result.counts[event.kind]++;
    result.hits++;
    best.add({ kind: event.kind, thread, ordinal, ...(event.tool ? { tool: event.tool } : {}), snippet: snippet(event.text, terms) }, matched.length);
  });
  return result;
}

/** Merges `[hit - context, hit + context]` ranges inside `[0, last]`. */
export function mergeWindows(hits: number[], context: number, last: number): { from: number; to: number; hits: number[] }[] {
  const windows: { from: number; to: number; hits: number[] }[] = [];
  for (const hit of [...hits].sort((left, right) => left - right)) {
    const from = Math.max(0, hit - context), to = Math.min(last, hit + context), previous = windows.at(-1);
    if (previous && from <= previous.to + 1) { previous.to = Math.max(previous.to, to); previous.hits.push(hit); }
    else windows.push({ from, to, hits: [hit] });
  }
  return windows;
}

/** Cuts text to `chars` around the first term it contains, or from the start; `chars` 0 keeps it whole. */
export function clip(text: string, terms: Term[], chars: number): { text: string; length?: number } {
  if (!chars || text.length <= chars) return { text };
  const lower = text.toLowerCase(), term = terms.find((item) => lower.includes(item.lower));
  const center = term ? lower.indexOf(term.lower) + Math.floor(term.lower.length / 2) : 0;
  const start = Math.max(0, Math.min(text.length - chars, center - Math.floor(chars / 2))), end = start + chars;
  return { text: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, length: text.length };
}
