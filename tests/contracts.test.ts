import { describe, expect, test } from "bun:test";
import { parseDashboardSettings, isStatus, isTool, parseLineageRefresh, parseLineageView, parseSearchEnvelope, parseSessionsEnvelope, parseTranscriptView, STATUSES, TOOLS } from "../src/contracts.ts";

describe("shared contracts", () => {
  test("accept only supported tools and statuses", () => {
    expect(TOOLS).toEqual(["claude", "codex", "pi"]);
    expect(STATUSES).toEqual(["", "todo", "in progress", "review", "blocked", "done", "archived"]);
    expect(isTool("codex")).toBe(true);
    expect(isTool("other")).toBe(false);
    expect(isStatus("review")).toBe(true);
    expect(isStatus("waiting")).toBe(false);
  });

  test("reject malformed HTTP boundary values", () => {
    expect(() => parseSessionsEnvelope({ generatedAt: "now", home: "/home/me", sessions: [{}] })).toThrow("响应无效");
    expect(() => parseSessionsEnvelope({ generatedAt: "now", sessions: [] })).toThrow("响应无效");
    expect(() => parseTranscriptView({ messages: [{ role: "system", text: "hidden", timestamp: "" }] })).toThrow("响应无效");
    expect(() => parseSearchEnvelope({ total: 1, results: [{}] })).toThrow("响应无效");
    expect(() => parseLineageView({ sessions: [], edges: [{ upstream_id: "a" }] })).toThrow("响应无效");
    expect(() => parseLineageRefresh({ sessions: 1, edges: "one" })).toThrow("响应无效");
  });
});

describe("dashboard settings", () => {
  test.each(["", "2026-07-01", "2024-02-29", "0099-01-01"])("accepts saved calendar date %s", (date) => {
    expect(parseDashboardSettings({ claudeResumeCutoff: date, ignored: true })).toEqual({ claudeResumeCutoff: date });
  });
  test.each([null, { claudeResumeCutoff: null }, {}, { claudeResumeCutoff: 1 }, ...["2026-02-30", "2025-02-29", "2026-13-01", "2026-7-01", "2026-07-01T00:00:00Z"].map((date) => ({ claudeResumeCutoff: date }))])("rejects invalid settings %j", (value) => {
    expect(() => parseDashboardSettings(value)).toThrow();
  });
});
