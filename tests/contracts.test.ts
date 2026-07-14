import { describe, expect, test } from "bun:test";
import { isStatus, isTool, STATUSES, TOOLS } from "../src/contracts.ts";

describe("shared contracts", () => {
  test("accept only supported tools and statuses", () => {
    expect(TOOLS).toEqual(["claude", "codex", "pi"]);
    expect(STATUSES).toEqual(["", "todo", "in progress", "review", "blocked", "done", "archived"]);
    expect(isTool("codex")).toBe(true);
    expect(isTool("other")).toBe(false);
    expect(isStatus("review")).toBe(true);
    expect(isStatus("waiting")).toBe(false);
  });
});
