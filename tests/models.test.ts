import { expect, test } from "bun:test";
import { compareModels, shortModel } from "../src/models.ts";

function order(values: string[]): string[] {
  return [...values].sort(compareModels).map(shortModel);
}

test("orders newer and stronger models first, with unknown models last", () => {
  expect(order([
    "claude-opus-4-6", "claude-fable-5", "", "claude-opus-4-7", "claude-opus-4-8",
    "claude-sonnet-4-6", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001",
  ])).toEqual([
    "fable-5-1", "fable-5", "opus-5", "sonnet-5", "opus-4-8",
    "opus-4-7", "opus-4-6", "sonnet-4-6", "haiku-4-5-20251001", "无模型",
  ]);

  expect(order(["gpt-5.5", "gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5", "gpt-5.6-terra", "gpt-5.4"]))
    .toEqual(["6-astra", "5.6-sol", "5.6-terra", "5.6-luna", "5.5", "5.4", "5"]);

  expect(order(["codex-auto-review", "gpt-5.3-codex", "", "deepseek/deepseek-v4-flash", "openai-codex/gpt-5.5"]))
    .toEqual(["5.5", "5.3-codex", "codex-auto-review", "deepseek-v4-flash", "无模型"]);
});
