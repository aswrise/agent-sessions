<script setup lang="ts">
import { computed, ref } from "vue";
import type { LineageView, SessionView } from "./contracts.ts";
import { layoutLineages, LINEAGE_GRAPH_LAYOUT } from "./lineageLayout.ts";

const props = defineProps<{ view: LineageView; focusId?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
const hovered = ref("");

const chains = computed(() => layoutLineages(props.view, LINEAGE_GRAPH_LAYOUT));

const sessionTitle = (session: SessionView): string => session.name || session.first_msg || session.id;
const pad = (value: number): string => String(value).padStart(2, "0");
function formatBirth(epoch: number): string {
  const date = new Date(epoch * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatDuration(first: number, last: number): string {
  const minutes = Math.max(0, Math.floor((last - first) / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} 小时 ${pad(minutes % 60)} 分钟`;
  return `${Math.floor(minutes / (24 * 60))} 天 ${Math.floor((minutes % (24 * 60)) / 60)} 小时`;
}
function connected(id: string): boolean {
  const file = chains.value.flatMap((chain) => chain.files).find((item) => item.id === hovered.value);
  if (file) return file.upstreamId === id || file.downstreamIds.includes(id);
  return !!hovered.value && (hovered.value === id || props.view.edges.some((edge) =>
    (edge.upstream_id === hovered.value && edge.downstream_id === id) || (edge.downstream_id === hovered.value && edge.upstream_id === id)));
}
</script>

<template>
  <div class="dag-list">
    <section v-for="(chain, chainIndex) in chains" :key="chain.id" class="dag-card" :style="{ '--chain-delay': `${Math.min(chainIndex * 35, 140)}ms` }" :aria-label="`关系链 ${chainIndex + 1}`">
      <div class="dag-card-head">
        <div class="dag-card-meta">链 {{ chainIndex + 1 }} · {{ chain.nodes.length }} Sessions · {{ chain.edges.length }} 关系</div>
        <div class="dag-range">
          <div class="dag-endpoint"><time>{{ formatBirth(chain.first.birth) }}</time><strong :title="sessionTitle(chain.first)">{{ sessionTitle(chain.first) }}</strong></div>
          <span class="dag-duration">→ {{ formatDuration(chain.first.birth, chain.last.birth) }}</span>
          <div class="dag-endpoint"><time>{{ formatBirth(chain.last.birth) }}</time><strong :title="sessionTitle(chain.last)">{{ sessionTitle(chain.last) }}</strong></div>
        </div>
      </div>
      <div class="dag-scroll">
        <div class="dag-canvas" :style="{ width: `${chain.width}px`, height: `${chain.height}px` }">
          <svg :viewBox="`0 0 ${chain.width} ${chain.height}`" aria-hidden="true">
            <defs><marker :id="`dag-open-arrow-${chainIndex}`" viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M .75 .75 L 6 3.5 L .75 6.25" fill="none" stroke="context-stroke" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" /></marker></defs>
            <path v-for="file in chain.files" :key="`source:${file.id}`" class="dag-file-source" :class="{ active: hovered && (file.id === hovered || file.upstreamId === hovered || file.downstreamIds.includes(hovered)), dim: hovered && file.id !== hovered && file.upstreamId !== hovered && !file.downstreamIds.includes(hovered) }" :d="file.sourceD"><title>{{ file.manual ? "手动添加的 Session 关系" : file.path }}</title></path>
            <g v-for="edge in chain.fileEdges" :key="`${edge.upstream_id}:${edge.downstream_id}:${edge.relation === 'manual' ? 'manual' : edge.path}`" class="dag-link" :class="{ active: hovered && (edge.fileId === hovered || edge.upstream_id === hovered || edge.downstream_id === hovered), dim: hovered && edge.fileId !== hovered && edge.upstream_id !== hovered && edge.downstream_id !== hovered }">
              <path :d="edge.d" :marker-end="`url(#dag-open-arrow-${chainIndex})`"><title>{{ edge.relation === "manual" ? "手动添加的 Session 关系" : edge.path }}</title></path>
            </g>
          </svg>
          <button v-for="node in chain.nodes" :key="node.session.id" type="button" class="dag-node" :class="{ focus: node.session.id === focusId, connected: connected(node.session.id) }"
            :style="{ left: `${node.x}px`, top: `${node.y}px` }"
            :aria-label="`打开 ${sessionTitle(node.session)}`" @mouseenter="hovered = node.session.id" @mouseleave="hovered = ''" @focus="hovered = node.session.id" @blur="hovered = ''" @click="emit('select', node.session.id)">
            <span class="dag-node-top"><span class="dag-tool" :class="node.session.tool">{{ node.session.tool }}</span><span class="dag-role">{{ !node.incoming && !node.outgoing ? "独立" : node.incoming ? (node.outgoing ? "中游" : "下游") : "起点" }}</span></span>
            <strong>{{ sessionTitle(node.session) }}</strong>
            <span class="dag-id">{{ node.session.id.slice(0, 13) }}</span>
          </button>
          <div v-for="file in chain.files" :key="file.id" class="dag-file" :class="{ manual: file.manual, connected: hovered && (file.id === hovered || file.upstreamId === hovered || file.downstreamIds.includes(hovered)) }" :style="{ left: `${file.x}px`, top: `${file.y}px` }" :title="file.manual ? '手动添加的 Session 关系' : file.path" @mouseenter="hovered = file.id" @mouseleave="hovered = ''">
            <span class="dag-file-top"><strong>{{ file.manual ? "MANUAL" : "FILE" }}</strong><i>{{ file.downstreamIds.length }} 下游</i></span>
            <span class="dag-file-label">{{ file.label }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dag-list{display:grid;gap:14px}.dag-card{overflow:hidden;border:1px solid var(--obsidian);border-radius:14px;background:var(--carbon);opacity:1;transform:translateY(0);transition:opacity 220ms var(--ease-out),transform 220ms var(--ease-out);transition-delay:var(--chain-delay)}
@starting-style{.dag-card{opacity:0;transform:translateY(8px)}}
.dag-card-head{display:grid;gap:9px;padding:11px 14px;border-bottom:1px solid var(--obsidian);color:var(--ash);font-size:11px}.dag-card-meta{color:var(--mist);font-weight:650;text-transform:uppercase;letter-spacing:.045em}.dag-range{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:14px}.dag-endpoint{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;min-width:0}.dag-endpoint time,.dag-duration{color:var(--ash);font-variant-numeric:tabular-nums}.dag-endpoint strong{overflow:hidden;color:var(--paper);font-size:11px;font-weight:560;text-overflow:ellipsis;white-space:nowrap}.dag-duration{white-space:nowrap}.dag-scroll{overflow:auto}.dag-canvas{position:relative}.dag-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.dag-link,.dag-file-source{color:var(--smoke);opacity:.66;transition:opacity 140ms ease,color 140ms ease}.dag-link.dim,.dag-file-source.dim{opacity:.34}.dag-link.active,.dag-file-source.active{color:var(--lime);opacity:1}.dag-link path,.dag-file-source{fill:none;stroke:currentColor;stroke-width:1.35;pointer-events:stroke}.dag-node{position:absolute;z-index:2;width:220px;height:64px;padding:9px 11px;text-align:left;border:1px solid var(--graphite);border-radius:11px;background:var(--material);color:var(--paper);box-shadow:0 7px 20px rgba(0,0,0,.12),inset 0 1px rgba(255,255,255,.04);cursor:pointer;opacity:1;transform:translateY(0);transition:transform 140ms var(--ease-out),border-color 140ms ease,background-color 140ms ease}.dag-node:active{transform:scale(.98)}.dag-node:focus-visible{outline:2px solid var(--lime);outline-offset:2px}.dag-node.focus{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 8%,var(--material));box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 11%,transparent),0 8px 24px rgba(0,0,0,.16)}.dag-node.connected{border-color:color-mix(in srgb,var(--lime) 34%,var(--graphite))}.dag-node-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}.dag-tool{font:650 9px/15px ui-monospace,monospace;text-transform:uppercase}.dag-tool.codex{color:#aab5ff}.dag-tool.claude{color:#e9a884}.dag-tool.pi{color:#76d5b0}.dag-role{color:var(--ash);font-size:9px}.dag-node strong,.dag-id{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dag-node strong{font-size:12px;font-weight:620}.dag-id{margin-top:3px;color:var(--ash);font:9px ui-monospace,monospace}.dag-file{position:absolute;z-index:2;width:220px;height:48px;padding:6px 9px;border:1px solid color-mix(in srgb,var(--lime) 24%,var(--graphite));border-radius:9px;background:color-mix(in srgb,var(--material) 94%,var(--lime));box-shadow:0 3px 10px rgba(0,0,0,.08);transition:border-color 140ms ease,background-color 140ms ease}.dag-file.manual{border-style:dashed}.dag-file.connected{border-color:color-mix(in srgb,var(--lime) 64%,var(--graphite));background:color-mix(in srgb,var(--material) 90%,var(--lime))}.dag-file-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}.dag-file-top strong{color:var(--lime);font:700 8px ui-monospace,monospace;letter-spacing:.08em}.dag-file-top i{color:var(--ash);font:600 8px ui-monospace,monospace;font-style:normal}.dag-file-label{display:-webkit-box;overflow:hidden;color:var(--mist);font:9.5px/1.25 ui-monospace,monospace;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
@media (hover:hover) and (pointer:fine){.dag-node:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--lime) 48%,var(--graphite))}}
@media (max-width:760px){.dag-range{grid-template-columns:1fr}.dag-duration{padding-left:4px}}
@media (prefers-reduced-motion:reduce){.dag-card{transform:none;transition:opacity 120ms ease}.dag-node{transition:border-color 120ms ease,background-color 120ms ease}.dag-node:hover,.dag-node:active{transform:none}}
</style>
