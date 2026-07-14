<script setup lang="ts">
import MarkdownIt from "markdown-it";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  parseSessionsEnvelope,
  parseTranscriptView,
  STATUSES,
  type SessionStatus,
  type SessionView,
  type Tool,
  type TranscriptView,
} from "./contracts.ts";

type Tab = "" | Tool | "__star__" | "__arch__";
type SortKey = keyof Pick<SessionView, "starred" | "mtime" | "birth" | "tool" | "model" | "name" | "star_note" | "status" | "first_msg" | "cwd" | "size_kb">;
type MenuItem = { value: string; label: string };
type MenuState = {
  key: string;
  anchor: HTMLElement;
  items: MenuItem[];
  value: string;
  select: (value: string) => void | Promise<void>;
  style: Record<string, string>;
};
type Editing = { id: string; field: "name" | "star_note" };
type PreviewState =
  | { key: string; kind: "text"; text: string; anchor: HTMLElement; style: Record<string, string> }
  | { key: string; kind: "transcript"; detail?: TranscriptView; loading: boolean; anchor: HTMLElement; style: Record<string, string> };

const PAGE_SIZE = 100;
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });
const statusMeta: Record<SessionStatus, { label: string; color: string }> = {
  "": { label: "无", color: "var(--ash)" },
  todo: { label: "todo", color: "var(--fog)" },
  "in progress": { label: "progress", color: "#78b8ff" },
  review: { label: "review", color: "#c6a4ff" },
  blocked: { label: "blocked", color: "#ff8d8d" },
  done: { label: "done", color: "#6fd49b" },
  archived: { label: "archived", color: "var(--ash)" },
};
const statusItems = STATUSES.map((value) => ({ value, label: value || "无" }));

const rows = ref<SessionView[]>([]);
const generatedAt = ref("");
const home = ref("");
const loading = ref(true);
const error = ref("");
const notice = ref("");
const tab = ref<Tab>("");
const keyword = ref("");
const effectiveKeyword = ref("");
const path = ref("");
const status = ref<SessionStatus>("");
const updatedFrom = ref("");
const updatedTo = ref("");
const createdFrom = ref("");
const createdTo = ref("");
const sizeMin = ref("");
const sizeMax = ref("");
const advanced = ref(false);
const sortKey = ref<SortKey | "">("");
const sortAscending = ref(false);
const page = ref(1);
const pending = ref(new Set<string>());
const detail = ref<TranscriptView>();
const detailLoading = ref(false);
const detailError = ref("");
const editing = ref<Editing>();
const editValue = ref("");
const menu = ref<MenuState>();
const menuElement = ref<HTMLElement>();
const preview = ref<PreviewState>();
const previewElement = ref<HTMLElement>();
const previewCache = new Map<string, TranscriptView>();
const previewRequests = new Map<string, Promise<TranscriptView>>();
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let previewShowTimer: ReturnType<typeof setTimeout> | undefined;
let previewHideTimer: ReturnType<typeof setTimeout> | undefined;

function savedWidths(): number[] {
  for (const key of ["colw5", "column-widths"]) {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(value)) return value.map((width) => typeof width === "number" && Number.isFinite(width) && width >= 36 ? width : 0);
    } catch {}
  }
  return [];
}
const widths = ref(savedWidths());

function initialTheme(): "dark" | "light" {
  const saved = localStorage.getItem("theme");
  if (saved === "dark" || saved === "light") return saved;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
const theme = ref<"dark" | "light">(initialTheme());

const tabs: { value: Tab; label: string }[] = [
  { value: "", label: "全部" },
  { value: "claude", label: "claude" },
  { value: "codex", label: "codex" },
  { value: "pi", label: "pi" },
  { value: "__star__", label: "★ 标记" },
  { value: "__arch__", label: "归档" },
];

const tabCounts = computed<Record<Tab, number>>(() => ({
  "": rows.value.filter((row) => !row.archived).length,
  claude: rows.value.filter((row) => !row.archived && row.tool === "claude").length,
  codex: rows.value.filter((row) => !row.archived && row.tool === "codex").length,
  pi: rows.value.filter((row) => !row.archived && row.tool === "pi").length,
  __star__: rows.value.filter((row) => !row.archived && row.starred).length,
  __arch__: rows.value.filter((row) => row.archived).length,
}));

const pathItems = computed<MenuItem[]>(() => {
  const counts = new Map<string, number>();
  for (const row of rows.value) counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
  return [{ value: "", label: "全部路径" }, ...[...counts]
    .sort((left, right) => right[1] - left[1])
    .map(([value, count]) => ({ value, label: `${shortPath(value)} (${count})` }))];
});
const pathLabel = computed(() => pathItems.value.find((item) => item.value === path.value)?.label ?? "全部路径");
const activeFilterCount = computed(() =>
  [updatedFrom, updatedTo, createdFrom, createdTo, sizeMin, sizeMax].filter((value) => value.value).length + (status.value ? 1 : 0));

function toEpoch(value: string, end = false): number | undefined {
  return value ? new Date(`${value}T${end ? "23:59:59" : "00:00:00"}`).getTime() / 1000 : undefined;
}

const filtered = computed(() => {
  const query = effectiveKeyword.value.trim().toLowerCase();
  const fromUpdate = toEpoch(updatedFrom.value);
  const toUpdate = toEpoch(updatedTo.value, true);
  const fromCreate = toEpoch(createdFrom.value);
  const toCreate = toEpoch(createdTo.value, true);
  const min = Number.parseFloat(sizeMin.value);
  const max = Number.parseFloat(sizeMax.value);
  const result = rows.value.filter((row) => {
    if (tab.value === "__arch__" ? !row.archived : row.archived) return false;
    if (tab.value === "__star__" && !row.starred) return false;
    if (["claude", "codex", "pi"].includes(tab.value) && row.tool !== tab.value) return false;
    if (path.value && row.cwd !== path.value) return false;
    if (status.value && row.status !== status.value) return false;
    if (fromUpdate && row.mtime < fromUpdate || toUpdate && row.mtime > toUpdate) return false;
    if (fromCreate && row.birth < fromCreate || toCreate && row.birth > toCreate) return false;
    if (!Number.isNaN(min) && row.size_kb < min * 1024 || !Number.isNaN(max) && row.size_kb > max * 1024) return false;
    return !query || `${row.name} ${row.star_note} ${row.first_msg}`.toLowerCase().includes(query);
  });
  if (!sortKey.value) return result.sort((left, right) => right.mtime - left.mtime);
  return result.sort((left, right) => {
    const a = left[sortKey.value as SortKey];
    const b = right[sortKey.value as SortKey];
    return (a < b ? -1 : a > b ? 1 : 0) * (sortAscending.value ? 1 : -1);
  });
});
const pages = computed(() => Math.ceil(filtered.value.length / PAGE_SIZE));
const visible = computed(() => filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));
const footerText = computed(() => {
  const total = filtered.value.length;
  if (!total) return "";
  const start = (page.value - 1) * PAGE_SIZE;
  const range = pages.value > 1 ? `显示第 ${start + 1}-${start + visible.value.length} 行，共 ${total} 个匹配` : `${total} 个匹配`;
  return `${range}。点击行复制恢复命令，点详情打开详情页，首条消息悬停预览对话`;
});

watch(keyword, (value) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { effectiveKeyword.value = value; page.value = 1; }, 120);
});
watch([path, status, updatedFrom, updatedTo, createdFrom, createdTo, sizeMin, sizeMax], () => { page.value = 1; });
watch(pages, (value) => { page.value = value ? Math.min(page.value, value) : 1; });

function shortPath(value: string): string {
  if (!home.value) return value;
  const separator = home.value.includes("\\") ? "\\" : "/";
  return value === home.value || value.startsWith(home.value + separator) ? `~${value.slice(home.value.length)}` : value;
}

function formatDate(epoch: number): string {
  const date = new Date(epoch * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatGeneratedAt(value: string): string {
  const epoch = Date.parse(value);
  if (Number.isNaN(epoch)) return "--";
  const date = new Date(epoch);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSize(sizeKb: number): string {
  return sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)}M` : `${sizeKb}K`;
}

function showToast(message: string, failed = false): void {
  clearTimeout(toastTimer);
  if (failed) { error.value = message; notice.value = ""; }
  else { notice.value = message; error.value = ""; }
  toastTimer = setTimeout(() => { error.value = ""; notice.value = ""; }, 1200);
}

async function load(fresh = false): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch(`/api/sessions${fresh ? "?fresh=1" : ""}`);
    if (!response.ok) throw new Error("加载失败");
    const envelope = parseSessionsEnvelope(await response.json());
    rows.value = envelope.sessions;
    generatedAt.value = envelope.generatedAt;
    home.value = envelope.home;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function persist(row: SessionView, route: "/star" | "/rename", body: Record<string, unknown>, apply: () => void, success: string): Promise<boolean> {
  pending.value = new Set(pending.value).add(row.id);
  try {
    const response = await fetch(route, { method: "POST", body: JSON.stringify({ id: row.id, ...body }) });
    if (!response.ok) throw new Error("保存失败");
    apply();
    previewCache.delete(row.id);
    showToast(success);
    return true;
  } catch {
    showToast(route === "/rename" ? "改名失败" : "保存失败", true);
    return false;
  } finally {
    const next = new Set(pending.value);
    next.delete(row.id);
    pending.value = next;
  }
}

async function toggleStar(row: SessionView): Promise<void> {
  const starred = !row.starred;
  await persist(row, "/star", { star: starred }, () => { row.starred = starred; }, starred ? "已标记" : "已取消");
}

async function toggleArchive(row: SessionView): Promise<void> {
  const archived = !row.archived;
  await persist(row, "/star", { archive: archived }, () => { row.archived = archived; }, archived ? "已归档" : "已解除归档");
}

function startEdit(row: SessionView, field: Editing["field"]): void {
  if (pending.value.has(row.id)) return;
  editing.value = { id: row.id, field };
  editValue.value = row[field];
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-edit="${row.id}:${field}"]`);
    input?.focus();
    input?.select();
  });
}

async function finishEdit(row: SessionView, field: Editing["field"], save: boolean): Promise<void> {
  if (editing.value?.id !== row.id || editing.value.field !== field) return;
  const old = row[field];
  const value = editValue.value.trim();
  editing.value = undefined;
  if (!save || value === old) return;
  if (field === "name" && !value) { showToast("名称不能为空", true); return; }
  const route = field === "name" ? "/rename" : "/star";
  const body = field === "name" ? { name: value } : { note: value };
  const success = field === "name" && row.tool === "codex" ? "已同步 Codex Session 名称" : "已保存";
  await persist(row, route, body, () => { row[field] = value; }, success);
}

function editKeydown(row: SessionView, field: Editing["field"], event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === "Enter") { event.preventDefault(); void finishEdit(row, field, true); }
  else if (event.key === "Escape") { event.preventDefault(); void finishEdit(row, field, false); }
}

function setTab(value: Tab): void {
  tab.value = value;
  page.value = 1;
  closeMenu();
}

function sort(key: SortKey): void {
  sortAscending.value = sortKey.value === key ? !sortAscending.value : false;
  sortKey.value = key;
  page.value = 1;
}

async function copy(row: SessionView | TranscriptView): Promise<void> {
  await navigator.clipboard.writeText(row.resume_command);
  showToast("已复制恢复命令");
}

function clearFilters(): void {
  keyword.value = "";
  effectiveKeyword.value = "";
  path.value = "";
  status.value = "";
  updatedFrom.value = updatedTo.value = createdFrom.value = createdTo.value = "";
  sizeMin.value = sizeMax.value = "";
  tab.value = "";
  page.value = 1;
  advanced.value = false;
  closeMenu();
}

async function placeMenu(): Promise<void> {
  await nextTick();
  if (!menu.value || !menuElement.value) return;
  const box = menu.value.anchor.getBoundingClientRect();
  const width = Math.min(Math.max(menu.value.key === "path" ? 320 : box.width, 150), innerWidth - 24);
  let top = box.bottom + 6;
  let origin = "top left";
  if (top + menuElement.value.offsetHeight > innerHeight - 12) {
    top = Math.max(12, box.top - menuElement.value.offsetHeight - 6);
    origin = "bottom left";
  }
  menu.value.style = {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`,
    top: `${top}px`,
    transformOrigin: origin,
  };
  await nextTick();
  const selected = menuElement.value.querySelector<HTMLElement>("[aria-selected='true']") ?? menuElement.value.querySelector<HTMLElement>("button");
  selected?.focus();
}

function openMenu(key: string, anchor: HTMLElement, items: MenuItem[], value: string, select: MenuState["select"]): void {
  if (menu.value?.key === key) { closeMenu(true); return; }
  closeMenu();
  menu.value = { key, anchor, items, value, select, style: {} };
  void placeMenu();
}

function closeMenu(refocus = false): void {
  const anchor = menu.value?.anchor;
  menu.value = undefined;
  if (refocus) anchor?.focus();
}

function chooseMenu(item: MenuItem): void {
  const select = menu.value?.select;
  closeMenu();
  void select?.(item.value);
}

function menuKeydown(event: KeyboardEvent): void {
  if (!menuElement.value) return;
  const options = [...menuElement.value.querySelectorAll<HTMLElement>(".menu-option")];
  const index = options.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  } else if (event.key === "Home") { event.preventDefault(); options[0]?.focus(); }
  else if (event.key === "End") { event.preventDefault(); options.at(-1)?.focus(); }
  else if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
}

function openPathMenu(event: MouseEvent): void {
  openMenu("path", event.currentTarget as HTMLElement, pathItems.value, path.value, (value) => { path.value = value; page.value = 1; });
}

function openStatusFilter(event: MouseEvent): void {
  openMenu("status-filter", event.currentTarget as HTMLElement,
    [{ value: "", label: "全部状态" }, ...statusItems.slice(1)], status.value,
    (value) => { status.value = value as SessionStatus; page.value = 1; });
}

function openRowStatus(row: SessionView, event: MouseEvent): void {
  event.stopPropagation();
  openMenu(`status:${row.id}`, event.currentTarget as HTMLElement, statusItems, row.status, async (value) => {
    const next = value as SessionStatus;
    await persist(row, "/star", { status: next }, () => { row.status = next; }, next ? `状态：${next}` : "已清除状态");
  });
}

async function fetchDetail(id: string): Promise<TranscriptView> {
  const cached = previewCache.get(id);
  if (cached) return cached;
  const active = previewRequests.get(id);
  if (active) return active;
  const request = (async () => {
    try {
      const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error("加载失败");
      const value = parseTranscriptView(await response.json());
      previewCache.set(id, value);
      return value;
    } finally {
      previewRequests.delete(id);
    }
  })();
  previewRequests.set(id, request);
  return request;
}

async function openDetail(id: string, push = true): Promise<void> {
  detail.value = undefined;
  detailError.value = "";
  detailLoading.value = true;
  hidePreview();
  closeMenu();
  if (push) history.pushState(null, "", `/?session=${encodeURIComponent(id)}`);
  try { detail.value = await fetchDetail(id); }
  catch { detailError.value = "加载失败"; }
  finally { detailLoading.value = false; }
}

function showList(push = true): void {
  detail.value = undefined;
  detailError.value = "";
  detailLoading.value = false;
  if (push) history.pushState(null, "", "/");
}

function syncHistory(): void {
  const id = new URLSearchParams(location.search).get("session");
  if (id) void openDetail(id, false); else showList(false);
}

async function placePreview(): Promise<void> {
  await nextTick();
  if (!preview.value || !previewElement.value) return;
  const box = preview.value.anchor.getBoundingClientRect();
  const width = Math.min(820, innerWidth - 24);
  let top = box.bottom - 4;
  let origin = "top left";
  if (top + previewElement.value.offsetHeight > innerHeight - 8) {
    top = Math.max(8, box.top - previewElement.value.offsetHeight + 4);
    origin = "bottom left";
  }
  preview.value.style = {
    left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`,
    top: `${top}px`,
    transformOrigin: origin,
  };
}

function revealPreview(value: PreviewState): void {
  preview.value = value;
  void placePreview();
}

function showTextPreview(event: MouseEvent, key: string, text: string): void {
  const cell = event.currentTarget as HTMLElement;
  if (cell.scrollWidth <= cell.clientWidth + 1) { hidePreview(); return; }
  clearTimeout(previewHideTimer);
  clearTimeout(previewShowTimer);
  const value: PreviewState = { key, kind: "text", text, anchor: cell, style: {} };
  if (preview.value) revealPreview(value);
  else previewShowTimer = setTimeout(() => revealPreview(value), 180);
}

function showTranscriptPreview(row: SessionView, event: MouseEvent): void {
  const anchor = event.currentTarget as HTMLElement;
  const key = `transcript:${row.id}`;
  clearTimeout(previewHideTimer);
  clearTimeout(previewShowTimer);
  const state: PreviewState = { key, kind: "transcript", loading: true, anchor, style: {} };
  if (preview.value) revealPreview(state);
  else previewShowTimer = setTimeout(() => revealPreview(state), 180);
  void fetchDetail(row.id).then((value) => {
    if (preview.value?.key === key) {
      preview.value = { ...preview.value, kind: "transcript", detail: value, loading: false };
      void placePreview();
    } else if (previewShowTimer) {
      state.detail = value;
      state.loading = false;
    }
  }).catch(() => {
    if (preview.value?.key === key && preview.value.kind === "transcript") {
      preview.value = { ...preview.value, loading: false };
    }
  });
}

function schedulePreviewHide(): void {
  clearTimeout(previewHideTimer);
  previewHideTimer = setTimeout(hidePreview, 100);
}

function keepPreview(): void {
  clearTimeout(previewHideTimer);
}

function hidePreview(): void {
  clearTimeout(previewShowTimer);
  clearTimeout(previewHideTimer);
  previewShowTimer = undefined;
  preview.value = undefined;
}

function resize(index: number, event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  const start = event.clientX;
  const initial = widths.value[index] || (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
  const handle = event.currentTarget as HTMLElement;
  handle.classList.add("on");
  const move = (next: PointerEvent) => {
    const values = [...widths.value];
    values[index] = Math.max(36, initial + next.clientX - start);
    widths.value = values;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    handle.classList.remove("on");
    localStorage.setItem("colw5", JSON.stringify(widths.value.map((width) => width || null)));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function changePage(value: number): void {
  page.value = value;
  try { window.scrollTo(0, 0); } catch {}
}

function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem("theme", theme.value);
}

function keydown(event: KeyboardEvent): void {
  const editingControl = ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement).tagName);
  if (event.key === "/" && !editingControl) {
    event.preventDefault();
    document.querySelector<HTMLInputElement>("#q")?.focus();
  } else if (event.key === "Escape" && document.activeElement?.id === "q") {
    keyword.value = "";
    effectiveKeyword.value = "";
    page.value = 1;
    (document.activeElement as HTMLElement).blur();
  } else if (event.key === "Escape" && (detail.value || detailError.value)) showList();
}

function documentClick(event: MouseEvent): void {
  const target = event.target as Node;
  if (menu.value && !menuElement.value?.contains(target) && !menu.value.anchor.contains(target)) closeMenu();
}

function closeFloatingOnScroll(event: Event): void {
  if (event.target !== previewElement.value) hidePreview();
  if (event.target !== menuElement.value) closeMenu();
}

onMounted(async () => {
  document.documentElement.dataset.theme = theme.value;
  window.addEventListener("popstate", syncHistory);
  window.addEventListener("keydown", keydown);
  window.addEventListener("scroll", closeFloatingOnScroll, true);
  document.addEventListener("click", documentClick);
  await load(new URLSearchParams(location.search).get("fresh") === "1");
  syncHistory();
});

onBeforeUnmount(() => {
  clearTimeout(searchTimer);
  clearTimeout(toastTimer);
  clearTimeout(previewShowTimer);
  clearTimeout(previewHideTimer);
  window.removeEventListener("popstate", syncHistory);
  window.removeEventListener("keydown", keydown);
  window.removeEventListener("scroll", closeFloatingOnScroll, true);
  document.removeEventListener("click", documentClick);
});
</script>

<template>
  <header>
    <div class="brand">
      <span class="mark" aria-hidden="true">◆</span>
      <div><h1>Agent Sessions</h1><p class="tagline">找到上下文，继续工作。</p></div>
    </div>
    <span class="meta"><strong>{{ rows.length }}</strong> 个会话 · 更新于 {{ formatGeneratedAt(generatedAt) }}</span>
  </header>

  <div v-if="!detail && !detailError && !detailLoading" id="chrome" class="chrome">
    <div class="bar">
      <label class="searchbox">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
        <input id="q" v-model="keyword" type="search" placeholder="搜索名称、备注或首条消息…" aria-label="搜索会话" />
        <kbd aria-hidden="true">/</kbd>
      </label>
      <div class="tabs" role="group" aria-label="会话来源">
        <button v-for="item in tabs" :key="item.value" type="button" class="f" :class="{ on: tab === item.value }" :data-count="tabCounts[item.value]" :aria-pressed="tab === item.value" @click="setTab(item.value)">{{ item.label }}</button>
      </div>
      <button id="pathButton" type="button" class="select-button" aria-haspopup="listbox" :aria-expanded="menu?.key === 'path'" @click.stop="openPathMenu">
        <span class="select-label">{{ pathLabel }}</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m2 4 4 4 4-4" /></svg>
      </button>
      <button id="filterToggle" type="button" class="f act filter-toggle" :class="{ on: advanced || activeFilterCount > 0 }" :aria-expanded="advanced" @click="advanced = !advanced">
        筛选<span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
      </button>
      <button id="reload" type="button" class="f act" title="重新扫描 session 数据" @click="load(true)">刷新</button>
      <button id="theme" type="button" class="f act" :title="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme">{{ theme === "dark" ? "☀︎" : "☾" }}</button>
    </div>
    <div v-show="advanced" id="advancedFilters" class="bar2">
      <label>更新</label><input v-model="updatedFrom" type="date" aria-label="更新起始" /> - <input v-model="updatedTo" type="date" aria-label="更新截止" />
      <label>创建</label><input v-model="createdFrom" type="date" aria-label="创建起始" /> - <input v-model="createdTo" type="date" aria-label="创建截止" />
      <label>大小(MB)</label><input v-model="sizeMin" type="number" min="0" step="0.1" placeholder="最小" aria-label="最小 MB" />
      - <input v-model="sizeMax" type="number" min="0" step="0.1" placeholder="最大" aria-label="最大 MB" />
      <label>状态</label><button id="statusFilter" type="button" class="select-button" aria-haspopup="listbox" :aria-expanded="menu?.key === 'status-filter'" @click.stop="openStatusFilter">
        <span class="select-label">{{ status || "全部状态" }}</span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m2 4 4 4 4-4" /></svg>
      </button>
      <button type="button" class="f" @click="clearFilters">清除筛选</button>
    </div>
  </div>

  <main>
    <section v-if="!detail && !detailError && !detailLoading" id="list" aria-label="Session 列表">
      <table>
        <colgroup>
          <col v-for="(className, index) in ['c-star','c-date','c-date','c-tool','c-model','c-name','c-note','c-stat','','c-path','c-size','c-detail','c-archive']" :key="index" :class="className" :style="widths[index] ? { width: `${widths[index]}px` } : undefined" />
        </colgroup>
        <thead><tr>
          <th v-for="(column, index) in [
            { key: 'starred', label: '★', className: 'action-head' }, { key: 'mtime', label: '更新' }, { key: 'birth', label: '创建' },
            { key: 'tool', label: '工具' }, { key: 'model', label: '模型' }, { key: 'name', label: '名称' }, { key: 'star_note', label: '备注' },
            { key: 'status', label: '状态' }, { key: 'first_msg', label: '首条消息' }, { key: 'cwd', label: '路径' }, { key: 'size_kb', label: '大小', className: 'num' },
          ]" :key="column.key" :class="['className' in column ? column.className : '', sortKey === column.key ? (sortAscending ? 's-asc' : 's-desc') : '']" @click="sort(column.key as SortKey)">
            {{ column.label }}<span class="rs" @pointerdown="resize(index, $event)" />
          </th>
          <th title="详情" class="action-head">详情<span class="rs" @pointerdown="resize(11, $event)" /></th>
          <th title="归档" class="action-head">归档</th>
        </tr></thead>
        <tbody>
          <tr v-if="loading"><td colspan="13"><div class="empty">加载中...</div></td></tr>
          <tr v-else-if="!filtered.length"><td colspan="13"><div class="empty">没有匹配的 session，试试更短的关键词或切换筛选</div></td></tr>
          <tr v-for="row in visible" v-else :key="row.id" class="row" :class="{ starred: row.starred, archived: row.archived, pending: pending.has(row.id) }" tabindex="0" @click="copy(row)" @keydown.enter="copy(row)">
            <td class="starcell"><button type="button" class="rowbtn starbtn" :disabled="pending.has(row.id)" :aria-label="row.starred ? '取消标记' : '标记重要'" :title="row.starred ? '取消标记' : '标记重要'" @click.stop="toggleStar(row)">{{ row.starred ? "★" : "☆" }}</button></td>
            <td class="dt" @mouseenter="showTextPreview($event, `${row.id}:mtime`, formatDate(row.mtime))" @mouseleave="schedulePreviewHide">{{ formatDate(row.mtime) }}</td>
            <td class="dt" @mouseenter="showTextPreview($event, `${row.id}:birth`, formatDate(row.birth))" @mouseleave="schedulePreviewHide">{{ formatDate(row.birth) }}</td>
            <td class="tool"><span class="tool-pill" :class="row.tool">{{ row.tool }}</span></td>
            <td class="tool" @mouseenter="showTextPreview($event, `${row.id}:model`, row.model)" @mouseleave="schedulePreviewHide">{{ row.model }}</td>
            <td class="namecell nm" @click.stop="startEdit(row, 'name')" @mouseenter="showTextPreview($event, `${row.id}:name`, row.name)" @mouseleave="schedulePreviewHide">
              <input v-if="editing?.id === row.id && editing.field === 'name'" v-model="editValue" class="cell-input" :data-edit="`${row.id}:name`" aria-label="名称" @click.stop @keydown="editKeydown(row, 'name', $event)" @blur="finishEdit(row, 'name', true)" />
              <template v-else>{{ row.name }}</template>
            </td>
            <td class="notecell" @click.stop="startEdit(row, 'star_note')" @mouseenter="showTextPreview($event, `${row.id}:note`, row.star_note)" @mouseleave="schedulePreviewHide">
              <input v-if="editing?.id === row.id && editing.field === 'star_note'" v-model="editValue" class="cell-input" :data-edit="`${row.id}:star_note`" aria-label="备注" @click.stop @keydown="editKeydown(row, 'star_note', $event)" @blur="finishEdit(row, 'star_note', true)" />
              <template v-else>{{ row.star_note }}</template>
            </td>
            <td><button type="button" class="status statusbtn" aria-haspopup="listbox" :aria-expanded="menu?.key === `status:${row.id}`" :style="{ '--sc': statusMeta[row.status].color }" @click.stop="openRowStatus(row, $event)"><span :class="{ none: !row.status }">{{ statusMeta[row.status].label }}</span></button></td>
            <td class="msg" @mouseenter="showTranscriptPreview(row, $event)" @mouseleave="schedulePreviewHide">{{ row.first_msg || "(空)" }}</td>
            <td class="p" @mouseenter="showTextPreview($event, `${row.id}:path`, shortPath(row.cwd))" @mouseleave="schedulePreviewHide">{{ shortPath(row.cwd) }}</td>
            <td class="num sz">{{ formatSize(row.size_kb) }}</td>
            <td class="detailcell"><button type="button" class="rowbtn detailbtn" title="打开详情页" @click.stop="openDetail(row.id)">查看</button></td>
            <td class="archcell"><button type="button" class="rowbtn archivebtn" :disabled="pending.has(row.id)" :title="row.archived ? '解除归档' : '归档（在“已归档”视图可找回）'" @click.stop="toggleArchive(row)">{{ row.archived ? "恢复" : "归档" }}</button></td>
          </tr>
        </tbody>
      </table>
      <div class="foot">{{ footerText }}</div>
      <nav v-if="pages > 1" class="pager" aria-label="分页">
        <button type="button" class="f act" aria-label="上一页" :disabled="page === 1" @click="changePage(page - 1)">上一页</button>
        <span class="p" aria-live="polite">第 {{ page }} / {{ pages }} 页</span>
        <button type="button" class="f act" aria-label="下一页" :disabled="page === pages" @click="changePage(page + 1)">下一页</button>
      </nav>
    </section>

    <section v-else id="detail" aria-label="Transcript 详情">
      <div v-if="detailLoading" class="empty">加载中...</div>
      <div v-else-if="detailError" class="empty">{{ detailError }} <button type="button" class="f act" @click="showList()">返回</button></div>
      <template v-else-if="detail">
        <div class="detail-top">
          <button type="button" class="f act" @click="showList()">返回</button>
          <button type="button" class="f act" @click="copy(detail)">复制恢复命令</button>
          <div class="detail-title">{{ detail.name || detail.first_msg || detail.id }}</div>
          <div class="detail-meta mono">{{ detail.tool }} · {{ detail.model || "无模型" }} · {{ shortPath(detail.cwd) }} · {{ formatSize(detail.size_kb) }}</div>
        </div>
        <div class="msglist">
          <div v-if="!detail.messages.length" class="empty">没有可展示的 user / assistant 文本消息</div>
          <article v-for="(message, index) in detail.messages" :key="index" class="bubble" :class="message.role">
            <div class="role">{{ message.role }}</div><div class="body markdown" v-html="markdown.render(message.text)" />
          </article>
        </div>
      </template>
    </section>
  </main>

  <div v-if="menu" ref="menuElement" class="menu show" role="listbox" tabindex="-1" :style="menu.style" @click.stop @keydown="menuKeydown">
    <button v-for="item in menu.items" :key="item.value" type="button" class="menu-option" role="option" :aria-selected="item.value === menu.value" @click="chooseMenu(item)"><span>{{ item.label }}</span><span class="check">✓</span></button>
  </div>

  <div v-if="error || notice" id="toast" class="show" :role="error ? 'alert' : 'status'">{{ error || notice }}</div>

  <aside v-if="preview" id="tip" ref="previewElement" class="show" :style="preview.style" @mouseenter="keepPreview" @mouseleave="schedulePreviewHide">
    <template v-if="preview.kind === 'text'">{{ preview.text }}</template>
    <template v-else-if="preview.detail">
      <div class="tiptitle">{{ preview.detail.name || preview.detail.first_msg || preview.detail.id }}</div>
      <div v-if="!preview.detail.messages.length" class="tipmsg">没有可展示的 user / assistant 文本消息</div>
      <div v-for="(message, index) in preview.detail.messages" :key="index" class="tipmsg" :class="message.role">
        <div class="tiprole">{{ message.role }}</div><div class="tiptext markdown" v-html="markdown.render(message.text)" />
      </div>
    </template>
    <template v-else>{{ preview.loading ? "加载对话预览..." : "加载失败" }}</template>
  </aside>
</template>

<style>
/* Python dashboard visual contract, ported without redesign. */
:root{--void:#0c0d12;--carbon:#12141b;--material:rgba(18,20,27,.82);--obsidian:#1b1e27;--graphite:#292d39;--smoke:#3d4251;
  --ash:#73798a;--fog:#9da4b6;--mist:#d2d6e0;--bone:#f2f3f7;--paper:#ffffff;--lime:#8b9cff;
  --hover:rgba(139,156,255,.055);--chip:rgba(255,255,255,.055);
  --input-bg:rgba(255,255,255,.035);--input-line:rgba(255,255,255,.09);
  --star-wash:rgba(139,156,255,.07);--ease-out:cubic-bezier(.23,1,.32,1);color-scheme:dark}
:root[data-theme=light]{--void:#f5f6f8;--carbon:#ffffff;--material:rgba(255,255,255,.82);--obsidian:#eceef3;--graphite:#dde0e7;
  --smoke:#bcc1cd;--ash:#73798a;--fog:#555c6d;--mist:#303442;--bone:#191b22;--paper:#101218;
  --lime:#596de8;--hover:rgba(69,85,190,.045);--chip:rgba(30,35,50,.055);
  --input-bg:#fafbfc;--input-line:rgba(25,30,45,.12);
  --star-wash:rgba(89,109,232,.075);color-scheme:light}
*{box-sizing:border-box}
html{background:var(--void);transition:background-color 180ms ease}
body{background:radial-gradient(900px 460px at 16% -10%,color-mix(in srgb,var(--lime) 9%,transparent),transparent 65%),var(--void);
  color:var(--mist);margin:0;min-height:100vh;
  font:400 13px/1.5 Inter,"Inter Variable",-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  font-feature-settings:"cv01" on,"ss03" on,"zero" on;font-optical-sizing:auto;
  transition:background-color 180ms ease,color 180ms ease}
button,input,select{font:inherit}
.mono{font-family:"Berkeley Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
  font-variant-numeric:tabular-nums;letter-spacing:-.013em}
header{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;
  padding:38px 32px 24px;max-width:1600px;margin:0 auto}
.brand{display:flex;align-items:center;gap:13px}
.mark{display:grid;place-items:center;width:38px;height:38px;border:1px solid color-mix(in srgb,var(--lime) 32%,var(--graphite));
  border-radius:11px;background:color-mix(in srgb,var(--lime) 10%,var(--carbon));color:var(--lime);
  font-size:15px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
h1{font-size:19px;line-height:1.2;font-weight:650;letter-spacing:-.025em;margin:0;color:var(--paper)}
.tagline{margin:3px 0 0;color:var(--ash);font-size:12px;letter-spacing:.005em}
.meta{color:var(--ash);font-size:12px;padding:7px 10px;border:1px solid var(--obsidian);
  border-radius:8px;background:var(--carbon)}
.meta strong{color:var(--paper);font-weight:600;font-variant-numeric:tabular-nums}
.chrome{position:sticky;top:12px;z-index:4;max-width:1536px;margin:0 auto 18px;
  border:1px solid color-mix(in srgb,var(--graphite) 76%,transparent);border-radius:15px;
  background:var(--material);backdrop-filter:blur(24px) saturate(160%);
  box-shadow:0 16px 44px rgba(0,0,0,.14),inset 0 1px 0 rgba(255,255,255,.055)}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px}
.searchbox{position:relative;display:flex;align-items:center;flex:1;min-width:280px}
.searchbox svg{position:absolute;left:11px;width:15px;height:15px;color:var(--ash);pointer-events:none}
.searchbox kbd{position:absolute;right:9px;min-width:20px;padding:1px 5px;border:1px solid var(--graphite);
  border-radius:5px;color:var(--ash);background:var(--carbon);font:500 10px/16px ui-monospace,monospace;text-align:center}
input[type=search]{width:100%;padding:9px 38px 9px 34px;font:inherit;color:var(--mist);
  border:1px solid var(--input-line);border-radius:9px;background:var(--input-bg);outline:none}
input[type=search]::placeholder{color:var(--ash)}
input[type=search]:focus{border-color:color-mix(in srgb,var(--lime) 65%,var(--graphite));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 12%,transparent)}
.tabs{display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--obsidian);border-radius:9px;background:color-mix(in srgb,var(--void) 76%,transparent)}
.f{padding:5px 10px;font:inherit;font-size:12px;border:none;border-radius:7px;
  background:none;color:var(--fog);cursor:pointer;transition:transform 140ms var(--ease-out),background-color 140ms ease,color 140ms ease}
.f.on{background:var(--chip);color:var(--paper);font-weight:560;box-shadow:0 1px 2px rgba(0,0,0,.16)}
.tabs .f::after{content:attr(data-count);margin-left:5px;color:var(--ash);font-size:10px;font-variant-numeric:tabular-nums}
.tabs .f.on::after{color:var(--fog)}
.f:active:not(:disabled){transform:scale(.97)}
.f:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--lime);outline-offset:2px}
.act{border:1px solid var(--graphite);border-radius:8px;background:var(--input-bg)}
.filter-toggle.on{color:var(--paper);border-color:color-mix(in srgb,var(--lime) 40%,var(--graphite));
  background:color-mix(in srgb,var(--lime) 10%,var(--input-bg))}
.filter-count{display:inline-grid;place-items:center;min-width:17px;height:17px;margin-left:5px;padding:0 5px;
  border-radius:999px;background:var(--lime);color:var(--void);font-size:10px;font-weight:700}
main{max-width:1600px;margin:0 auto;padding:0 32px 56px}
#list{overflow-x:auto;border:1px solid var(--obsidian);border-radius:14px;background:var(--carbon);
  box-shadow:0 16px 40px rgba(0,0,0,.08)}
table{width:100%;min-width:1490px;border-collapse:collapse;table-layout:fixed}
col.c-star{width:36px}col.c-date{width:92px}col.c-tool{width:70px}
col.c-name{width:230px}col.c-note{width:120px}col.c-path{width:180px}col.c-size{width:70px}
col.c-detail{width:58px}col.c-archive{width:66px}
.select-button{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;max-width:240px;height:34px;
  padding:0 10px;border:1px solid var(--input-line);border-radius:9px;background:var(--input-bg);
  color:var(--fog);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.select-button .select-label{overflow:hidden;text-overflow:ellipsis}
.select-button svg{width:12px;height:12px;flex:none;transition:transform 140ms var(--ease-out)}
.select-button[aria-expanded=true]{border-color:color-mix(in srgb,var(--lime) 55%,var(--graphite));color:var(--paper)}
.select-button[aria-expanded=true] svg{transform:rotate(180deg)}
.select-button:focus-visible,.status:focus-visible{outline:2px solid var(--lime);outline-offset:2px}
#pathButton{width:240px}
.bar2{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:11px 12px 12px;
  color:var(--ash);font-size:11px;border-top:1px solid color-mix(in srgb,var(--graphite) 70%,transparent)}
.bar2 label{margin-left:10px;text-transform:uppercase;letter-spacing:.04em}
.bar2 input{padding:6px 8px;font:inherit;font-size:12px;color:var(--mist);
  border:1px solid var(--input-line);border-radius:7px;background:var(--input-bg);outline:none}
.bar2 .select-button{height:30px;min-width:112px;border-radius:7px}
.bar2 input[type=number]{width:76px}
.bar2 input:focus{border-color:var(--lime)}
th{text-align:left;height:44px;font-size:10px;font-weight:600;line-height:1;color:var(--ash);position:sticky;top:0;z-index:1;
  padding:0 10px;vertical-align:middle;border-bottom:1px solid var(--graphite);cursor:pointer;user-select:none;white-space:nowrap;
  text-transform:uppercase;letter-spacing:.055em;background:var(--carbon)}
th.s-asc::after{content:" ↑";color:var(--mist)}
th.s-desc::after{content:" ↓";color:var(--mist)}
.rs{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:1}
.rs:hover,.rs.on{border-right:2px solid var(--lime)}
th.num{text-align:right}
th.action-head{text-align:center;padding-left:0;padding-right:0}
td{height:46px;padding:9px 10px;border-bottom:1px solid var(--obsidian);vertical-align:middle;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.num{text-align:right}
tr.row{cursor:pointer}
tr.pending{opacity:.72}
.empty{padding:48px 8px;color:var(--ash);text-align:center}
tr.row.starred td{background:var(--star-wash)}
.dt,.tool,.sz{font-family:"Berkeley Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
  font-size:12px;color:var(--ash);letter-spacing:-.013em}
.tool-pill{display:inline-flex;align-items:center;padding:2px 6px;border-radius:5px;
  background:var(--chip);color:var(--fog);font:600 10px/16px ui-monospace,monospace;letter-spacing:.01em}
.tool-pill.codex{color:#aab5ff;background:rgba(139,156,255,.1)}
.tool-pill.claude{color:#e9a884;background:rgba(222,137,91,.1)}
.tool-pill.pi{color:#76d5b0;background:rgba(77,190,147,.1)}
td.starcell,td.detailcell,td.archcell{text-align:center}
td.starcell{padding-left:3px;padding-right:3px}
.rowbtn{display:inline-grid;place-items:center;min-width:28px;height:28px;padding:0 7px;border:0;border-radius:7px;
  background:transparent;color:var(--ash);font:inherit;font-size:11px;cursor:pointer;
  transition:transform 120ms var(--ease-out),background-color 120ms ease,color 120ms ease}
.rowbtn:active{transform:scale(.94)}
.rowbtn:focus-visible{outline:2px solid var(--lime);outline-offset:1px}
.rowbtn:disabled{cursor:wait}
.starbtn{padding:0;font-size:15px;color:var(--smoke)}
tr.starred .starbtn{color:var(--lime)}
.nm{font-weight:560;color:var(--paper)}
td.notecell{color:var(--mist);font-size:12px;cursor:text}
td.notecell:empty:hover::after{content:"点击添加备注";color:var(--smoke)}
td.namecell{cursor:text}
td.namecell:empty:hover::after{content:"点击命名";color:var(--smoke);font-weight:400}
.cell-input{display:block;width:100%;height:30px;margin:-3px -5px;padding:4px 6px;border:1px solid var(--lime);
  border-radius:6px;background:var(--input-bg);color:var(--paper);font:inherit;outline:none;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 12%,transparent)}
tr.archived td{opacity:.6}
col.c-stat{width:116px}col.c-model{width:120px}
.detail-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:18px;
  border:1px solid var(--obsidian);border-radius:14px;background:var(--carbon)}
.detail-title{font-size:16px;font-weight:620;color:var(--paper);min-width:0;flex:1}
.detail-meta{color:var(--ash);font-size:12px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msglist{display:grid;gap:14px;padding:20px 0 48px;max-width:1040px;margin:0 auto}
.bubble{max-width:88%;border:1px solid var(--obsidian);border-radius:14px 14px 14px 4px;
  padding:13px 15px;background:var(--carbon);box-shadow:0 5px 18px rgba(0,0,0,.06)}
.bubble.user{margin-left:auto;border-radius:14px 14px 4px 14px;
  background:color-mix(in srgb,var(--lime) 10%,var(--carbon));border-color:color-mix(in srgb,var(--lime) 20%,var(--obsidian))}
.role{font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--ash);margin-bottom:7px}
.body{word-break:break-word;color:var(--mist);line-height:1.65}
.status{display:inline-grid;max-width:100%;padding:0;border:0;background:none;font:inherit;vertical-align:middle;cursor:pointer}
.status span{display:inline-flex;align-items:center;gap:6px;min-width:0;height:22px;
  padding:0 7px;border:1px solid color-mix(in srgb,var(--sc) 28%,transparent);
  border-radius:9999px;background:color-mix(in srgb,var(--sc) 9%,transparent);
  color:var(--sc);font-size:11px;font-weight:510;letter-spacing:-.01em;line-height:1;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.status span::before{content:"";width:5px;height:5px;border-radius:9999px;background:var(--sc);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--sc) 9%,transparent)}
.status .none::before{background:var(--smoke)}
.status:hover span,.status:focus-within span{border-color:var(--sc);
  background:color-mix(in srgb,var(--sc) 13%,transparent)}
.menu{position:fixed;z-index:12;min-width:150px;max-width:min(360px,calc(100vw - 24px));max-height:min(360px,calc(100vh - 24px));
  overflow-x:hidden;overflow-y:auto;padding:5px;visibility:hidden;opacity:0;transform:scale(.98);pointer-events:none;
  border:1px solid var(--graphite);border-radius:12px;background:var(--material);backdrop-filter:blur(24px) saturate(160%);
  box-shadow:0 20px 60px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.055);
  transform-origin:top left;transition:opacity 130ms var(--ease-out),transform 130ms var(--ease-out)}
.menu.show{visibility:visible;opacity:1;transform:scale(1);pointer-events:auto}
.menu-option{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:34px;
  padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--mist);font:inherit;font-size:12px;
  text-align:left;white-space:nowrap;cursor:pointer}
.menu-option>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}
.menu-option .check{width:14px;color:var(--lime);opacity:0;text-align:center}
.menu-option[aria-selected=true]{background:var(--chip);color:var(--paper)}
.menu-option[aria-selected=true] .check{opacity:1}
.menu-option:focus-visible{outline:2px solid var(--lime);outline-offset:-2px}
.msg{cursor:pointer;color:var(--fog)}
.p{color:var(--ash);font-size:12px;font-family:"Berkeley Mono",ui-monospace,Consolas,monospace;letter-spacing:-.013em}
.foot{color:var(--ash);font-size:11px;padding:14px 16px}
.pager{display:flex;align-items:center;justify-content:center;gap:8px;padding:0 16px 16px;color:var(--ash)}
.pager button:disabled{opacity:.4;cursor:default}
#tip{position:fixed;max-width:min(820px,calc(100vw - 24px));max-height:70vh;overflow:auto;
  visibility:hidden;opacity:0;transform:scale(.985);pointer-events:none;z-index:5;overscroll-behavior:contain;
  background:var(--material);backdrop-filter:blur(24px) saturate(150%);border:1px solid var(--graphite);color:var(--mist);
  padding:12px 14px;border-radius:11px;font-size:12px;line-height:1.65;
  white-space:pre-wrap;word-break:break-all;box-shadow:0 18px 55px rgba(0,0,0,.36);
  transition:opacity 110ms var(--ease-out),transform 110ms var(--ease-out)}
#tip.show{visibility:visible;opacity:1;transform:scale(1);pointer-events:auto}
.tiptitle{font-weight:600;color:var(--paper);margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tipmsg{padding:9px 11px;margin-top:8px;border:1px solid var(--obsidian);border-radius:10px 10px 10px 3px;
  background:var(--carbon);white-space:normal;word-break:break-word}
.tipmsg.user{margin-left:36px;border-radius:10px 10px 3px 10px;
  border-color:color-mix(in srgb,var(--lime) 22%,var(--obsidian));
  background:color-mix(in srgb,var(--lime) 9%,var(--carbon))}
.tipmsg.assistant{margin-right:36px}
.tiprole{display:inline-flex;align-items:center;padding:2px 6px;border-radius:9999px;font-size:9px;font-weight:700;
  line-height:1;letter-spacing:.07em;text-transform:uppercase;color:var(--fog);background:var(--chip);margin-bottom:6px}
.tipmsg.user .tiprole{color:var(--lime);background:color-mix(in srgb,var(--lime) 12%,transparent)}
.tiptext{color:var(--mist);line-height:1.6}
#toast{position:fixed;bottom:24px;left:50%;transform:translate(-50%,8px);opacity:0;z-index:20;
  background:var(--bone);color:var(--void);padding:8px 14px;border-radius:9px;font-size:12px;font-weight:600;
  box-shadow:0 12px 36px rgba(0,0,0,.3);pointer-events:none;
  transition:opacity 160ms var(--ease-out),transform 160ms var(--ease-out)}
#toast.show{opacity:1;transform:translate(-50%,0)}
.markdown>:first-child{margin-top:0}.markdown>:last-child{margin-bottom:0}
.markdown p{margin:.35em 0}.markdown ul,.markdown ol{margin:.45em 0;padding-left:1.6em}
.markdown a{color:var(--lime)}.markdown img{max-width:100%}
.markdown pre{overflow:auto;padding:10px;border-radius:8px;background:color-mix(in srgb,var(--lime) 7%,var(--void));white-space:pre}
.markdown code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace}
.markdown table{width:auto;min-width:0;table-layout:auto}.markdown th,.markdown td{height:auto;padding:5px 7px;white-space:normal}
@media (hover:hover) and (pointer:fine){
  .f:hover{background:var(--chip);color:var(--paper)}
  th:hover{color:var(--mist)}
  tr.row:hover td{background:var(--hover)}
  .rowbtn:hover{background:var(--chip);color:var(--paper)}
  .menu-option:hover{background:var(--chip);color:var(--paper)}
}
@media (max-width:760px){
  header{padding:24px 16px 18px}.meta{width:100%}.chrome{top:8px;margin:0 12px 14px}
  main{padding:0 12px 36px}.searchbox{min-width:100%}.tabs{order:3;width:100%;overflow-x:auto}
}
@media (prefers-reduced-motion:reduce){html,body,.f,.rowbtn,.select-button svg,.menu,#tip,#toast{transition-duration:0ms}}
@media (prefers-reduced-transparency:reduce){.chrome,.menu,#tip{background:var(--carbon);backdrop-filter:none}}
@media (prefers-contrast:more){.chrome,.menu,#tip,#list,.detail-top,.bubble{border-color:var(--fog)}}
</style>
