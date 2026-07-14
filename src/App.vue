<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { STATUSES, type SessionStatus, type SessionsEnvelope, type SessionView, type Tool, type TranscriptView } from "./contracts.ts";

type Tab = "" | Tool | "starred" | "archived";
type SortKey = keyof Pick<SessionView, "mtime" | "birth" | "tool" | "model" | "name" | "status" | "first_msg" | "cwd" | "size_kb">;

const rows = ref<SessionView[]>([]);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const tab = ref<Tab>("");
const keyword = ref("");
const path = ref("");
const status = ref<SessionStatus>("");
const updatedFrom = ref(""), updatedTo = ref(""), createdFrom = ref(""), createdTo = ref("");
const sizeMin = ref(""), sizeMax = ref("");
const advanced = ref(false);
const sortKey = ref<SortKey>("mtime"), sortAscending = ref(false);
const page = ref(1);
const pending = ref(new Set<string>());
const detail = ref<TranscriptView>();
const detailError = ref("");
const preview = ref<TranscriptView>();
const previewPosition = ref({ left: 0, top: 0 });
const previewCache = new Map<string, TranscriptView>();
let previewTimer: ReturnType<typeof setTimeout> | undefined;
const widths = ref<number[]>(JSON.parse(localStorage.getItem("column-widths") || "[]"));
const dark = ref(localStorage.getItem("theme") === "dark");

const tabs: { value: Tab; label: string }[] = [
  { value: "", label: "全部" }, { value: "claude", label: "Claude" }, { value: "codex", label: "Codex" },
  { value: "pi", label: "pi" }, { value: "starred", label: "已标记" }, { value: "archived", label: "已归档" },
];
const paths = computed(() => [...new Set(rows.value.map((row) => row.cwd))].sort());
const pathCount = (value: string) => rows.value.filter((row) => row.cwd === value).length;
const toEpoch = (value: string, end = false) => value ? new Date(`${value}T${end ? "23:59:59" : "00:00:00"}`).getTime() / 1000 : undefined;

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase(), fromUpdate = toEpoch(updatedFrom.value), toUpdate = toEpoch(updatedTo.value, true);
  const fromCreate = toEpoch(createdFrom.value), toCreate = toEpoch(createdTo.value, true);
  const min = Number.parseFloat(sizeMin.value), max = Number.parseFloat(sizeMax.value);
  const result = rows.value.filter((row) => {
    if (tab.value === "archived" ? !row.archived : row.archived) return false;
    if (["claude", "codex", "pi"].includes(tab.value) && row.tool !== tab.value) return false;
    if (tab.value === "starred" && !row.starred) return false;
    if (path.value && row.cwd !== path.value) return false;
    if (status.value && row.status !== status.value) return false;
    if (fromUpdate && row.mtime < fromUpdate || toUpdate && row.mtime > toUpdate) return false;
    if (fromCreate && row.birth < fromCreate || toCreate && row.birth > toCreate) return false;
    if (!Number.isNaN(min) && row.size_kb < min * 1024 || !Number.isNaN(max) && row.size_kb > max * 1024) return false;
    return !query || [row.name, row.first_msg, row.cwd, row.model, row.star_note, row.tool].some((value) => value.toLowerCase().includes(query));
  });
  return result.sort((left, right) => {
    const a = left[sortKey.value], b = right[sortKey.value];
    const order = a < b ? -1 : a > b ? 1 : 0;
    return order * (sortAscending.value ? 1 : -1);
  });
});
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 100)));
const visible = computed(() => filtered.value.slice((Math.min(page.value, pages.value) - 1) * 100, Math.min(page.value, pages.value) * 100));

async function load(fresh = false) {
  loading.value = true; error.value = "";
  try {
    const response = await fetch(`/api/sessions${fresh ? "?fresh=1" : ""}`);
    if (!response.ok) throw new Error("加载失败");
    rows.value = ((await response.json()) as SessionsEnvelope).sessions;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "加载失败"; }
  finally { loading.value = false; }
}

async function mutate(row: SessionView, route: "/star" | "/rename", body: Record<string, unknown>, apply: () => void, input?: HTMLInputElement) {
  pending.value = new Set(pending.value).add(row.id); error.value = "";
  try {
    const response = await fetch(route, { method: "POST", body: JSON.stringify({ id: row.id, ...body }) });
    if (!response.ok) throw new Error("保存失败");
    apply(); notice.value = "已保存";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存失败";
    if (input) input.value = input.defaultValue;
  } finally {
    const next = new Set(pending.value); next.delete(row.id); pending.value = next;
  }
}

function edit(row: SessionView, field: "name" | "star_note", event: Event) {
  const input = event.target as HTMLInputElement, value = input.value.trim();
  if (field === "name" && !value) { input.value = row.name; error.value = "名称不能为空"; return; }
  const route = field === "name" ? "/rename" : "/star";
  const body = field === "name" ? { name: value } : { note: value };
  mutate(row, route, body, () => { row[field] = value; input.defaultValue = value; }, input);
}
function changeStatus(row: SessionView, event: Event) {
  const value = (event.target as HTMLSelectElement).value as SessionStatus;
  mutate(row, "/star", { status: value }, () => { row.status = value; });
}

const setTab = (value: Tab) => { tab.value = value; page.value = 1; };
const sort = (key: SortKey) => {
  sortAscending.value = sortKey.value === key ? !sortAscending.value : false;
  sortKey.value = key; page.value = 1;
};
const copy = async (row: SessionView | TranscriptView) => { await navigator.clipboard.writeText(row.resume_command); notice.value = "已复制恢复命令"; };

async function fetchDetail(id: string): Promise<TranscriptView> {
  const cached = previewCache.get(id); if (cached) return cached;
  const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error("加载失败");
  const value = await response.json() as TranscriptView; previewCache.set(id, value); return value;
}

async function openDetail(id: string, push = true) {
  detail.value = undefined; detailError.value = "";
  if (push) history.pushState(null, "", `/?session=${encodeURIComponent(id)}`);
  try { detail.value = await fetchDetail(id); } catch { detailError.value = "对话加载失败"; }
}
function showList(push = true) { detail.value = undefined; detailError.value = ""; if (push) history.pushState(null, "", "/"); }
function syncHistory() { const id = new URLSearchParams(location.search).get("session"); if (id) openDetail(id, false); else showList(false); }

function showPreview(row: SessionView, event: MouseEvent) {
  clearTimeout(previewTimer);
  const cell = event.currentTarget as HTMLElement, box = cell.getBoundingClientRect();
  previewPosition.value = { left: Math.max(12, Math.min(box.left, innerWidth - 620)), top: Math.min(innerHeight - 120, box.bottom - 4) };
  previewTimer = setTimeout(async () => { try { preview.value = await fetchDetail(row.id); } catch { error.value = "预览加载失败"; } }, 180);
}
function hidePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(() => { preview.value = undefined; }, 100); }
function keepPreview() { clearTimeout(previewTimer); }

function resize(index: number, event: PointerEvent) {
  event.preventDefault();
  const start = event.clientX, initial = widths.value[index] || (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().width;
  const move = (next: PointerEvent) => { const values = [...widths.value]; values[index] = Math.max(48, initial + next.clientX - start); widths.value = values; };
  const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); localStorage.setItem("column-widths", JSON.stringify(widths.value)); };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}

function keydown(event: KeyboardEvent) {
  const editing = ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement).tagName);
  if (event.key === "/" && !editing) { event.preventDefault(); document.querySelector<HTMLInputElement>("#keyword")?.focus(); }
  if (event.key === "Escape" && detail.value) showList();
}

onMounted(async () => {
  document.documentElement.dataset.theme = dark.value ? "dark" : "light";
  addEventListener("popstate", syncHistory); addEventListener("keydown", keydown);
  await load(); await nextTick(); syncHistory();
});
onBeforeUnmount(() => { removeEventListener("popstate", syncHistory); removeEventListener("keydown", keydown); });
function toggleTheme() { dark.value = !dark.value; const value = dark.value ? "dark" : "light"; document.documentElement.dataset.theme = value; localStorage.setItem("theme", value); }
</script>

<template>
  <main>
    <header>
      <div><p class="eyebrow">LOCAL CONVERSATION INDEX</p><h1>Agent Sessions</h1></div>
      <div class="header-actions"><button type="button" @click="load(true)">刷新</button><button type="button" :aria-label="dark ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme">{{ dark ? '☀︎' : '☾' }}</button></div>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>

    <section v-if="!detail && !detailError" aria-label="Session 列表">
      <nav class="tabs" aria-label="Session 类型">
        <button v-for="item in tabs" :key="item.value" type="button" :aria-pressed="tab === item.value" @click="setTab(item.value)">{{ item.label }}</button>
      </nav>
      <div class="filters">
        <input id="keyword" v-model="keyword" type="search" placeholder="搜索名称、消息、路径" aria-label="关键词" @input="page = 1" />
        <select v-model="path" aria-label="路径" @change="page = 1"><option value="">全部路径</option><option v-for="item in paths" :key="item" :value="item">{{ item }} ({{ pathCount(item) }})</option></select>
        <button type="button" :aria-expanded="advanced" aria-controls="advanced" @click="advanced = !advanced">高级筛选</button>
      </div>
      <div id="advanced" v-show="advanced" class="advanced">
        <label>更新起始 <input v-model="updatedFrom" type="date" /></label><label>更新截止 <input v-model="updatedTo" type="date" /></label>
        <label>创建起始 <input v-model="createdFrom" type="date" /></label><label>创建截止 <input v-model="createdTo" type="date" /></label>
        <label>最小 MB <input v-model="sizeMin" type="number" min="0" /></label><label>最大 MB <input v-model="sizeMax" type="number" min="0" /></label>
        <label>状态 <select v-model="status"><option v-for="item in STATUSES" :key="item" :value="item">{{ item || '全部状态' }}</option></select></label>
      </div>
      <p v-if="loading" class="empty">加载中…</p><p v-else-if="!filtered.length" class="empty">没有匹配的 Session</p>
      <div v-else class="table-wrap"><table><colgroup><col v-for="(_, index) in 12" :key="index" :style="widths[index] ? { width: widths[index] + 'px' } : undefined" /></colgroup>
        <thead><tr>
          <th>标记<span class="resize" @pointerdown="resize(0, $event)" /></th><th><button @click="sort('mtime')">更新</button><span class="resize" @pointerdown="resize(1, $event)" /></th>
          <th><button @click="sort('birth')">创建</button><span class="resize" @pointerdown="resize(2, $event)" /></th><th><button @click="sort('tool')">工具</button></th>
          <th><button @click="sort('model')">模型</button></th><th><button @click="sort('name')">名称</button></th><th>备注</th><th><button @click="sort('status')">状态</button></th>
          <th><button @click="sort('first_msg')">首条消息</button></th><th><button @click="sort('cwd')">路径</button></th><th><button @click="sort('size_kb')">大小</button></th><th>操作</th>
        </tr></thead><tbody>
          <tr v-for="row in visible" :key="row.id" tabindex="0" @click="copy(row)" @keydown.enter="copy(row)">
            <td><button type="button" :disabled="pending.has(row.id)" :aria-label="row.starred ? '取消标记' : '标记重要'" @click.stop="mutate(row, '/star', { star: !row.starred }, () => row.starred = !row.starred)">{{ row.starred ? '★' : '☆' }}</button></td>
            <td :title="new Date(row.mtime * 1000).toLocaleString()">{{ new Date(row.mtime * 1000).toLocaleDateString() }}</td><td>{{ new Date(row.birth * 1000).toLocaleDateString() }}</td><td>{{ row.tool }}</td><td :title="row.model">{{ row.model }}</td>
            <td><input :value="row.name" :disabled="pending.has(row.id)" aria-label="名称" @click.stop @change="edit(row, 'name', $event)" /></td>
            <td><input :value="row.star_note" :disabled="pending.has(row.id)" aria-label="备注" @click.stop @change="edit(row, 'star_note', $event)" /></td>
            <td><select :value="row.status" :disabled="pending.has(row.id)" aria-label="状态" @click.stop @change.stop="changeStatus(row, $event)"><option v-for="item in STATUSES" :key="item" :value="item">{{ item || '无' }}</option></select></td>
            <td class="truncate" :title="row.first_msg" @mouseenter="showPreview(row, $event)" @mouseleave="hidePreview">{{ row.first_msg || '(空)' }}</td><td class="truncate" :title="row.cwd">{{ row.cwd }}</td><td>{{ row.size_kb }}K</td>
            <td class="actions"><button type="button" @click.stop="openDetail(row.id)">查看</button><button type="button" :disabled="pending.has(row.id)" @click.stop="mutate(row, '/star', { archive: !row.archived }, () => row.archived = !row.archived)">{{ row.archived ? '恢复' : '归档' }}</button></td>
          </tr>
        </tbody></table></div>
      <footer v-if="filtered.length"><span>{{ filtered.length }} 个匹配</span><div v-if="pages > 1"><button :disabled="page <= 1" @click="page--">上一页</button><span>第 {{ page }} / {{ pages }} 页</span><button :disabled="page >= pages" @click="page++">下一页</button></div></footer>
    </section>

    <section v-else class="detail" aria-label="Transcript 详情">
      <button type="button" @click="showList()">返回</button><p v-if="detailError" role="alert">{{ detailError }}</p>
      <template v-if="detail"><button type="button" @click="copy(detail)">复制恢复命令</button><h2>{{ detail.name || detail.first_msg || detail.id }}</h2><p class="meta">{{ detail.tool }} · {{ detail.model || '无模型' }} · {{ detail.cwd }}</p>
        <article v-for="(message, index) in detail.messages" :key="index" :class="['bubble', message.role]"><strong>{{ message.role }}</strong><pre>{{ message.text }}</pre></article>
      </template>
    </section>

    <aside v-if="preview" class="preview" :style="previewPosition" @mouseenter="keepPreview" @mouseleave="hidePreview"><strong>{{ preview.name || preview.id }}</strong><article v-for="(message, index) in preview.messages" :key="index" :class="message.role"><b>{{ message.role }}</b><p>{{ message.text }}</p></article></aside>
  </main>
</template>

<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#20201e;background:#f5f4f0;color-scheme:light;--panel:#fffffff0;--line:#d9d7d0;--muted:#73716b;--accent:#315c53;--danger:#a13f35} :root[data-theme=dark]{color:#eeeae1;background:#171817;color-scheme:dark;--panel:#222422f2;--line:#3a3d39;--muted:#aaa89f;--accent:#9ac8bb;--danger:#f0a69d} *{box-sizing:border-box} body{margin:0} button,input,select{font:inherit} button{cursor:pointer} main{max-width:1600px;margin:auto;padding:26px} header,.filters,footer,.header-actions,.tabs,.actions{display:flex;align-items:center;gap:8px} header{justify-content:space-between} h1{margin:0;font-size:30px;letter-spacing:-.04em}.eyebrow{color:var(--muted);font-size:11px;letter-spacing:.12em}.tabs{margin:22px 0 12px;flex-wrap:wrap}.tabs button[aria-pressed=true]{color:var(--panel);background:var(--accent)} button,input,select{border:1px solid var(--line);background:var(--panel);color:inherit;border-radius:8px;padding:7px 10px}.filters input[type=search]{flex:1;min-width:220px}.advanced{display:flex;flex-wrap:wrap;gap:10px;padding:12px 0}.advanced label{display:grid;gap:4px;color:var(--muted);font-size:12px}.error,.notice{position:sticky;top:8px;z-index:5;padding:10px 12px;border-radius:8px;background:var(--panel);border:1px solid}.error{color:var(--danger)}.notice{color:var(--accent)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel)}table{width:100%;border-collapse:collapse;table-layout:fixed;min-width:1240px}th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}th{position:relative;color:var(--muted);font-size:12px}th button{border:0;padding:0;background:none;color:inherit}.resize{position:absolute;right:-3px;top:0;width:8px;height:100%;cursor:col-resize}tbody tr{cursor:copy}tbody tr:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}td input,td select{width:100%;border-color:transparent;background:transparent;padding:3px}.truncate{overflow:hidden;text-overflow:ellipsis}footer{justify-content:space-between;padding:12px}.empty{text-align:center;color:var(--muted);padding:50px}.detail{max-width:900px;margin:30px auto}.detail h2{font-size:28px}.meta{color:var(--muted)}.bubble{margin:14px 0;padding:16px;border-radius:14px;background:var(--panel);border:1px solid var(--line)}.bubble.user{margin-left:12%}.bubble.assistant{margin-right:12%}.bubble pre{white-space:pre-wrap;font:inherit;line-height:1.55}.preview{position:fixed;z-index:10;width:min(600px,calc(100vw - 24px));max-height:60vh;overflow:auto;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 18px 50px #0003;overscroll-behavior:contain}.preview article{padding:8px;border-radius:8px;margin-top:8px}.preview .user{background:color-mix(in srgb,var(--accent) 12%,transparent)}.preview p{white-space:pre-wrap;margin:4px 0}.actions button{padding:4px 7px}@media(max-width:700px){main{padding:14px}.filters{align-items:stretch;flex-direction:column}.advanced{display:grid;grid-template-columns:1fr 1fr}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}@media(prefers-reduced-transparency:reduce){:root{--panel:#fff}:root[data-theme=dark]{--panel:#222}}@media(prefers-contrast:more){button,input,select,.table-wrap{border-width:2px}}
</style>
