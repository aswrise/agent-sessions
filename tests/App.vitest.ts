import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "../src/App.vue";
import type { SessionView, TranscriptView } from "../src/contracts.ts";
import { layoutLineages, LINEAGE_GRAPH_LAYOUT } from "../src/lineageLayout.ts";

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
  relation: "artifact" as const, upstream_id, downstream_id, path, produced_at: 1, referenced_at: 2,
  producer_turn: 3, reference_turn: 0, reference_source: "user" as const, kind: "add" as const,
});
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
    if (url.startsWith("/api/search")) return response({ total: 1, results: [{ ...makeRow(42), snippet: "deep transcript needle" }] });
    if (url === "/api/lineage/index") return response({ sessions: 101, scanned: 101, unchanged: 0, removed: 0, writes: 2, references: 2, edges: 1, elapsed_ms: 12 });
    if (url.startsWith("/api/lineage")) return response({ sessions: [
      { ...makeRow(99), name: "codex接管pi的submit混乱设计", birth: new Date(2026, 6, 15, 17, 40).getTime() / 1000 },
      { ...makeRow(100), name: "草，你怎么能改 submit 接口呢？", birth: new Date(2026, 6, 16, 10, 43).getTime() / 1000 },
    ], edges: [{
      relation: "artifact", upstream_id: "session-99", downstream_id: "session-100", path: "/tmp/handoff.md",
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
  vi.stubGlobal("confirm", vi.fn(() => true));
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
    await graph.get(".dag-file").trigger("mouseenter");
    expect(nodes.every((node) => node.classes().includes("connected"))).toBe(true);
    expect(graph.get(".dag-file-source").classes()).toContain("active");
    expect(graph.get(".dag-link").classes()).toContain("active");
    await graph.get(".dag-file").trigger("mouseleave");
    expect(nodes.some((node) => node.classes().includes("connected"))).toBe(false);
    expect(graph.get(".dag-link").classes()).not.toContain("active");
    await wrapper.get("#lineageIndex").trigger("click");
    await flushPromises();
    expect(wrapper.get("#toast").text()).toContain("发现 1 条关系");

    await wrapper.get("#showSessions").trigger("click");
    await wrapper.get("[aria-label='打开详情页']").trigger("click");
    await flushPromises();
    expect(wrapper.find("#sessionLineage").exists()).toBe(false);
    expect(wrapper.get("[aria-label='Session 关系链']").findAll(".dag-node")).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/lineage?id=session-100")).toBe(true);
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

  test("centers file nodes between their endpoint blocks without overlap", () => {
    const sessions = [makeRow(1), makeRow(2), makeRow(3), makeRow(4)];
    const chain = layoutLineages({ sessions, edges: [
      lineageEdge("session-1", "session-3", "/tmp/shared.md"),
      lineageEdge("session-1", "session-4", "/tmp/shared.md"),
      lineageEdge("session-2", "session-3", "/tmp/other.md"),
    ] }, LINEAGE_GRAPH_LAYOUT)[0]!;
    const shared = chain.files.find((file) => file.path === "/tmp/shared.md")!;
    const other = chain.files.find((file) => file.path === "/tmp/other.md")!;
    expect(shared.y).toBe(68);
    expect(other.y).toBe(128);
    expect(other.y - shared.y).toBeGreaterThanOrEqual(LINEAGE_GRAPH_LAYOUT.fileHeight!);
  });

  test("expands the canvas when collision avoidance pushes file nodes down", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => makeRow(index));
    const edges = [
      ...sessions.slice(1, 11).map((session) => lineageEdge("session-0", session.id, "/tmp/shared.md")),
      ...Array.from({ length: 10 }, (_, index) => lineageEdge("session-10", "session-11", `/tmp/${index}.md`)),
    ];
    const chain = layoutLineages({ sessions, edges }, LINEAGE_GRAPH_LAYOUT)[0]!;
    const lowestFileBottom = Math.max(...chain.files.map((file) => file.y + LINEAGE_GRAPH_LAYOUT.fileHeight!));
    expect(chain.height).toBeGreaterThanOrEqual(lowestFileBottom + LINEAGE_GRAPH_LAYOUT.y);
  });

  test("adds a manual upstream from Session detail and refreshes the graph", async () => {
    const sessions = [makeRow(1), makeRow(2)];
    let added = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/sessions")) return response({ generatedAt: new Date(0).toISOString(), home: "/home/fixture", sessions });
      if (url.startsWith("/api/session")) {
        const id = new URL(url, "http://local").searchParams.get("id")!;
        return response({ ...sessions.find((row) => row.id === id)!, messages: [] } satisfies TranscriptView);
      }
      if (url === "/api/lineage/manual" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ upstream_id: "session-1", downstream_id: "session-2" });
        added = true;
        return response({ ok: true });
      }
      if (url === "/api/lineage/manual" && init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ upstream_id: "session-1", downstream_id: "session-2" });
        added = false;
        return response({ ok: true });
      }
      const edge = { relation: "manual" as const, upstream_id: "session-1", downstream_id: "session-2", created_at: 1 };
      if (url.startsWith("/api/lineage?id=")) return response(added ? { sessions, edges: [edge] } : { sessions: [sessions[1]], edges: [] });
      if (url === "/api/lineages") return response(added ? { sessions, edges: [edge] } : { sessions: [], edges: [] });
      return response({ ok: true });
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.findAll("[aria-label='打开详情页']")[0]!.trigger("click");
    await flushPromises();

    await wrapper.get("#addManualLineage").trigger("click");
    expect(wrapper.findAll("#manualUpstreamOptions option")).toHaveLength(1);
    await wrapper.get<HTMLInputElement>("#manualUpstream").setValue("session-1");
    await wrapper.get("#manualLineageForm").trigger("submit");
    await flushPromises();

    expect(added).toBe(true);
    expect(wrapper.get("[aria-label='Session 关系链'] .dag-file").text()).toContain("MANUAL");
    expect(wrapper.get("[aria-label='Session 关系链'] .dag-file").text()).toContain("手动关联");
    expect(wrapper.get("#toast").text()).toContain("已添加手动上游");

    await wrapper.get(".remove-manual-lineage").trigger("click");
    await flushPromises();
    expect(wrapper.find("[aria-label='Session 关系链'] .dag-file").exists()).toBe(false);
    expect(wrapper.get("#toast").text()).toContain("已取消手动关联");
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
    expect(wrapper.findAll(".chainbtn")).toHaveLength(2);
    expect(wrapper.get(".chainbtn").text()).toBe("2");
    const noChainRow = wrapper.findAll("tbody tr.row").find((row) => row.find(".name-text").text() === "Session 98")!;
    expect(noChainRow.find(".chainbtn").exists()).toBe(false);

    const message = wrapper.get(".line2.msg");
    await message.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
    expect(wrapper.find("#tip").exists()).toBe(true);
    const chip = wrapper.get(".chainbtn");
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
    expect(wrapper.get(".chainbtn").text()).toBe("3");
    wrapper.unmount();
  });

  test("pins the chain preview with keyboard focus, traps Tab, restores focus on Escape, and opens a node", async () => {
    vi.useFakeTimers();
    const wrapper = mount(App, { attachTo: document.body });
    await flushPromises();
    const chip = wrapper.get<HTMLButtonElement>(".chainbtn");
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
    expect(wrapper.find(".chainbtn").exists()).toBe(false);
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
    expect(row.get(".chainbtn").text()).toBe("15");
    await row.get(".chainbtn").trigger("mouseenter");
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

    await row.get(".statusbtn").trigger("click");
    await wrapper.findAll(".menu-option").find((option) => option.text().startsWith("done"))!.trigger("click");
    await flushPromises();
    expect(row.get(".statusbtn").text()).toBe("done");
    expect(fetchMock).toHaveBeenCalledWith("/star", expect.objectContaining({ method: "POST" }));
    await row.get("[aria-label='归档']").trigger("click");
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
    expect(target.text()).toBe("未命名会话");
    await target.trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(181); await flushPromises();
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
