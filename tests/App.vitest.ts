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
let savedSettings = { claudeResumeCutoff: "" };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  savedSettings = { claudeResumeCutoff: "" };
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings") {
      if (init?.method === "POST") savedSettings = JSON.parse(String(init.body));
      return response(savedSettings);
    }
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
  vi.stubGlobal("confirm", vi.fn(() => true));
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
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
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
      await vi.advanceTimersByTimeAsync(501); await flushPromises();
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
    await vi.advanceTimersByTimeAsync(501); await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("Readable fixture");
    expect(wrapper.get("#tip .markdown h2").text()).toBe("Readable fixture");

    expect(wrapper.findAll(".line2.msg").length).toBeGreaterThan(0);
    await wrapper.get("#density").trigger("click");
    expect(localStorage.getItem("compact")).toBe("1");
    expect(wrapper.findAll(".line2.msg")).toHaveLength(0);
    expect(wrapper.get("table").classes()).toContain("compact");
    // 首条消息藏起来后，Transcript 预览改从名称格进入
    await wrapper.get(".name-text").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(501); await flushPromises();
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

  test.each([false, true])("unnamed pi Sessions keep a visible preview and rename target (compact=%s)", async (compact) => {
    if (compact) localStorage.setItem("compact", "1");
    const session: SessionView = { ...makeRow(2), tool: "pi", name: "" };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return response(savedSettings);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [session] });
      if (url.startsWith("/api/session?")) return response({ ...session, messages: [{ role: "user", text: "Pi preview text", timestamp: "" }] });
      if (url === "/api/lineages") return response({ sessions: [], edges: [] });
      return response({ ok: true });
    });
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const target = wrapper.get(".name-text");
    expect(target.text()).toBe(compact ? session.first_msg : "未命名会话");
    await target.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(501); await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("Pi preview text");
    await target.trigger("click"); await flushPromises();
    const input = wrapper.get<HTMLInputElement>("input[aria-label='名称']");
    expect(input.element.value).toBe("");
    await input.setValue("Pi renamed");
    await input.trigger("keydown", { key: "Enter" }); await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/rename", expect.objectContaining({ body: JSON.stringify({ id: session.id, name: "Pi renamed" }) }));
    expect(wrapper.get(".name-text").text()).toBe("Pi renamed");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
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
    await vi.advanceTimersByTimeAsync(501);
    await message.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(151);
    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(501);

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
    await vi.advanceTimersByTimeAsync(501);
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
    await vi.advanceTimersByTimeAsync(350);
    await message.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(300);

    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(0);
    expect(wrapper.find("#tip").exists()).toBe(false);
    wrapper.unmount();
  });

  test("delays Transcript loading even while another preview is visible", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const messages = wrapper.findAll(".line2.msg");

    await messages[0]!.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(501);
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(1);
    expect(wrapper.find("#tip").exists()).toBe(true);

    await messages[1]!.trigger("mouseenter");
    expect(wrapper.find("#tip").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/session?id=")).length).toBe(2);
    wrapper.unmount();
  });

  test("dismisses and suppresses hover previews when starting to rename, and supports agy tab and rename toast", async () => {
    vi.useFakeTimers();
    const agyRow: SessionView = { ...makeRow(1), id: "agy-1", tool: "agy", model: "gemini-4-neon-high" };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [agyRow] });
      if (url.startsWith("/api/session?")) return response({ ...agyRow, messages: [{ role: "user", text: "hi", timestamp: "" }] });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.findAll(".tabs button").some((button) => button.text().startsWith("agy"))).toBe(true);
    expect(wrapper.get(".tool-pill.agy").text()).toBe("agy");

    const row = wrapper.get("tbody tr.row");
    await row.get(".line2.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(501);
    await flushPromises();
    expect(wrapper.find("#tip").exists()).toBe(true);

    await row.get(".nm").trigger("mousedown");
    expect(wrapper.find("#tip").exists()).toBe(false);
    await row.get(".nm").trigger("click");
    await row.get(".line2.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(600);
    expect(wrapper.find("#tip").exists()).toBe(false);

    const input = row.get<HTMLInputElement>("input[aria-label='名称']");
    await input.setValue("Renamed Agy");
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(wrapper.get("#toast").text()).toBe("已同步 agy Session 名称");
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
    await vi.advanceTimersByTimeAsync(501);
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

  test("opens file:// local document links in the preview dialog without auto-linking bare filenames", async () => {
    const row = { ...makeRow(1), id: "agy-doc", tool: "agy" as const };
    const docHref = "file:///Users/fixture/%E8%AF%A6%E7%BB%86%E8%A7%A3%E8%AF%BB%E8%AE%BF%E8%B0%88%E6%BC%94%E8%AE%B2.md#L10-L20";
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [row] });
      if (url.startsWith("/api/session?")) {
        return response({
          ...row,
          messages: [{ role: "assistant", text: "读完 [详细解读访谈演讲.md](file:///Users/fixture/详细解读访谈演讲.md#L10-L20) 和 详细解读访谈演讲.md", timestamp: "" }],
        } satisfies TranscriptView);
      }
      if (url.startsWith("/api/file-preview?")) {
        return response({ path: "/Users/fixture/详细解读访谈演讲.md", extension: ".md", content: "# 访谈正文\n\n预览成功" });
      }
      return response({ ok: true });
    });

    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();

    const links = wrapper.findAll(".bubble .markdown a");
    expect(links).toHaveLength(1);
    expect(links[0]!.attributes("href")).toBe(docHref);

    await links[0]!.trigger("click", { button: 0 });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(`/api/file-preview?${new URLSearchParams({ id: "agy-doc", href: docHref })}`);
    expect(wrapper.get(".file-preview").text()).toContain("访谈正文");
    wrapper.unmount();
  });
});

describe("Claude resume service settings", () => {
  const cutoff = new Date(2026, 6, 1).getTime() / 1000;
  const oldClaude = { ...makeRow(1), birth: cutoff - 1, mtime: cutoff + 86400 };

  function serve(rows: SessionView[]): void {
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: rows });
      if (url.startsWith("/api/session?")) {
        const id = new URL(url, "http://local").searchParams.get("id");
        return response({ ...rows.find((row) => row.id === id)!, messages: [] });
      }
      return fallback(input, init);
    });
  }

  test("starts collapsed and preserves the cutoff and draft across toggles without requests", async () => {
    serve([oldClaude]);
    savedSettings.claudeResumeCutoff = "2026-07-01";
    let wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    expect(wrapper.get("#resumeSettingsToggle").attributes("aria-expanded")).toBe("false");
    expect(wrapper.get("#resumeSettingsToggle").attributes("aria-controls")).toBe("resumeSettings");
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(false);
    expect(wrapper.get("tbody tr.row").text()).toContain("恢复已禁用");
    const calls = fetchMock.mock.calls.length;
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(true);
    await wrapper.get("#claudeResumeCutoff").setValue("2026-08-01");
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(false);
    expect(wrapper.get("[role='status']").isVisible()).toBe(true);
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-08-01");
    expect(savedSettings.claudeResumeCutoff).toBe("2026-07-01");
    expect(fetchMock.mock.calls).toHaveLength(calls);
    expect(window.confirm).not.toHaveBeenCalled();
    wrapper.unmount();
    wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(false);
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    expect(wrapper.get("tbody tr.row").text()).toContain("恢复已禁用");
    wrapper.unmount();
  });

  test("confirms the exact date and posts the confirmed value", async () => {
    const wrapper = mount(App); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith("确认将 Claude 恢复起始日期保存为 2026-07-01？该日期之前的 Claude 会话将禁止复制恢复命令，当天允许。所有浏览器共享此设置。");
    const posts = fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings" && init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ claudeResumeCutoff: "2026-07-01" });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wrapper.get("#clearResumeSettings").trigger("click"); await flushPromises();
    expect(savedSettings.claudeResumeCutoff).toBe("2026-07-01");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    expect(wrapper.text()).toContain("恢复日期已保存");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings" && init?.method === "POST")).toHaveLength(1);
    wrapper.unmount();
  });

  test.each(["save", "clear"])("cancelled %s preserves the saved cutoff and a distinct draft without POST", async (action) => {
    savedSettings.claudeResumeCutoff = "2026-07-01";
    const wrapper = mount(App); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-08-01");
    vi.mocked(window.confirm).mockReturnValue(false);
    const calls = fetchMock.mock.calls.length;
    await wrapper.get(action === "save" ? "#saveResumeSettings" : "#clearResumeSettings").trigger("click"); await flushPromises();
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls).toHaveLength(calls);
    expect(savedSettings.claudeResumeCutoff).toBe("2026-07-01");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-08-01");
    expect(wrapper.text()).toContain("恢复日期未保存");
    wrapper.unmount();
  });

  test.each(["clear", "empty save"])("confirmed %s warns about older sessions and posts an empty cutoff", async (action) => {
    savedSettings.claudeResumeCutoff = "2026-07-01";
    const wrapper = mount(App); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    if (action === "empty save") await wrapper.get("#claudeResumeCutoff").setValue("");
    await wrapper.get(action === "clear" ? "#clearResumeSettings" : "#saveResumeSettings").trigger("click"); await flushPromises();
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith("确认清空 Claude 恢复起始日期？这将关闭日期限制，较早的 Claude 会话也可复制恢复命令。所有浏览器共享此设置。");
    const posts = fetchMock.mock.calls.filter(([url, init]) => url === "/api/settings" && init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ claudeResumeCutoff: "" });
    expect(savedSettings.claudeResumeCutoff).toBe("");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("");
    wrapper.unmount();
  });

  test("blocks old Claude row click, row Enter, and detail copy before any clipboard write", async () => {
    serve([oldClaude]);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    await wrapper.get("#saveResumeSettings").trigger("click");
    await flushPromises();
    const row = wrapper.get("tbody tr.row");
    expect(row.text()).toContain("恢复已禁用");
    await row.trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(wrapper.get("#toast").text()).toContain("早于恢复起始日期");
    await row.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await row.get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();
    const resume = wrapper.findAll("#detail button").find((button) => button.text() === "复制恢复命令")!;
    expect((resume.element as HTMLButtonElement).disabled).toBe(true);
    await resume.trigger("click");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    (resume.element as HTMLButtonElement).disabled = false;
    await resume.trigger("click");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    const path = wrapper.findAll("#detail button").find((button) => button.text() === "复制源文件路径")!;
    await path.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(oldClaude.source_path);
    wrapper.unmount();
  });

  test.each([true, false])("row path Enter cannot copy a resume command, with cutoff %s", async (enabled) => {
    serve([oldClaude]);
    if (enabled) savedSettings.claudeResumeCutoff = "2026-07-01";
    const wrapper = mount(App);
    await flushPromises();
    const path = wrapper.get("tbody [aria-label='复制源文件路径']");
    await path.trigger("keydown", { key: "Enter" });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await path.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(oldClaude.source_path);
    expect(wrapper.find("#toast").exists()).toBe(false);
    wrapper.unmount();
  });

  test("allows local midnight, newer Claude, and old Codex and pi while checking birth rather than mtime", async () => {
    const rows: SessionView[] = [
      oldClaude,
      { ...makeRow(3), birth: cutoff, mtime: cutoff + 3 },
      { ...makeRow(5), birth: cutoff + 86400, mtime: cutoff + 5 },
      { ...makeRow(2), birth: cutoff - 86400, mtime: cutoff + 2 },
      { ...makeRow(4), tool: "pi", birth: cutoff - 86400, mtime: cutoff + 4 },
    ];
    serve(rows);
    savedSettings.claudeResumeCutoff = "2026-07-01";
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.findAll(".resume-blocked")).toHaveLength(1);
    for (const row of wrapper.findAll("tbody tr.row")) {
      const name = row.get(".name-text").text();
      const session = rows.find((item) => item.name === name)!;
      vi.mocked(navigator.clipboard.writeText).mockClear();
      await row.trigger("click");
      await flushPromises();
      if (session.id === oldClaude.id) expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      else expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(session.resume_command);
    }
    wrapper.unmount();
  });

  test("persists and reloads the setting, keeps it when filters clear, and removes it when cleared", async () => {
    serve([oldClaude]);
    let wrapper = mount(App);
    await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    await wrapper.get("#saveResumeSettings").trigger("click");
    await flushPromises();
    expect(savedSettings.claudeResumeCutoff).toBe("2026-07-01");
    expect(localStorage.getItem("claudeResumeCutoff")).toBeNull();
    expect(wrapper.find(".filter-count").exists()).toBe(false);
    wrapper.unmount();
    localStorage.clear();
    wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    await wrapper.get("#filterToggle").trigger("click");
    await wrapper.get("[aria-label='创建起始']").setValue("2026-06-01");
    await wrapper.findAll("button").find((button) => button.text() === "清除筛选")!.trigger("click");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    expect(savedSettings.claudeResumeCutoff).toBe("2026-07-01");
    await wrapper.get("tbody tr.row").trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "清空恢复日期")!.trigger("click");
    await flushPromises();
    expect(savedSettings.claudeResumeCutoff).toBe("");
    await wrapper.get("tbody tr.row").trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(oldClaude.resume_command);
    wrapper.unmount();
    localStorage.clear();
    wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("");
    wrapper.unmount();
  });

  test.each(["2026-07-01", "2026-02-30"])("ignores legacy browser date %s", async (value) => {
    serve([oldClaude]);
    localStorage.setItem("claudeResumeCutoff", value);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("");
    await wrapper.get("tbody tr.row").trigger("click");
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(oldClaude.resume_command);
    wrapper.unmount();
  });

  test("saves leap day only after an explicit save", async () => {
    serve([oldClaude]);
    const wrapper = mount(App); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2024-02-29");
    expect(savedSettings.claudeResumeCutoff).toBe("");
    await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    expect(savedSettings.claudeResumeCutoff).toBe("2024-02-29");
    expect(wrapper.text()).toContain("恢复日期已保存");
    wrapper.unmount();
  });
  test.each(["delayed", "failed", "invalid"])("blocks Claude with %s settings while paths and other tools work", async (state) => {
    serve([oldClaude, makeRow(2), { ...makeRow(4), tool: "pi" }]);
    localStorage.setItem("claudeResumeCutoff", "2020-01-01");
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings"
      ? state === "delayed" ? new Promise<Response>((done) => { resolve = done; }) : Promise.resolve(response(state === "failed" ? {} : { claudeResumeCutoff: "2026-02-30" }, state === "failed" ? 500 : 200))
      : fallback(input, init));
    const wrapper = mount(App); await flushPromises();
    const row = wrapper.findAll("tbody tr.row").find((item) => item.text().includes(oldClaude.name))!;
    await row.trigger("click"); await row.trigger("keydown", { key: "Enter" });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await row.get("[aria-label='复制源文件路径']").trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(oldClaude.source_path);
    for (const item of wrapper.findAll("tbody tr.row").filter((item) => !item.text().includes(oldClaude.name))) await item.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(makeRow(2).resume_command);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(makeRow(4).resume_command);
    if (state !== "delayed") expect(wrapper.get("#resumeSettingsError").text()).toMatch(/失败|日期/);
    if (state === "delayed") { resolve(response({ claudeResumeCutoff: "2026-07-01" })); await flushPromises(); }
    expect(localStorage.getItem("claudeResumeCutoff")).toBe("2020-01-01");
    wrapper.unmount();
  });

  test("retains unsaved draft through focus, pending save and save failure, then acknowledges retry", async () => {
    serve([oldClaude]);
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    window.dispatchEvent(new Event("focus")); await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    await wrapper.get("tbody tr.row").trigger("click");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings" && init?.method === "POST"
      ? new Promise<Response>((done) => { resolve = done; }) : fallback(input, init));
    await wrapper.get("#saveResumeSettings").trigger("click");
    const calls = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    expect(fetchMock.mock.calls.length).toBe(calls);
    await wrapper.get("tbody tr.row").trigger("click");
    expect(wrapper.text()).not.toContain("恢复日期已保存");
    expect(wrapper.get("#chrome [role='status']").text()).toBe("保存中…");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    resolve(response({}, 500)); await flushPromises();
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(false);
    expect(wrapper.get("#resumeSettingsError").isVisible()).toBe(true);
    expect(wrapper.findAll("button").find((button) => button.text() === "重试加载恢复设置")!.isVisible()).toBe(true);
    expect(wrapper.get("#resumeSettingsError").text()).toContain("保存失败");
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    expect(savedSettings.claudeResumeCutoff).toBe("");
    await wrapper.get("tbody tr.row").trigger("click");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    fetchMock.mockImplementation(fallback);
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    const retryCalls = fetchMock.mock.calls.length;
    await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    expect(fetchMock.mock.calls).toHaveLength(retryCalls);
    expect(wrapper.get("#resumeSettingsError").text()).toContain("保存失败");
    await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    expect(window.confirm).toHaveBeenCalledTimes(3);
    expect(wrapper.text()).toContain("恢复日期已保存");
    expect(wrapper.find("#resumeSettingsError").exists()).toBe(false);
    wrapper.unmount();
  });

  test.each(["row click", "row Enter", "detail"])("%s keeps confirmed hints and labels stable during a fresh read", async (entry) => {
    const allowed = { ...makeRow(3), birth: cutoff };
    serve([oldClaude, allowed]);
    savedSettings.claudeResumeCutoff = "2026-07-01";
    const wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    const row = wrapper.findAll("tbody tr.row").find((item) => item.text().includes(allowed.name))!;
    if (entry === "detail") {
      await row.get("[aria-label='打开详情页']").trigger("click"); await flushPromises();
    }
    const action = entry === "detail"
      ? wrapper.findAll("#detail button").find((button) => button.text() === "复制恢复命令")!
      : row;
    const bars = wrapper.findAll("#chrome .bar2").filter((bar) => bar.isVisible()).length;
    const reason = entry === "detail" ? "" : wrapper.get("tbody .resume-blocked").attributes("title");
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings"
      ? new Promise<Response>((done) => { resolve = done; }) : fallback(input, init));
    const calls = fetchMock.mock.calls.filter(([url]) => url === "/api/settings").length;
    await action.trigger(entry === "row Enter" ? "keydown" : "click", { key: "Enter" });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(wrapper.findAll("#chrome .bar2").filter((bar) => bar.isVisible())).toHaveLength(bars);
    expect(wrapper.find("[role='status']").exists()).toBe(false);
    if (entry === "detail") {
      expect(action.text()).toBe("复制恢复命令");
      expect((action.element as HTMLButtonElement).disabled).toBe(true);
      expect(wrapper.find("#detail .resume-blocked").exists()).toBe(false);
      (action.element as HTMLButtonElement).disabled = false;
    } else {
      expect(row.find(".resume-blocked").exists()).toBe(false);
      expect(wrapper.get("tbody .resume-blocked").attributes("title")).toBe(reason);
    }
    await action.trigger("click");
    if (entry !== "detail") await action.trigger("keydown", { key: "Enter" });
    expect(wrapper.get("#toast").text()).toContain("尚未确认");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/settings")).toHaveLength(calls + 1);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    resolve(response(savedSettings)); await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(allowed.resume_command);
    expect(wrapper.findAll("#chrome .bar2").filter((bar) => bar.isVisible())).toHaveLength(bars);
    if (entry === "detail") {
      expect(action.text()).toBe("复制恢复命令");
      expect((action.element as HTMLButtonElement).disabled).toBe(false);
      expect(wrapper.find("#detail .resume-blocked").exists()).toBe(false);
    }
    wrapper.unmount();
  });

  test.each(["saved", "dirty"])("keeps the %s status during a background settings read", async (state) => {
    const wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    if (state === "saved") {
      await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    }
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    const status = wrapper.get("#chrome [role='status']").text();
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings"
      ? new Promise<Response>((done) => { resolve = done; }) : fallback(input, init));
    window.dispatchEvent(new Event("focus")); await flushPromises();
    expect(wrapper.get("#chrome [role='status']").text()).toBe(status);
    resolve(response(savedSettings)); await flushPromises();
    expect(wrapper.get("#chrome [role='status']").text()).toBe(status);
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    wrapper.unmount();
  });

  test.each(["failed", "invalid"])("a %s fresh read keeps the hidden-panel error and retry visible without copying", async (state) => {
    serve([oldClaude]);
    const wrapper = mount(App, { attachTo: document.body }); await flushPromises();
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings"
      ? Promise.resolve(response(state === "failed" ? {} : { claudeResumeCutoff: "2026-02-30" }, state === "failed" ? 500 : 200))
      : fallback(input, init));
    await wrapper.get("tbody tr.row").trigger("click"); await flushPromises();
    expect(wrapper.get("#resumeSettings").isVisible()).toBe(false);
    expect(wrapper.get("#resumeSettingsError").isVisible()).toBe(true);
    const retry = wrapper.findAll("button").find((button) => button.text() === "重试加载恢复设置")!;
    expect(retry.isVisible()).toBe(true);
    await wrapper.get("tbody tr.row").trigger("keydown", { key: "Enter" }); await flushPromises();
    expect(wrapper.get("#resumeSettingsError").isVisible()).toBe(true);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    fetchMock.mockImplementation(fallback);
    await retry.trigger("click"); await flushPromises();
    expect(wrapper.find("#resumeSettingsError").exists()).toBe(false);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  test("copy-time read observes another client and clipboard failures stay visible", async () => {
    serve([oldClaude]);
    const wrapper = mount(App); await flushPromises();
    savedSettings.claudeResumeCutoff = "2026-07-01";
    await wrapper.get("tbody tr.row").trigger("click"); await flushPromises();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("permission"));
    await wrapper.get("[aria-label='复制源文件路径']").trigger("click"); await flushPromises();
    expect(wrapper.findAll("[role='alert']").some((item) => item.text().includes("剪贴板"))).toBe(true);
    wrapper.unmount();
  });

  test("discards an older GET response after an accepted save", async () => {
    serve([oldClaude]);
    const fallback = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const wrapper = mount(App); await flushPromises();
    await wrapper.get("#resumeSettingsToggle").trigger("click");
    await wrapper.get("#claudeResumeCutoff").setValue("2026-07-01");
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => String(input) === "/api/settings" && init?.method !== "POST"
      ? new Promise<Response>((done) => { resolve = done; }) : fallback(input, init));
    window.dispatchEvent(new Event("focus")); await flushPromises();
    (wrapper.get("#saveResumeSettings").element as HTMLButtonElement).disabled = false;
    await wrapper.get("#saveResumeSettings").trigger("click"); await flushPromises();
    resolve(response({ claudeResumeCutoff: "" })); await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#claudeResumeCutoff").element.value).toBe("2026-07-01");
    expect(wrapper.text()).toContain("恢复日期已保存");
    wrapper.unmount();
  });

});
