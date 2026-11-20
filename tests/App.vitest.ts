import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../src/App.vue";
import { emptyCounts, type SessionView, type TranscriptView } from "../src/contracts.ts";

const makeRow = (index: number): SessionView => ({
  id: `session-${index}`,
  tool: index % 2 ? "claude" : "codex",
  source_path: `/home/fixture/sessions/session-${index}.jsonl`,
  cwd: index === 100 ? "/home/fixture/project" : index % 3 ? "/tmp/project" : "/tmp/other",
  name: `Session ${index}`,
  first_msg: `First ${index}`,
  mtime: Date.UTC(2026, 6, 1 + index) / 1000,
  birth: Date.UTC(2026, 5, 1 + index) / 1000,
  size_kb: index + 1,
  model: "fixture-model",
  starred: index === 42,
  star_note: index === 42 ? "priority" : "",
  archived: false,
  status: index === 42 ? "done" : "",
  resume_command: `resume ${index}`,
});

const searchMatch = { tier: 1, counts: emptyCounts(), threads: [], best: [] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: Array.from({ length: 101 }, (_, index) => makeRow(index)) });
    if (url.startsWith("/api/search")) return response({ total: 1, results: [{ ...makeRow(42), snippet: "deep transcript needle", match: searchMatch }], coverage: {} });
    if (url.startsWith("/api/session")) {
      const id = new URL(url, "http://local").searchParams.get("id")!;
      if (id === "missing") return response({ error: "missing" }, 404);
      const row = makeRow(Number(id.split("-")[1]));
      return response({ ...row, messages: [{ role: "user", text: "## Readable **fixture**\n\n- one\n- two\n\n<script>alert('xss')</script>\n\n[unsafe](javascript:alert(1))", timestamp: "" }] } satisfies TranscriptView);
    }
    if (url === "/rename" && JSON.parse(String(init?.body)).name === "Rejected") return response({ error: "no" }, 500);
    if (url === "/star" && JSON.parse(String(init?.body)).note === "Rejected note") return response({ error: "no" }, 500);
    return response({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("dashboard", () => {
  test("renders live sessions before archive rows arrive and refreshes only live sessions", async () => {
    const { resume_command: _, ...archived } = makeRow(2);
    const archive: SessionView = { ...archived, id: "archive:old", session_id: "old", source_kind: "archive", source_id: "cp", source_label: "Company", root_id: "claude", primary_action: { kind: "path", value: "/archive/old.jsonl" } };
    let finishArchive: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input), envelope = (sessions: SessionView[]) => response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions });
      if (url === "/api/sessions?scope=live") return envelope([makeRow(1), archive]);
      if (url === "/api/sessions?scope=archive") return new Promise<Response>((resolve) => { finishArchive = () => resolve(envelope([archive])); });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.findAll("tbody tr.row").map((row) => row.find(".name-text").text())).toEqual(["Session 1"]);
    finishArchive!(); await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(2);
    await wrapper.get("#reload").trigger("click"); await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(2);
    const calls = fetchMock.mock.calls.map(([input]) => String(input));
    expect([calls.filter((url) => url.endsWith("scope=live")).length, calls.filter((url) => url.endsWith("scope=archive")).length]).toEqual([2, 1]);
    wrapper.unmount();
  });

  test("loads all archive sources and copies correctly labeled actions without renaming archives", async () => {
    const live = makeRow(1);
    const pathRow: SessionView = { ...makeRow(2), id: "archive:path", session_id: live.id, tool: live.tool, source_kind: "archive", source_id: "cp", source_label: "Company", root_id: "claude", primary_action: { kind: "path", value: "/archive/session.jsonl" } };
    delete pathRow.resume_command;
    const forkRow: SessionView = { ...makeRow(3), id: "archive:fork", session_id: "pi-old", tool: "pi", source_kind: "archive", source_id: "review", source_label: "Review", root_id: "pi", primary_action: { kind: "fork", value: "cd /mapped && pi --fork /archive/pi.jsonl --session-dir /continuations" } };
    delete forkRow.resume_command;
    const sessions = [live, pathRow, forkRow];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions,
        diagnostics: [{ source_id: "offline", level: "error", message: "source unavailable" }] });
      if (url.startsWith("/api/session?")) {
        const id = new URL(url, "http://local").searchParams.get("id");
        return response({ ...sessions.find((row) => row.id === id), messages: [] });
      }
      if (url.startsWith("/api/search")) return response({ total: 3, results: sessions.map((row) => ({ ...row, snippet: "needle", match: searchMatch })), coverage: {} });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(3);
    expect(wrapper.get(".source-diagnostics").attributes("open")).toBeDefined();
    expect(wrapper.get(".source-diagnostics").text()).toContain("source unavailable");
    expect(wrapper.text()).toContain("同 ID 共 2 份");
    const rowNamed = (name: string) => wrapper.findAll("tbody tr.row").find((row) => row.find(".name-text").text() === name)!;
    expect(rowNamed("Session 2").get(".nm").attributes("aria-disabled")).toBe("true");
    await rowNamed("Session 2").get(".nm").trigger("click");
    expect(wrapper.find("input[aria-label='名称']").exists()).toBe(false);
    await rowNamed("Session 2").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(pathRow.primary_action!.value);
    expect(wrapper.get("#toast").text()).toBe("已复制归档路径");
    await wrapper.get("#searchModeDeep").trigger("click");
    await wrapper.get("#q").setValue("needle");
    await wrapper.get("#deepSearch").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(3);
    await wrapper.get("#reload").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(3);
    await rowNamed("Session 3").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(forkRow.primary_action!.value);
    expect(wrapper.get("#toast").text()).toBe("已复制新建分支命令");
    await rowNamed("Session 3").get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();
    expect(location.search).toContain("archive%3Afork");
    const copyButton = wrapper.findAll("button").find((button) => button.text() === "复制新建分支命令")!;
    await copyButton.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(forkRow.primary_action!.value);
    expect(fetchMock.mock.calls.every(([, init]) => init === undefined)).toBe(true);
    wrapper.unmount();
  });

  test("filters, sorts, and paginates the public list", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get(".tagline").text()).toBe("找到上下文，继续工作。");
    expect(wrapper.get(".meta").text()).toContain("101 个会话");
    expect(wrapper.get(".meta").text()).toMatch(/更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(wrapper.findAll("tbody tr")).toHaveLength(100);
    expect(wrapper.text()).toContain("第 1 / 2 页");
    expect(wrapper.findAll(".rs")).toHaveLength(6);
    expect(wrapper.findAll("thead th")).toHaveLength(7);
    expect(wrapper.findAll("tbody tr.row .opscell")).toHaveLength(100);
    expect(wrapper.find(".tool-pill").exists()).toBe(true);
    expect(wrapper.get("tbody .p").text()).toBe("~/project");

    await wrapper.findAll("button").find((button) => button.text() === "下一页")!.trigger("click");
    expect(wrapper.text()).toContain("第 2 / 2 页");
    const claude = wrapper.findAll(".tabs button").find((button) => button.text().startsWith("claude"))!;
    await claude.trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(50);
    expect(wrapper.text()).not.toContain("第 2 / 1 页");
    await wrapper.findAll(".tabs button").find((button) => button.text().startsWith("全部"))!.trigger("click");

    vi.useFakeTimers();
    const keyword = wrapper.get<HTMLInputElement>("#q");
    await keyword.setValue("Session 42");
    await vi.advanceTimersByTimeAsync(121);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    await keyword.setValue("SESSION-42");
    await vi.advanceTimersByTimeAsync(121);
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    await keyword.setValue("");
    await vi.advanceTimersByTimeAsync(121);
    await wrapper.get("#pathButton").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().includes("/tmp/other"))!.trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(34);
    await wrapper.get("#pathButton").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().includes("全部路径"))!.trigger("click");

    const advanced = wrapper.get("#filterToggle");
    expect(advanced.attributes("aria-expanded")).toBe("false");
    await advanced.trigger("click");
    expect(advanced.attributes("aria-expanded")).toBe("true");
    await wrapper.get("#statusFilter").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().startsWith("done"))!.trigger("click");
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    await wrapper.get("#statusFilter").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().startsWith("全部状态"))!.trigger("click");
    await wrapper.find("#advancedFilters input[type='number']").setValue("0.09");
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(9);
    await wrapper.find("#advancedFilters input[type='number']").setValue("");
    const dates = wrapper.findAll("#advancedFilters input[type='date']");
    await dates[0]!.setValue("2026-10-01");
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(9);
    await dates[0]!.setValue("");
    await dates[3]!.setValue("2026-06-10");
    await flushPromises();
    expect(wrapper.findAll("tbody tr")).toHaveLength(10);
    await dates[3]!.setValue("");

    const nameSort = wrapper.findAll("thead button").find((button) => button.text() === "会话")!;
    expect(nameSort).toBeUndefined();
    const nameHeader = wrapper.findAll("thead th").find((header) => header.text().startsWith("会话"))!;
    await nameHeader.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 99");
    await nameHeader.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 0");
    await wrapper.findAll(".tabs button").find((button) => button.text().startsWith("★ 标记"))!.trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    expect(wrapper.get("tbody .note-slot").text()).toBe("priority");
    wrapper.unmount();
  });

  test("runs deep search only on submit and renders its Transcript snippet", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get("#searchModeDeep").trigger("click");
    const keyword = wrapper.get<HTMLInputElement>("#q");
    await keyword.setValue("transcript needle");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/search"))).toBe(false);

    await keyword.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/search?q=transcript%20needle");
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(1);
    expect(wrapper.get("tbody .msg").text()).toBe("deep transcript needle");

    await wrapper.get("#searchModeNormal").trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(wrapper.get("tbody .empty").text()).toContain("没有匹配");
    wrapper.unmount();
  });

  test("ignores a stale deep-search response after the query changes", async () => {
    let finishSearch!: (value: Response) => void;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions"))
        return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: Array.from({ length: 101 }, (_, index) => makeRow(index)) });
      return new Promise<Response>((resolve) => { finishSearch = resolve; });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get("#searchModeDeep").trigger("click");
    const keyword = wrapper.get<HTMLInputElement>("#q");
    await keyword.setValue("old query");
    await keyword.trigger("keydown", { key: "Enter" });
    await keyword.setValue("new query");
    finishSearch(response({ total: 1, results: [{ ...makeRow(42), snippet: "old query" }] }));
    await flushPromises();
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(100);
    expect(wrapper.get<HTMLButtonElement>("#deepSearch").element.disabled).toBe(false);
    wrapper.unmount();
  });

  test("copies rows and preserves query-string detail history", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.find("tbody tr").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("resume 100");
    vi.useFakeTimers();
    const copyPath = wrapper.get("[aria-label='复制源文件路径']");
    await copyPath.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("/home/fixture/sessions/session-100.jsonl");
    expect(copyPath.classes()).toContain("copied");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copyPath.classes()).not.toContain("copied");
    await wrapper.get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();
    expect(location.search).toBe("?session=session-100");
    expect(wrapper.get("[aria-label='Transcript 详情']").text()).toContain("Readable fixture");
    expect(wrapper.get(".bubble .markdown h2").text()).toBe("Readable fixture");
    expect(wrapper.findAll(".bubble .markdown li")).toHaveLength(2);
    expect(wrapper.find(".bubble .markdown script").exists()).toBe(false);
    expect(wrapper.find(".bubble .markdown a").exists()).toBe(false);
    await wrapper.findAll("button").find((button) => button.text() === "复制恢复命令")!.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("resume 100");
    history.pushState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate"));
    await flushPromises();
    expect(wrapper.find("[aria-label='Session 列表']").exists()).toBe(true);
    wrapper.unmount();
  });

  test("keeps pinned rows first under any sort and pins through /star", async () => {
    const original = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/sessions")
      ? response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: Array.from({ length: 101 }, (_, index) => ({ ...makeRow(index), ...(index === 5 ? { pinned: true } : {}) })) })
      : original(input, init));
    const wrapper = mount(App);
    await flushPromises();
    const names = () => wrapper.findAll("tbody .name-text").map((name) => name.text());
    expect(names().slice(0, 2)).toEqual(["Session 5", "Session 100"]);
    expect(wrapper.get("tbody tr").classes()).toContain("pinned");
    await wrapper.findAll("th").find((th) => th.text().startsWith("会话"))!.trigger("click");
    expect(names()[0]).toBe("Session 5");

    await wrapper.findAll("th").find((th) => th.text().startsWith("更新"))!.trigger("click");
    await wrapper.findAll("tbody tr")[1]!.get("button[aria-label='置顶']").trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ body: expect.stringContaining('"pin":true') }));
    expect(names().slice(0, 3)).toEqual(["Session 100", "Session 5", "Session 99"]);
    expect(wrapper.findAll("tbody tr")[0]!.find("button[aria-label='取消置顶']").exists()).toBe(true);
    wrapper.unmount();
  });

  test("commits star, note, and archive only after success", async () => {
    const wrapper = mount(App);
    await flushPromises();
    const row = wrapper.get("tbody tr");
    const star = row.find("button[aria-label='标记重要']");
    await star.trigger("click"); await flushPromises();
    expect(star.text()).toBe("★");

    await row.get(".note-slot").trigger("click");
    const note = row.get<HTMLInputElement>("input[aria-label='备注']");
    await note.setValue("kept note"); await note.trigger("blur"); await flushPromises();
    expect(row.get(".note-slot").text()).toBe("kept note");
    await row.get(".note-slot").trigger("click");
    const rejectedNote = row.get<HTMLInputElement>("input[aria-label='备注']");
    await rejectedNote.setValue("Rejected note"); await rejectedNote.trigger("blur"); await flushPromises();
    expect(row.get(".note-slot").text()).toBe("kept note");

    await row.get(".nm").trigger("click");
    const name = row.get<HTMLInputElement>("input[aria-label='名称']");
    expect(name.element.value).toBe("Session 100");
    await name.setValue("Rejected"); await name.trigger("blur"); await flushPromises();
    expect(wrapper.get("[role='alert']").text()).toBe("改名失败");
    expect(row.get(".name-text").text()).toBe("Session 100");

    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ method: "POST" }));
    await row.get("[aria-label='归档']").trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ body: expect.stringContaining('"archive":true') }));
    await wrapper.findAll(".tabs button").find((button) => button.text().startsWith("归档"))!.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 100");
    wrapper.unmount();
  });

  test.each([
    { first_msg: "First pi message", label: "First pi message" },
    { first_msg: "", label: "session-1" },
  ])("previews unnamed pi Sessions in compact mode ($label)", async ({ first_msg, label }) => {
    localStorage.setItem("compact", "1");
    vi.useFakeTimers();
    const row: SessionView = { ...makeRow(1), tool: "pi", name: "", first_msg };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [row] });
      if (url.startsWith("/api/session?")) return response({ ...row, messages: [
        { role: "user", text: "Pi user message", timestamp: "" },
        { role: "assistant", text: "Pi assistant reply", timestamp: "" },
      ] } satisfies TranscriptView);
      return response({ sessions: [], edges: [] });
    });
    const wrapper = mount(App, { attachTo: document.body });
    try {
      await flushPromises();
      const name = wrapper.get(".name-text");
      expect(name.text()).toBe(label);
      await name.trigger("mouseenter");
      await vi.advanceTimersByTimeAsync(181); await flushPromises();
      expect(wrapper.get("#tip").text()).toContain("Pi user message");
      expect(wrapper.get("#tip").text()).toContain("Pi assistant reply");
      expect(wrapper.findAll("#tip .tipmsg")).toHaveLength(2);
    } finally {
      wrapper.unmount();
    }
  });

  test("restores preferences, keyboard shortcuts, and hover Transcript preview", async () => {
    localStorage.setItem("colw5", "not-json");
    localStorage.setItem("theme", "dark");
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.find("button[aria-label='切换到浅色主题']").trigger("click");
    expect(localStorage.getItem("theme")).toBe("light");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    expect(document.activeElement?.id).toBe("q");
    const keyword = wrapper.get<HTMLInputElement>("#q");
    await keyword.setValue("temporary"); keyword.element.focus();
    await keyword.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#q").element.value).toBe("");

    await wrapper.find(".line2.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("Readable fixture");
    expect(wrapper.get("#tip .markdown h2").text()).toBe("Readable fixture");

    expect(wrapper.findAll(".line2.msg").length).toBeGreaterThan(0);
    await wrapper.get("#density").trigger("click");
    expect(localStorage.getItem("compact")).toBe("1");
    expect(wrapper.findAll(".line2.msg")).toHaveLength(0);
    expect(wrapper.get("table").classes()).toContain("compact");
    // 首条消息藏起来后，Transcript 预览改从名称格进入
    await wrapper.get(".name-text").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("Readable fixture");
    await wrapper.get("#density").trigger("click");
    expect(localStorage.getItem("compact")).toBe("0");

    await wrapper.find(".rs").trigger("pointerdown", { clientX: 100 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 130 }));
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(JSON.parse(localStorage.getItem("colw7") || "[]")[0]).toBeGreaterThanOrEqual(36);
    const sortedBefore = wrapper.findAll("th.s-asc, th.s-desc").length;
    await wrapper.findAll("thead th")[3]!.trigger("click");
    expect(wrapper.findAll("th.s-asc, th.s-desc").length).toBe(sortedBefore);
    await vi.advanceTimersByTimeAsync(1);
    await wrapper.findAll("thead th")[3]!.trigger("click");
    expect(wrapper.findAll("th.s-asc, th.s-desc").length).toBe(1);
    wrapper.unmount();
  });

  test("coalesces repeated hover requests while Transcript detail is loading", async () => {
    vi.useFakeTimers();
    let finishDetail!: (value: Response) => void;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions"))
        return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [makeRow(1)] });
      return new Promise<Response>((resolve) => { finishDetail = resolve; });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const message = wrapper.get(".line2.msg");

    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    await message.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(101);
    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);

    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(1);
    finishDetail(response({ ...makeRow(1), messages: [] } satisfies TranscriptView));
    await flushPromises();
    wrapper.unmount();
  });

  test("keeps the current list visible while a refresh is pending", async () => {
    let finishRefresh!: (value: Response) => void;
    let sessionLoads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions") && sessionLoads++ === 0)
        return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [makeRow(1)] });
      if (url.startsWith("/api/sessions")) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    await wrapper.get("#reload").trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 1");
    expect(wrapper.get<HTMLButtonElement>("#reload").element.disabled).toBe(true);
    expect(wrapper.get("#reload").text()).toBe("刷新中…");

    finishRefresh(response({ generatedAt: new Date(1).toISOString(), home: "/home/fixture", sessions: [makeRow(2)] }));
    await flushPromises();
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 2");
    wrapper.unmount();
  });

  test("reloads a previously previewed live Transcript after refresh", async () => {
    vi.useFakeTimers();
    let detailLoads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions"))
        return response({ generatedAt: new Date().toISOString(), home: "/home/fixture", sessions: [makeRow(1)] });
      if (url.startsWith("/api/session"))
        return response({ ...makeRow(1), messages: [{ role: "user", text: ++detailLoads === 1 ? "before refresh" : "after refresh", timestamp: "" }] } satisfies TranscriptView);
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    await wrapper.get(".line2.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("before refresh");
    await wrapper.get("#reload").trigger("click");
    await flushPromises();
    await wrapper.get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();

    expect(wrapper.get("#detail").text()).toContain("after refresh");
    expect(detailLoads).toBe(2);
    wrapper.unmount();
  });

  test("does not load a Transcript when preview hover ends before the delay", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const message = wrapper.get(".line2.msg");

    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(100);
    await message.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(200);

    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(0);
    wrapper.unmount();
  });

  test("delays Transcript loading even while another preview is visible", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const messages = wrapper.findAll(".line2.msg");

    await messages[0]!.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(1);

    await messages[1]!.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(179);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(2);
    wrapper.unmount();
  });

  test("preserves Python search scope, custom menu keyboard behavior, and edit cancellation", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    const keyword = wrapper.get<HTMLInputElement>("#q");
    await keyword.setValue("fixture-model");
    await vi.advanceTimersByTimeAsync(121);
    expect(wrapper.get("tbody .empty").text()).toContain("没有匹配");
    await keyword.setValue("");
    await vi.advanceTimersByTimeAsync(121);

    await wrapper.get("#pathButton").trigger("click");
    expect(wrapper.get(".menu").attributes("role")).toBe("listbox");
    const selected = wrapper.get(".menu-option[aria-selected='true']");
    await selected.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement?.classList.contains("menu-option")).toBe(true);
    await wrapper.get(".menu").trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".menu").exists()).toBe(false);
    expect(document.activeElement?.id).toBe("pathButton");

    const row = wrapper.get("tbody tr.row");
    await row.get(".nm").trigger("click");
    const name = row.get<HTMLInputElement>("input[aria-label='名称']");
    await name.setValue("cancelled");
    await name.trigger("keydown", { key: "Escape" });
    expect(row.get(".name-text").text()).toBe("Session 100");

    const nameText = row.get(".name-text");
    Object.defineProperty(nameText.element, "scrollWidth", { configurable: true, value: 200 });
    Object.defineProperty(nameText.element, "clientWidth", { configurable: true, value: 50 });
    await nameText.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    expect(wrapper.get("#tip").text()).toBe("Session 100");
    wrapper.unmount();
  });

  test("shows recoverable errors for invalid list and failed detail responses", async () => {
    fetchMock.mockImplementationOnce(async () => response({ generatedAt: "now", home: "/home/fixture", sessions: [{}] }));
    const invalid = mount(App); await flushPromises();
    expect(invalid.get("[role='alert']").text()).toContain("响应无效");
    invalid.unmount();

    history.replaceState(null, "", "/?session=missing");
    const missing = mount(App); await flushPromises();
    expect(missing.get("[aria-label='Transcript 详情']").text()).toContain("加载失败");
    await missing.findAll("button").find((button) => button.text() === "返回")!.trigger("click");
    expect(location.pathname + location.search).toBe("/");
    missing.unmount();
  });
});
