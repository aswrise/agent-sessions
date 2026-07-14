import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../src/App.vue";
import type { SessionView, TranscriptView } from "../src/contracts.ts";

const makeRow = (index: number): SessionView => ({
  id: `session-${index}`,
  tool: index % 2 ? "claude" : "codex",
  cwd: index % 3 ? "/tmp/project" : "/tmp/other",
  name: `Session ${index}`,
  first_msg: `First ${index}`,
  mtime: 1000 + index,
  birth: 500 + index,
  size_kb: 2,
  model: "fixture-model",
  starred: false,
  star_note: "",
  archived: false,
  status: "",
  resume_command: `resume ${index}`,
});

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), sessions: Array.from({ length: 101 }, (_, index) => makeRow(index)) });
    if (url.startsWith("/api/session")) {
      const id = new URL(url, "http://local").searchParams.get("id")!;
      const row = makeRow(Number(id.split("-")[1]));
      return response({ ...row, messages: [{ role: "user", text: "Readable fixture", timestamp: "" }] } satisfies TranscriptView);
    }
    if (url === "/rename" && JSON.parse(String(init?.body)).name === "Rejected") return response({ error: "no" }, 500);
    return response({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("dashboard", () => {
  test("filters, paginates, copies rows, and navigates detail with History API", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(100);
    expect(wrapper.text()).toContain("第 1 / 2 页");

    await wrapper.find("tbody tr").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("resume 100");
    const detailButton = wrapper.findAll("button").find((button) => button.text() === "查看")!;
    await detailButton.trigger("click"); await flushPromises();
    expect(location.search).toBe("?session=session-100");
    expect(wrapper.get("[aria-label='Transcript 详情']").text()).toContain("Readable fixture");
    await wrapper.findAll("button").find((button) => button.text() === "返回")!.trigger("click");
    expect(location.pathname + location.search).toBe("/");

    const claude = wrapper.findAll("nav button").find((button) => button.text() === "Claude")!;
    await claude.trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(50);
    const advanced = wrapper.find("[aria-controls='advanced']");
    expect(advanced.attributes("aria-expanded")).toBe("false");
    await advanced.trigger("click");
    expect(advanced.attributes("aria-expanded")).toBe("true");
    wrapper.unmount();
  });

  test("commits successful mutations and restores an edit after an error", async () => {
    const wrapper = mount(App);
    await flushPromises();
    const row = wrapper.get("tbody tr");
    const star = row.find("button[aria-label='标记重要']");
    await star.trigger("click"); await flushPromises();
    expect(star.text()).toBe("★");

    const name = row.get<HTMLInputElement>("input[aria-label='名称']");
    expect(name.element.value).toBe("Session 100");
    await name.setValue("Rejected"); await flushPromises();
    expect(wrapper.get("[role='alert']").text()).toBe("保存失败");
    expect(name.element.value).toBe("Session 100");

    const status = row.get("select[aria-label='状态']");
    await status.setValue("done"); await flushPromises();
    expect((status.element as HTMLSelectElement).value).toBe("done");
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ method: "POST" }));
    wrapper.unmount();
  });
});
