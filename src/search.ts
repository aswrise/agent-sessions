import type { RawEvent } from "./catalog.ts";
import { emptyCounts, META_FIELDS, TIER1_META, type EventKind, type MatchSummary, type SearchHit, type Session } from "./contracts.ts";

export type Term = { text: string; lower: string };
type Ranked = { hit: SearchHit; terms: number };

/** A thread file's hits: counts by kind, which terms readable and injected events hold, and its best few hits. */
export type Tally = { counts: Record<EventKind, number>; hits: number; seen: Set<number>; injected: Set<number>; best: Ranked[] };
export type Verdict = "match" | "injected_only" | "partial" | "unclassified" | "unreadable";

const BEST = 3;
const KIND_RANK: Record<EventKind, number> = { user: 1, assistant: 2, thinking: 3, tool_call: 4, tool_output: 5 };

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

export function matchedTerms(text: string, terms: Term[]): number[] {
  const lower = text.toLowerCase();
  return terms.flatMap((term, index) => lower.includes(term.lower) ? [index] : []);
}

/**
 * Where to centre a clip: tool output echoes its command before the output itself,
 * so it centres on the last hit, which lies in the output whenever the output has one.
 */
function focus(text: string, terms: Term[], kind?: EventKind): { index: number; length: number } | undefined {
  const lower = text.toLowerCase();
  let best: { index: number; length: number } | undefined;
  for (const term of terms) {
    const index = kind === "tool_output" ? lower.lastIndexOf(term.lower) : lower.indexOf(term.lower);
    if (index >= 0 && (!best || (kind === "tool_output" ? index > best.index : index < best.index))) best = { index, length: term.lower.length };
  }
  return best;
}

function snippet(value: string, terms: Term[], kind?: EventKind): string {
  const text = value.replace(/\s+/g, " ").trim(), hit = focus(text, terms, kind);
  if (!hit) return text.length > 100 ? text.slice(0, 100) + "…" : text;
  const start = Math.max(0, hit.index - 40), end = Math.min(text.length, hit.index + hit.length + 60);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function metaHits(row: Session, terms: Term[]): { seen: Set<number>; best: Ranked[] } {
  const seen = new Set<number>(), best: Ranked[] = [];
  for (const field of META_FIELDS) {
    const value = row[field] ?? "", matched = matchedTerms(value, terms);
    if (!matched.length) continue;
    matched.forEach((index) => seen.add(index));
    best.push({ hit: { kind: "meta", field, snippet: snippet(value, terms) }, terms: matched.length });
  }
  return { seen, best };
}

/** More terms first, then name/note/first message, user, assistant, thinking, tools, id/path fields; main thread before children. */
function rankKey({ hit, terms }: Ranked): number[] {
  if (hit.kind === "meta") return [-terms, TIER1_META.includes(hit.field) ? 0 : 6, 0, 0];
  return [-terms, KIND_RANK[hit.kind], hit.thread === "main" ? 0 : 1, hit.ordinal];
}

function top(hits: Ranked[]): Ranked[] {
  const keyed = hits.map((ranked) => ({ ranked, key: rankKey(ranked) }));
  keyed.sort((left, right) => {
    const index = left.key.findIndex((value, position) => value !== right.key[position]);
    return index < 0 ? 0 : left.key[index]! - right.key[index]!;
  });
  return keyed.slice(0, BEST).map(({ ranked }) => ranked);
}

export function tally(events: RawEvent[], terms: Term[], thread: string): Tally {
  const result: Tally = { counts: { user: 0, assistant: 0, thinking: 0, tool_call: 0, tool_output: 0 }, hits: 0, seen: new Set(), injected: new Set(), best: [] };
  events.forEach((event, ordinal) => {
    const matched = matchedTerms(event.text, terms);
    if (!matched.length) return;
    if (event.injected) { matched.forEach((index) => result.injected.add(index)); return; }
    matched.forEach((index) => result.seen.add(index));
    result.counts[event.kind]++;
    result.hits++;
    result.best = top([...result.best, { hit: { kind: event.kind, thread, ordinal, ...(event.tool ? { tool: event.tool } : {}), snippet: snippet(event.text, terms, event.kind) }, terms: matched.length }]);
  });
  return result;
}

/**
 * Assigns each candidate file of one owner (a row or an orphan child) to its coverage bucket.
 * `files[i]` is that file's tally, or undefined when it could not be read.
 */
export function verdicts(termCount: number, metaSeen: Set<number>, files: (Tally | undefined)[]): Verdict[] {
  const seen = new Set(metaSeen), all = new Set(metaSeen);
  for (const file of files) for (const index of [...file?.seen ?? []]) { seen.add(index); all.add(index); }
  for (const file of files) for (const index of file?.injected ?? []) all.add(index);
  const outcome = seen.size === termCount ? "match" : all.size === termCount ? "injected_only" : undefined;
  return files.map((file) => !file ? "unreadable" : outcome ?? (file.seen.size ? "partial" : "unclassified"));
}

export function summarize(meta: ReturnType<typeof metaHits>, main: Tally | undefined, threads: { thread: string; label: string; tally: Tally }[]): MatchSummary {
  const counts = { ...emptyCounts(), ...main?.counts, meta: meta.best.length };
  const about = meta.best.some(({ hit }) => hit.kind === "meta" && TIER1_META.includes(hit.field));
  return {
    tier: about || counts.user ? 1 : counts.assistant ? 2 : 3,
    counts,
    threads: threads.filter(({ tally }) => tally.hits).map(({ thread, label, tally }) => ({ thread, label, hits: tally.hits })),
    best: top([...meta.best, ...main?.best ?? [], ...threads.flatMap(({ tally }) => tally.best)]).map(({ hit }) => hit),
  };
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

/** Cuts text to `chars` around its focus hit, or from the start; `chars` 0 keeps it whole. */
export function clip(text: string, terms: Term[], chars: number, kind?: EventKind): { text: string; length?: number } {
  if (!chars || text.length <= chars) return { text };
  const hit = focus(text, terms, kind), center = hit ? hit.index + Math.floor(hit.length / 2) : 0;
  const start = Math.max(0, Math.min(text.length - chars, center - Math.floor(chars / 2))), end = start + chars;
  return { text: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, length: text.length };
}
