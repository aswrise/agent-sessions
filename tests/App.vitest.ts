import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../src/App.vue";
import type { SessionView, TranscriptView } from "../src/contracts.ts";

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

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const lineageEdge = (upstream_id: string, downstream_id: string, path = "/tmp/handoff.md") => ({
  upstream_id, downstream_id, path, produced_at: 1, referenced_at: 2,
  producer_turn: 3, reference_turn: 0, reference_source: "user" as const, kind: "add" as const,
});
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear(); history.replaceState(null, "", "/");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: Array.from({ length: 101 }, (_, index) => makeRow(index)) });
    if (url.startsWith("/api/search")) return response({ total: 1, results: [{ ...makeRow(42), snippet: "deep transcript needle" }] });
    if (url === "/api/lineage/index") return response({ sessions: 101, scanned: 101, unchanged: 0, removed: 0, writes: 2, references: 2, edges: 1, elapsed_ms: 12 });
    if (url.startsWith("/api/lineage")) return response({ sessions: [
      { ...makeRow(99), name: "codex接管pi的submit混乱设计", birth: new Date(2026, 6, 15, 17, 40).getTime() / 1000 },
      { ...makeRow(100), name: "草，你怎么能改 submit 接口呢？", birth: new Date(2026, 6, 16, 10, 43).getTime() / 1000 },
    ], edges: [{
      upstream_id: "session-99", downstream_id: "session-100", path: "/tmp/handoff.md",
      produced_at: 1, referenced_at: 2, producer_turn: 3, reference_turn: 0, reference_source: "user", kind: "add",
    }] });
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
  test("filters, sorts, and paginates the public list", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get(".tagline").text()).toBe("找到上下文，继续工作。");
    expect(wrapper.get(".meta").text()).toContain("101 个会话");
    expect(wrapper.get(".meta").text()).toMatch(/更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(wrapper.findAll("tbody tr")).toHaveLength(100);
    expect(wrapper.text()).toContain("第 1 / 2 页");
    expect(wrapper.findAll(".rs")).toHaveLength(12);
    expect(wrapper.findAll("thead th")).toHaveLength(15);
    expect(wrapper.findAll("tbody tr.row .lineagecell")).toHaveLength(100);
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

    const nameSort = wrapper.findAll("thead button").find((button) => button.text() === "名称")!;
    expect(nameSort).toBeUndefined();
    const nameHeader = wrapper.findAll("thead th").find((header) => header.text().startsWith("名称"))!;
    await nameHeader.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 99");
    await nameHeader.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 0");
    await wrapper.findAll(".tabs button").find((button) => button.text().startsWith("★ 标记"))!.trigger("click");
    expect(wrapper.findAll("tbody tr")).toHaveLength(1);
    expect(wrapper.get("tbody .notecell").text()).toBe("priority");
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
    const copyPath = wrapper.findAll("button").find((button) => button.text() === "复制路径")!;
    await copyPath.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("/home/fixture/sessions/session-100.jsonl");
    expect(copyPath.text()).toBe("已复制");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copyPath.text()).toBe("复制路径");
    await wrapper.findAll("button").find((button) => button.text() === "查看")!.trigger("click");
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

  test("shows the cached global DAG and loads the complete DAG automatically in Session detail", async () => {
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    await wrapper.get("#showLineages").trigger("click");
    await flushPromises();
    const graph = wrapper.get("[aria-label='全部关系链']");
    const nodes = graph.findAll(".dag-node");
    expect(nodes).toHaveLength(2);
    expect(graph.findAll(".dag-link")).toHaveLength(1);
    expect(graph.findAll(".dag-file")).toHaveLength(1);
    expect(graph.get(".dag-file").text()).toContain("handoff.md");
    expect(graph.get<HTMLElement>(".dag-canvas").element.style.width).toBe("838px");
    expect(graph.get(".dag-canvas svg").attributes("viewBox")).toBe("0 0 838 168");
    expect((nodes[1]!.element as HTMLElement).style.left).toBe("554px");
    const fileLeft = Number.parseInt(graph.get<HTMLElement>(".dag-file").element.style.left);
    const targetLeft = Number.parseInt((nodes[1]!.element as HTMLElement).style.left);
    expect(targetLeft - fileLeft - 220).toBe(62);
    expect(graph.get(".dag-link path").attributes("marker-end")).toContain("dag-open-arrow-");
    expect(graph.get("marker path").attributes("fill")).toBe("none");
    expect(graph.get(".dag-card-head").text()).toContain("2026-07-15 17:40");
    expect(graph.get(".dag-card-head").text()).toContain("codex接管pi的submit混乱设计");
    expect(graph.get(".dag-card-head").text()).toContain("17 小时 03 分钟");
    expect(graph.get(".dag-card-head").text()).toContain("2026-07-16 10:43");
    expect(graph.get(".dag-card-head").text()).toContain("草，你怎么能改 submit 接口呢？");
    expect(graph.find(".dag-link text").exists()).toBe(false);
    expect(graph.get(".dag-link path title").text()).toBe("/tmp/handoff.md");
    expect((nodes[0]!.element as HTMLElement).style.getPropertyValue("--node-delay")).toBe("");
    await nodes[0]!.trigger("mouseenter");
    expect(nodes.every((node) => node.classes().includes("connected"))).toBe(true);
    expect(nodes.some((node) => node.classes().includes("dim"))).toBe(false);
    expect(graph.get(".dag-link").classes()).toContain("active");
    await nodes[0]!.trigger("mouseleave");
    expect(nodes.some((node) => node.classes().includes("connected"))).toBe(false);
    expect(graph.get(".dag-link").classes()).not.toContain("active");
    await wrapper.get("#lineageIndex").trigger("click");
    await flushPromises();
    expect(wrapper.get("#toast").text()).toContain("发现 1 条关系");

    await wrapper.get("#showSessions").trigger("click");
    await wrapper.findAll("button").find((button) => button.text() === "查看")!.trigger("click");
    await flushPromises();
    expect(wrapper.find("#sessionLineage").exists()).toBe(false);
    expect(wrapper.get("[aria-label='Session 关系链']").findAll(".dag-node")).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/lineage?id=session-100&refresh=0")).toBe(true);
    wrapper.unmount();
  });

  test("merges one produced file into a shared node with separate downstream routes", async () => {
    const sessions = [makeRow(1), makeRow(2), makeRow(3)];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions });
      if (url === "/api/lineages") return response({ sessions, edges: [
        lineageEdge("session-1", "session-2", "/tmp/shared-handoff.md"),
        lineageEdge("session-1", "session-3", "/tmp/shared-handoff.md"),
      ] });
      return response({ ok: true });
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get("#showLineages").trigger("click");
    await flushPromises();
    const graph = wrapper.get("[aria-label='全部关系链']");
    expect(graph.findAll(".dag-file")).toHaveLength(1);
    expect(graph.get(".dag-file").text()).toContain("2 下游");
    expect(graph.findAll(".dag-link")).toHaveLength(2);
    expect(new Set(graph.findAll(".dag-link path").map((path) => path.attributes("d"))).size).toBe(2);
    wrapper.unmount();
  });

  test("loads chain badges from one cached request, filters them, previews on hover, and refreshes after analysis", async () => {
    vi.useFakeTimers();
    const allRows = Array.from({ length: 101 }, (_, index) => makeRow(index));
    let lineageLoads = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: allRows });
      if (url === "/api/lineage/index") return response({ sessions: 101, scanned: 101, unchanged: 0, removed: 0, writes: 3, references: 3, edges: 2, elapsed_ms: 12 });
      if (url === "/api/lineages") {
        lineageLoads++;
        const sessions = lineageLoads === 1 ? [makeRow(99), makeRow(100)] : [makeRow(98), makeRow(99), makeRow(100)];
        const edges = lineageLoads === 1 ? [lineageEdge("session-99", "session-100")] : [lineageEdge("session-98", "session-99"), lineageEdge("session-99", "session-100")];
        return response({ sessions, edges });
      }
      if (url.startsWith("/api/session")) {
        const id = new URL(url, "http://local").searchParams.get("id")!;
        return response({ ...allRows.find((row) => row.id === id)!, messages: [{ role: "user", text: "preview", timestamp: "" }] } satisfies TranscriptView);
      }
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/lineages")).toHaveLength(1);
    expect(wrapper.findAll(".chain-chip")).toHaveLength(2);
    expect(wrapper.get(".chain-chip").text()).toBe("预览 2");
    const noChainRow = wrapper.findAll("tbody tr.row").find((row) => row.find(".name-text").text() === "Session 98")!;
    expect(noChainRow.find(".chain-chip").exists()).toBe(false);

    const message = wrapper.get("td.msg");
    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
    expect(wrapper.find("#tip").exists()).toBe(true);
    const chip = wrapper.get(".chain-chip");
    await chip.trigger("mouseenter");
    expect(wrapper.find("#tip").exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(181);
    expect(wrapper.get("#lineage-preview").attributes("role")).toBe("dialog");
    expect(wrapper.findAll("#lineage-preview .lineage-mini-node")).toHaveLength(2);
    expect(wrapper.findAll("#lineage-preview .mini-edge")).toHaveLength(1);
    expect(wrapper.find("#lineage-preview .lineage-mini-node.current").exists()).toBe(true);
    expect(wrapper.get("#lineage-preview .mini-edge").attributes("marker-end")).toContain("mini-arrow-");
    expect(wrapper.get("#lineage-preview .mini-label").text()).toBe("handoff.md");
    expect(wrapper.get("#lineage-preview .mini-label").element.tagName).toBe("SPAN");
    expect(wrapper.get("#lineage-preview .mini-label").attributes("title")).toBe("/tmp/handoff.md");
    await wrapper.get("#lineage-preview .mini-scroll").trigger("scroll");
    expect(wrapper.find("#lineage-preview").exists()).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/lineages")).toHaveLength(1);
    await chip.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(101);
    expect(wrapper.find("#lineage-preview").exists()).toBe(false);

    const chainTab = wrapper.findAll(".tabs button").find((button) => button.text().startsWith("⛓ 有链"))!;
    expect(chainTab.attributes("data-count")).toBe("2");
    await chainTab.trigger("click");
    expect(wrapper.findAll("tbody tr.row")).toHaveLength(2);
    await wrapper.get("#showLineages").trigger("click");
    await wrapper.get("#lineageIndex").trigger("click");
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/lineages")).toHaveLength(2);
    await wrapper.get("#showSessions").trigger("click");
    const refreshedTab = wrapper.findAll(".tabs button").find((button) => button.text().startsWith("⛓ 有链"))!;
    expect(refreshedTab.attributes("data-count")).toBe("3");
    expect(wrapper.get(".chain-chip").text()).toBe("预览 3");
    wrapper.unmount();
  });

  test("pins the chain preview with keyboard focus, traps Tab, restores focus on Escape, and opens a node", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const chip = wrapper.get<HTMLButtonElement>(".chain-chip");
    chip.element.focus();
    await flushPromises();
    expect(chip.attributes("aria-expanded")).toBe("true");
    expect(chip.attributes("aria-controls")).toBe("lineage-preview");
    await chip.trigger("keydown", { key: "Enter" });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();

    await chip.trigger("click", { detail: 0 });
    await flushPromises();
    expect(wrapper.get("#lineage-preview").text()).toContain("已固定 · Esc 关闭");
    expect(document.activeElement?.classList.contains("current")).toBe(true);
    await chip.trigger("mouseleave");
    await vi.advanceTimersByTimeAsync(101);
    expect(wrapper.find("#lineage-preview").exists()).toBe(true);
    const controls = wrapper.get("#lineage-preview").findAll<HTMLButtonElement>("button");
    controls.at(-1)!.element.focus();
    await controls.at(-1)!.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(controls[0]!.element);
    await controls[0]!.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(controls.at(-1)!.element);
    await controls.at(-1)!.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("#lineage-preview").exists()).toBe(false);
    expect(document.activeElement).toBe(chip.element);
    expect(chip.attributes("aria-expanded")).toBe("false");

    await chip.trigger("click", { detail: 1 });
    expect(document.activeElement).toBe(chip.element);
    await chip.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.find("#lineage-preview").exists()).toBe(false);
    await chip.trigger("click", { detail: 1 });
    await wrapper.get("#lineage-preview .lineage-mini-node.current").trigger("click");
    await flushPromises();
    expect(location.search).toBe("?session=session-100");
    wrapper.unmount();
  });

  test("hides chain controls when the cached graph has no edges", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions: [makeRow(1), makeRow(2)] });
      if (url === "/api/lineages") return response({ sessions: [], edges: [] });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.find(".chain-chip").exists()).toBe(false);
    expect(wrapper.findAll(".tabs button").some((button) => button.text().startsWith("⛓ 有链"))).toBe(false);
    wrapper.unmount();
  });

  test("clips large chains to direct neighbors with disjoint upstream, downstream, and branch counts", async () => {
    vi.useFakeTimers();
    const ids = ["a", "u1", "u2", "u3", "u4", "u5", "current", "d1", "d2", "d3", "d4", "d5", "z", "b1", "b2"];
    const sessions = ids.map((id, index) => ({ ...makeRow(index), id, name: id, birth: index + 1, mtime: index + 1 }));
    const edges = [
      lineageEdge("a", "u1"), ...[1, 2, 3, 4, 5].map((index) => lineageEdge(`u${index}`, "current")),
      ...[1, 2, 3, 4, 5].map((index) => lineageEdge("current", `d${index}`)), lineageEdge("d1", "z"),
      lineageEdge("u1", "b1"), lineageEdge("b1", "b2"),
    ];
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions });
      if (url === "/api/lineages") return response({ sessions, edges });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const row = wrapper.findAll("tbody tr.row").find((item) => item.get(".name-text").text() === "current")!;
    expect(row.get(".chain-chip").text()).toBe("预览 15");
    await row.get(".chain-chip").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    const dialog = wrapper.get("#lineage-preview");
    expect(dialog.text()).toContain("仅显示相邻一层");
    expect(dialog.findAll(".lineage-mini-node")).toHaveLength(9);
    expect(dialog.get(".mini-fold.upstream").attributes("data-count")).toBe("2");
    expect(dialog.get(".mini-fold.downstream").attributes("data-count")).toBe("2");
    expect(dialog.get(".mini-fold.branch").attributes("data-count")).toBe("2");
    const hidden = dialog.findAll(".mini-fold").reduce((total, fold) => total + Number(fold.attributes("data-count")), 0);
    expect(dialog.findAll(".lineage-mini-node").length + hidden).toBe(15);
    await dialog.get(".mini-fold.branch").trigger("click");
    await flushPromises();
    expect(wrapper.find("#lineageOverview .dag-node.focus").exists()).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/lineages")).toHaveLength(1);
    wrapper.unmount();
  });

  test("commits star, note, status, and archive only after success", async () => {
    const wrapper = mount(App);
    await flushPromises();
    const row = wrapper.get("tbody tr");
    const star = row.find("button[aria-label='标记重要']");
    await star.trigger("click"); await flushPromises();
    expect(star.text()).toBe("★");

    await row.get(".notecell").trigger("click");
    const note = row.get<HTMLInputElement>("input[aria-label='备注']");
    await note.setValue("kept note"); await note.trigger("blur"); await flushPromises();
    expect(row.get(".notecell").text()).toBe("kept note");
    await row.get(".notecell").trigger("click");
    const rejectedNote = row.get<HTMLInputElement>("input[aria-label='备注']");
    await rejectedNote.setValue("Rejected note"); await rejectedNote.trigger("blur"); await flushPromises();
    expect(row.get(".notecell").text()).toBe("kept note");

    await row.get(".namecell").trigger("click");
    const name = row.get<HTMLInputElement>("input[aria-label='名称']");
    expect(name.element.value).toBe("Session 100");
    await name.setValue("Rejected"); await name.trigger("blur"); await flushPromises();
    expect(wrapper.get("[role='alert']").text()).toBe("改名失败");
    expect(row.get(".name-text").text()).toBe("Session 100");

    await row.get(".statusbtn").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().startsWith("done"))!.trigger("click");
    await flushPromises();
    expect(row.get(".statusbtn").text()).toBe("done");
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ method: "POST" }));
    await row.findAll("button").find((button) => button.text() === "归档")!.trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ body: expect.stringContaining('"archive":true') }));
    await wrapper.findAll(".tabs button").find((button) => button.text().startsWith("归档"))!.trigger("click");
    expect(wrapper.get("tbody .name-text").text()).toBe("Session 100");
    wrapper.unmount();
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

    await wrapper.find("td.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("Readable fixture");
    expect(wrapper.get("#tip .markdown h2").text()).toBe("Readable fixture");

    await wrapper.find(".rs").trigger("pointerdown", { clientX: 100 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 130 }));
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(JSON.parse(localStorage.getItem("colw6") || "[]")[0]).toBeGreaterThanOrEqual(36);
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
    const message = wrapper.get("td.msg");

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
      if (url === "/api/lineages") return response({ sessions: [], edges: [] });
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
      if (url.startsWith("/api/lineage")) return response({ sessions: [], edges: [] });
      return response({ ok: true });
    });
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();

    await wrapper.get("td.msg").trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181);
    await flushPromises();
    expect(wrapper.get("#tip").text()).toContain("before refresh");
    await wrapper.get("#reload").trigger("click");
    await flushPromises();
    await wrapper.get(".detailbtn").trigger("click");
    await flushPromises();

    expect(wrapper.get("#detail").text()).toContain("after refresh");
    expect(detailLoads).toBe(2);
    wrapper.unmount();
  });

  test("does not load a Transcript when preview hover ends before the delay", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const message = wrapper.get("td.msg");

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
    const messages = wrapper.findAll("td.msg");

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
    await row.get(".namecell").trigger("click");
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
