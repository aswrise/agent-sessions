<script setup lang="ts">
import { computed, ref } from "vue";
import type { LineageEdge, LineageView, SessionView } from "./contracts.ts";

type Node = { session: SessionView; x: number; y: number; order: number; incoming: number; outgoing: number };
type Edge = LineageEdge & { d: string; label: string; x: number; y: number };
type Chain = { id: string; nodes: Node[]; edges: Edge[]; width: number; height: number };

const props = defineProps<{ view: LineageView; focusId?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
const hovered = ref("");

const chains = computed<Chain[]>(() => {
  const sessions = new Map(props.view.sessions.map((session) => [session.id, session]));
  const adjacent = new Map<string, Set<string>>();
  for (const id of sessions.keys()) adjacent.set(id, new Set());
  for (const edge of props.view.edges) {
    adjacent.get(edge.upstream_id)?.add(edge.downstream_id);
    adjacent.get(edge.downstream_id)?.add(edge.upstream_id);
  }
  const groups: string[][] = [], seen = new Set<string>();
  for (const id of sessions.keys()) {
    if (seen.has(id)) continue;
    const group: string[] = [], queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift()!;
      group.push(current);
      for (const next of adjacent.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    groups.push(group);
  }

  return groups.map((ids) => {
    const members = new Set(ids);
    const edges = props.view.edges.filter((edge) => members.has(edge.upstream_id) && members.has(edge.downstream_id));
    const incoming = new Map(ids.map((id) => [id, 0]));
    const outgoing = new Map(ids.map((id) => [id, 0]));
    for (const edge of edges) {
      incoming.set(edge.downstream_id, (incoming.get(edge.downstream_id) ?? 0) + 1);
      outgoing.set(edge.upstream_id, (outgoing.get(edge.upstream_id) ?? 0) + 1);
    }
    const remaining = new Map(incoming), level = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => remaining.get(id) === 0).sort((a, b) => sessions.get(a)!.birth - sessions.get(b)!.birth);
    while (queue.length) {
      const id = queue.shift()!;
      for (const edge of edges.filter((item) => item.upstream_id === id)) {
        level.set(edge.downstream_id, Math.max(level.get(edge.downstream_id) ?? 0, (level.get(id) ?? 0) + 1));
        remaining.set(edge.downstream_id, (remaining.get(edge.downstream_id) ?? 1) - 1);
        if (remaining.get(edge.downstream_id) === 0) queue.push(edge.downstream_id);
      }
    }
    const columns = new Map<number, string[]>();
    for (const id of ids) {
      const column = level.get(id) ?? 0;
      columns.set(column, [...(columns.get(column) ?? []), id]);
    }
    for (const column of columns.values()) column.sort((a, b) => sessions.get(a)!.birth - sessions.get(b)!.birth);
    let order = 0;
    const nodes = [...columns.entries()].flatMap(([column, columnIds]) => columnIds.map((id, row) => ({
      session: sessions.get(id)!, x: 32 + column * 280, y: 36 + row * 96, order: order++,
      incoming: incoming.get(id) ?? 0, outgoing: outgoing.get(id) ?? 0,
    })));
    const positioned = new Map(nodes.map((node) => [node.session.id, node]));
    const graphEdges = edges.map((edge) => {
      const from = positioned.get(edge.upstream_id)!, to = positioned.get(edge.downstream_id)!;
      const x1 = from.x + 220, y1 = from.y + 32, x2 = to.x, y2 = to.y + 32, bend = Math.max(40, (x2 - x1) / 2);
      return { ...edge, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        label: edge.path.split(/[\\/]/).pop() ?? edge.path, x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 7 };
    });
    const maxLevel = Math.max(0, ...level.values()), maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
    return { id: ids.slice().sort().join(":"), nodes, edges: graphEdges, width: Math.max(560, 316 + maxLevel * 280), height: Math.max(150, 72 + maxRows * 96) };
  }).sort((a, b) => b.nodes.length - a.nodes.length || b.edges.length - a.edges.length);
});

function related(id: string): boolean {
  return !hovered.value || hovered.value === id || props.view.edges.some((edge) =>
    (edge.upstream_id === hovered.value && edge.downstream_id === id) || (edge.downstream_id === hovered.value && edge.upstream_id === id));
}
</script>

<template>
  <div class="dag-list">
    <section v-for="(chain, chainIndex) in chains" :key="chain.id" class="dag-card" :style="{ '--chain-delay': `${Math.min(chainIndex * 35, 140)}ms` }" :aria-label="`关系链 ${chainIndex + 1}`">
      <div class="dag-card-head"><span>链 {{ chainIndex + 1 }}</span><span>{{ chain.nodes.length }} Sessions · {{ chain.edges.length }} 关系</span></div>
      <div class="dag-scroll">
        <div class="dag-canvas" :style="{ width: `${chain.width}px`, height: `${chain.height}px` }">
          <svg :viewBox="`0 0 ${chain.width} ${chain.height}`" aria-hidden="true">
            <defs><marker :id="`dag-arrow-${chainIndex}`" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 Z" fill="context-stroke" /></marker></defs>
            <g v-for="edge in chain.edges" :key="`${edge.upstream_id}:${edge.downstream_id}:${edge.path}`" class="dag-link" :class="{ active: hovered && (edge.upstream_id === hovered || edge.downstream_id === hovered), dim: hovered && edge.upstream_id !== hovered && edge.downstream_id !== hovered }">
              <path :d="edge.d" :marker-end="`url(#dag-arrow-${chainIndex})`"><title>{{ edge.path }}</title></path>
              <text :x="edge.x" :y="edge.y" text-anchor="middle">{{ edge.label }}</text>
            </g>
          </svg>
          <button v-for="node in chain.nodes" :key="node.session.id" type="button" class="dag-node" :class="{ focus: node.session.id === focusId, dim: !related(node.session.id) }"
            :style="{ left: `${node.x}px`, top: `${node.y}px`, '--node-delay': `${Math.min(node.order * 25, 125)}ms` }"
            :aria-label="`打开 ${node.session.name || node.session.first_msg || node.session.id}`" @mouseenter="hovered = node.session.id" @mouseleave="hovered = ''" @focus="hovered = node.session.id" @blur="hovered = ''" @click="emit('select', node.session.id)">
            <span class="dag-node-top"><span class="dag-tool" :class="node.session.tool">{{ node.session.tool }}</span><span class="dag-role">{{ !node.incoming && !node.outgoing ? "独立" : node.incoming ? (node.outgoing ? "中游" : "下游") : "起点" }}</span></span>
            <strong>{{ node.session.name || node.session.first_msg || node.session.id }}</strong>
            <span class="dag-id">{{ node.session.id.slice(0, 13) }}</span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dag-list{display:grid;gap:14px}.dag-card{overflow:hidden;border:1px solid var(--obsidian);border-radius:14px;background:var(--carbon);opacity:1;transform:translateY(0);transition:opacity 220ms var(--ease-out),transform 220ms var(--ease-out);transition-delay:var(--chain-delay)}
@starting-style{.dag-card{opacity:0;transform:translateY(8px)}}
.dag-card-head{display:flex;justify-content:space-between;gap:16px;padding:11px 14px;border-bottom:1px solid var(--obsidian);color:var(--ash);font-size:11px;text-transform:uppercase;letter-spacing:.045em}.dag-card-head span:first-child{color:var(--mist);font-weight:650}.dag-scroll{overflow:auto}.dag-canvas{position:relative;min-width:100%}.dag-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.dag-link{color:var(--smoke);opacity:.66;transition:opacity 140ms ease,color 140ms ease}.dag-link.dim{opacity:.14}.dag-link.active{color:var(--lime);opacity:1}.dag-link path{fill:none;stroke:currentColor;stroke-width:1.35}.dag-link text{fill:var(--ash);font:10px "Berkeley Mono",ui-monospace,monospace;paint-order:stroke;stroke:var(--carbon);stroke-width:5px;stroke-linejoin:round}.dag-node{position:absolute;width:220px;height:64px;padding:9px 11px;text-align:left;border:1px solid var(--graphite);border-radius:11px;background:var(--material);color:var(--paper);box-shadow:0 7px 20px rgba(0,0,0,.12),inset 0 1px rgba(255,255,255,.04);cursor:pointer;opacity:1;transform:translateY(0);animation:dag-node-in 220ms var(--ease-out) both;animation-delay:var(--node-delay);transition:transform 140ms var(--ease-out),opacity 140ms ease,border-color 140ms ease,background-color 140ms ease}.dag-node:active{transform:scale(.98)}.dag-node:focus-visible{outline:2px solid var(--lime);outline-offset:2px}.dag-node.focus{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 8%,var(--material));box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 11%,transparent),0 8px 24px rgba(0,0,0,.16)}.dag-node.dim{opacity:.32}.dag-node-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}.dag-tool{font:650 9px/15px ui-monospace,monospace;text-transform:uppercase}.dag-tool.codex{color:#aab5ff}.dag-tool.claude{color:#e9a884}.dag-tool.pi{color:#76d5b0}.dag-role{color:var(--ash);font-size:9px}.dag-node strong,.dag-id{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dag-node strong{font-size:12px;font-weight:620}.dag-id{margin-top:3px;color:var(--ash);font:9px ui-monospace,monospace}
@keyframes dag-node-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
@media (hover:hover) and (pointer:fine){.dag-node:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--lime) 48%,var(--graphite))}}
@media (prefers-reduced-motion:reduce){.dag-card{transition:opacity 120ms ease;transform:none}.dag-node{animation:none;transition:opacity 120ms ease,border-color 120ms ease}.dag-node:hover{transform:none}}
</style>
