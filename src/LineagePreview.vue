<script setup lang="ts">
import { computed, useId } from "vue";
import type { LineageView, SessionView } from "./contracts.ts";
import { layoutLineages, LINEAGE_PREVIEW_LAYOUT } from "./lineageLayout.ts";

type Fold = { kind: "upstream" | "downstream" | "branch"; label: string; count: number };

const props = defineProps<{ view: LineageView; currentId: string; pinned: boolean }>();
const emit = defineEmits<{ select: [id: string]; locate: [] }>();
const markerId = `mini-arrow-${useId().replace(/[^a-z0-9_-]/gi, "")}`;
const sessionTitle = (session: SessionView): string => session.name || session.first_msg || session.id;
const sortSessions = (left: SessionView, right: SessionView): number => left.birth - right.birth || left.id.localeCompare(right.id);

function reachable(start: string, reverse: boolean): Set<string> {
  // ponytail: O(VE) traversal is bounded by one preview component; use adjacency maps if real chains grow beyond the current tens of nodes.
  const found = new Set<string>(), queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of props.view.edges) {
      const next = reverse
        ? edge.downstream_id === current ? edge.upstream_id : ""
        : edge.upstream_id === current ? edge.downstream_id : "";
      if (next && next !== start && !found.has(next)) { found.add(next); queue.push(next); }
    }
  }
  return found;
}

const clipped = computed(() => {
  if (props.view.sessions.length <= 12) return { view: props.view, folds: [] as Fold[] };
  const sessions = new Map(props.view.sessions.map((session) => [session.id, session]));
  const upstream = [...new Set(props.view.edges.filter((edge) => edge.downstream_id === props.currentId).map((edge) => edge.upstream_id))]
    .flatMap((id) => sessions.get(id) ? [sessions.get(id)!] : []).sort(sortSessions).slice(0, 4);
  const downstream = [...new Set(props.view.edges.filter((edge) => edge.upstream_id === props.currentId).map((edge) => edge.downstream_id))]
    .flatMap((id) => sessions.get(id) ? [sessions.get(id)!] : []).sort(sortSessions).slice(0, 4);
  const shown = new Set([props.currentId, ...upstream.map(({ id }) => id), ...downstream.map(({ id }) => id)]);
  const ancestors = reachable(props.currentId, true);
  const descendants = reachable(props.currentId, false);
  for (const id of ancestors) descendants.delete(id);
  const branches = new Set(props.view.sessions.map(({ id }) => id).filter((id) => id !== props.currentId && !ancestors.has(id) && !descendants.has(id)));
  const hidden = (ids: Set<string>) => [...ids].filter((id) => !shown.has(id)).length;
  const counts = { upstream: hidden(ancestors), downstream: hidden(descendants), branch: hidden(branches) };
  const folds = ([
    ["upstream", "上游"], ["downstream", "下游"], ["branch", "旁支"],
  ] as const).flatMap(([kind, label]) => counts[kind] ? [{ kind, label: `⋯ ${label}还有 ${counts[kind]} 个`, count: counts[kind] }] : []);
  return {
    view: {
      sessions: props.view.sessions.filter(({ id }) => shown.has(id)),
      edges: props.view.edges.filter((edge) => shown.has(edge.upstream_id) && shown.has(edge.downstream_id)),
    },
    folds,
  };
});

const chain = computed(() => layoutLineages(clipped.value.view, LINEAGE_PREVIEW_LAYOUT)[0]);
const labels = computed(() => {
  if (!chain.value) return [];
  const nodes = new Map(chain.value.nodes.map((node) => [node.session.id, node]));
  const seen = new Set<string>();
  return chain.value.edges.flatMap((edge) => {
    const from = nodes.get(edge.upstream_id), to = nodes.get(edge.downstream_id);
    if (!from || !to) return [];
    const label = edge.path.split(/[\\/]/).pop() ?? edge.path;
    const key = `${Math.min(from.column, to.column)}:${Math.max(from.column, to.column)}:${label}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ key, label, path: edge.path,
      x: (from.x + LINEAGE_PREVIEW_LAYOUT.nodeWidth + to.x) / 2 - 105,
      y: (from.y + to.y + LINEAGE_PREVIEW_LAYOUT.nodeHeight) / 2 - 14 }];
  });
});

function role(id: string): string {
  const incoming = props.view.edges.some((edge) => edge.downstream_id === id);
  const outgoing = props.view.edges.some((edge) => edge.upstream_id === id);
  return !incoming && !outgoing ? "独立" : incoming ? (outgoing ? "中游" : "下游") : "起点";
}
</script>

<template>
  <div class="mini-head">
    <strong v-if="view.sessions.length > 12">关系链 · {{ view.sessions.length }} Sessions · 仅显示相邻一层</strong>
    <strong v-else>关系链 · {{ view.sessions.length }} Sessions · {{ view.edges.length }} 关系</strong>
    <span v-if="pinned">已固定 · Esc 关闭</span>
  </div>
  <div class="mini-scroll">
    <div v-if="chain" class="mini-canvas" :style="{ width: `${chain.width}px`, height: `${chain.height}px` }">
      <svg :viewBox="`0 0 ${chain.width} ${chain.height}`" aria-hidden="true">
        <defs><marker :id="markerId" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" /></marker></defs>
        <path v-for="edge in chain.edges" :key="`${edge.upstream_id}:${edge.downstream_id}:${edge.path}`" class="mini-edge" :d="edge.d" :marker-end="`url(#${markerId})`"><title>{{ edge.path }}</title></path>
      </svg>
      <span v-for="label in labels" :key="label.key" class="mini-label" :style="{ left: `${label.x}px`, top: `${label.y}px` }" :title="label.path">{{ label.label }}</span>
      <button v-for="node in chain.nodes" :key="node.session.id" type="button" class="lineage-mini-node" :class="{ current: node.session.id === currentId }"
        :style="{ left: `${node.x}px`, top: `${node.y}px` }" :aria-label="`打开 ${sessionTitle(node.session)}`" @click="emit('select', node.session.id)">
        <span class="mini-node-top"><span class="mini-tool" :class="node.session.tool">{{ node.session.tool }}</span><span>{{ role(node.session.id) }}</span></span>
        <strong :title="sessionTitle(node.session)">{{ sessionTitle(node.session) }}</strong><span v-if="node.session.id === currentId" class="current-badge">当前</span>
      </button>
    </div>
    <div v-if="clipped.folds.length" class="mini-folds">
      <button v-for="fold in clipped.folds" :key="fold.kind" type="button" class="mini-fold" :class="fold.kind" :data-count="fold.count" @click="emit('locate')">{{ fold.label }}</button>
    </div>
  </div>
  <div class="mini-foot"><span>{{ pinned ? "Tab 在链内移动 · Esc 关闭" : "悬浮预览 · 点击固定" }}</span><button type="button" @click="emit('locate')">{{ view.sessions.length > 12 ? `查看全部 ${view.sessions.length} 个节点 →` : "在关系图中定位 →" }}</button></div>
</template>

<style scoped>
.mini-head,.mini-foot{display:flex;flex:none;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px}.mini-head{border-bottom:1px solid var(--obsidian)}.mini-head strong{color:var(--paper);font-size:12px}.mini-head span,.mini-foot span{color:var(--ash);font-size:10px}.mini-scroll{min-height:0;max-width:100%;overflow:auto;overscroll-behavior:contain}.mini-canvas{position:relative}.mini-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.mini-edge{fill:none;stroke:var(--smoke);stroke-width:1.25;pointer-events:stroke}.mini-label{position:absolute;z-index:1;display:-webkit-box;overflow:hidden;width:210px;max-height:32px;padding:3px 7px;border:1px solid var(--graphite);border-radius:6px;background:var(--material);color:var(--ash);font:9px/1.35 ui-monospace,monospace;overflow-wrap:anywhere;text-align:center;-webkit-box-orient:vertical;-webkit-line-clamp:2}.lineage-mini-node{position:absolute;z-index:2;width:150px;height:46px;padding:6px 8px;text-align:left;border:1px solid var(--graphite);border-radius:9px;background:var(--material);color:var(--paper);cursor:pointer}.lineage-mini-node:focus-visible,.mini-fold:focus-visible,.mini-foot button:focus-visible{outline:2px solid var(--lime);outline-offset:2px}.lineage-mini-node.current{border-color:var(--lime);box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 11%,transparent),0 7px 20px rgba(0,0,0,.18)}.mini-node-top{display:flex;justify-content:space-between;color:var(--ash);font-size:8px}.mini-tool{font-weight:700;text-transform:uppercase}.mini-tool.codex{color:#aab5ff}.mini-tool.claude{color:#e9a884}.mini-tool.pi{color:#76d5b0}.lineage-mini-node strong{display:block;overflow:hidden;margin-top:3px;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.current-badge{position:absolute;top:-7px;right:-6px;padding:1px 5px;border-radius:999px;background:var(--lime);color:var(--void);font-size:8px;font-weight:750}.mini-folds{display:flex;gap:8px;padding:0 20px 12px}.mini-fold{min-width:150px;height:36px;padding:0 10px;border:1px dashed var(--graphite);border-radius:9px;background:var(--input-bg);color:var(--ash);font-size:10px;cursor:pointer}.mini-foot{border-top:1px solid var(--obsidian)}.mini-foot button{padding:0;border:0;background:none;color:var(--lime);font-size:11px;cursor:pointer}
@media (prefers-reduced-motion:reduce){.lineage-mini-node{transition:border-color 120ms ease,background-color 120ms ease}}
</style>
