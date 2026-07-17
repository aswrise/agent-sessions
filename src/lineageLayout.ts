import type { LineageEdge, LineageView, SessionView } from "./contracts.ts";

export type LineageLayoutOptions = {
  nodeWidth: number;
  nodeHeight: number;
  columnStep: number;
  rowStep: number;
  x: number;
  y: number;
  minWidth: number;
  minHeight: number;
  widthBase: number;
  heightBase: number;
  fileWidth?: number;
  fileHeight?: number;
  fileGap?: number;
};
export type LineageLayoutNode = {
  session: SessionView;
  x: number;
  y: number;
  column: number;
  incoming: number;
  outgoing: number;
};
export type LineageLayoutEdge = LineageEdge & { d: string };
export type LineageLayoutFile = {
  id: string;
  path: string;
  label: string;
  manual: boolean;
  upstreamId: string;
  downstreamIds: string[];
  x: number;
  y: number;
  sourceD: string;
};
export type LineageLayoutFileEdge = LineageEdge & { d: string; fileId: string };
export type LineageLayoutChain = {
  id: string;
  nodes: LineageLayoutNode[];
  edges: LineageLayoutEdge[];
  files: LineageLayoutFile[];
  fileEdges: LineageLayoutFileEdge[];
  width: number;
  height: number;
  first: SessionView;
  last: SessionView;
};

export const LINEAGE_GRAPH_LAYOUT: LineageLayoutOptions = {
  nodeWidth: 220, nodeHeight: 64, columnStep: 522, rowStep: 96,
  x: 32, y: 36, minWidth: 560, minHeight: 150, widthBase: 316, heightBase: 72,
  fileWidth: 220, fileHeight: 48, fileGap: 20,
};
export const LINEAGE_PREVIEW_LAYOUT: LineageLayoutOptions = {
  nodeWidth: 150, nodeHeight: 46, columnStep: 400, rowStep: 68,
  x: 20, y: 20, minWidth: 190, minHeight: 86, widthBase: 190, heightBase: 40,
};

const byBirth = (sessions: Map<string, SessionView>) => (a: string, b: string): number =>
  sessions.get(a)!.birth - sessions.get(b)!.birth || a.localeCompare(b);
const edgeLabel = (edge: LineageEdge): string => edge.relation === "manual" ? "手动关联" : edge.path.split(/[\\/]/).pop() ?? edge.path;
const edgePath = (edge: LineageEdge): string => edge.relation === "manual" ? "" : edge.path;

function spread(index: number, count: number, radius: number): number {
  return count < 2 ? 0 : -radius + index * radius * 2 / (count - 1);
}

export function connectedComponents(ids: Iterable<string>, edges: LineageEdge[]): string[][] {
  const adjacent = new Map<string, Set<string>>();
  for (const id of ids) adjacent.set(id, new Set());
  for (const edge of edges) {
    adjacent.get(edge.upstream_id)?.add(edge.downstream_id);
    adjacent.get(edge.downstream_id)?.add(edge.upstream_id);
  }
  const groups: string[][] = [], seen = new Set<string>();
  for (const id of adjacent.keys()) {
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
  return groups;
}

export function lineageComponents(view: LineageView): LineageView[] {
  const sessions = new Map(view.sessions.map((session) => [session.id, session]));
  return connectedComponents(sessions.keys(), view.edges).map((ids) => {
    const members = new Set(ids);
    return {
      sessions: ids.flatMap((id) => sessions.get(id) ? [sessions.get(id)!] : []),
      edges: view.edges.filter((edge) => members.has(edge.upstream_id) && members.has(edge.downstream_id)),
    };
  });
}

export function layoutLineages(view: LineageView, options: LineageLayoutOptions): LineageLayoutChain[] {
  const sessions = new Map(view.sessions.map((session) => [session.id, session]));
  return connectedComponents(sessions.keys(), view.edges).map((ids) => {
    const members = new Set(ids);
    const edges = view.edges.filter((edge) => members.has(edge.upstream_id) && members.has(edge.downstream_id));
    const incoming = new Map(ids.map((id) => [id, 0]));
    const outgoing = new Map(ids.map((id) => [id, 0]));
    for (const edge of edges) {
      incoming.set(edge.downstream_id, (incoming.get(edge.downstream_id) ?? 0) + 1);
      outgoing.set(edge.upstream_id, (outgoing.get(edge.upstream_id) ?? 0) + 1);
    }
    const remaining = new Map(incoming), level = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => remaining.get(id) === 0).sort(byBirth(sessions));
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
    for (const column of columns.values()) column.sort(byBirth(sessions));
    const nodes = [...columns.entries()].flatMap(([column, columnIds]) => columnIds.map((id, row) => ({
      session: sessions.get(id)!, x: options.x + column * options.columnStep, y: options.y + row * options.rowStep, column,
      incoming: incoming.get(id) ?? 0, outgoing: outgoing.get(id) ?? 0,
    })));
    const positioned = new Map(nodes.map((node) => [node.session.id, node]));
    const graphEdges = edges.map((edge) => {
      const from = positioned.get(edge.upstream_id)!, to = positioned.get(edge.downstream_id)!;
      const x1 = from.x + options.nodeWidth, y1 = from.y + options.nodeHeight / 2;
      const x2 = to.x, y2 = to.y + options.nodeHeight / 2, bend = Math.max(40, (x2 - x1) / 2);
      return {
        ...edge,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      };
    });
    const files: LineageLayoutFile[] = [], fileEdges: LineageLayoutFileEdge[] = [];
    let maxFileRows = 0, maxFileBottom = 0;
    if (options.fileWidth && options.fileHeight && options.fileGap !== undefined) {
      const grouped = new Map<string, LineageEdge[]>();
      for (const edge of edges) {
        const key = `${edge.upstream_id}\0${edge.relation === "manual" ? "manual" : edge.path}`;
        grouped.set(key, [...(grouped.get(key) ?? []), edge]);
      }
      const byColumn = new Map<number, [string, LineageEdge[]][]>();
      for (const entry of grouped) {
        const column = positioned.get(entry[1][0]!.upstream_id)!.column;
        byColumn.set(column, [...(byColumn.get(column) ?? []), entry]);
      }
      const targetEdges = new Map<string, LineageEdge[]>();
      for (const edge of edges) targetEdges.set(edge.downstream_id, [...(targetEdges.get(edge.downstream_id) ?? []), edge]);
      for (const groups of byColumn.values()) groups.sort(([, left], [, right]) =>
        positioned.get(left[0]!.upstream_id)!.y - positioned.get(right[0]!.upstream_id)!.y || edgeLabel(left[0]!).localeCompare(edgeLabel(right[0]!)));
      maxFileRows = Math.max(0, ...[...byColumn.values()].map((column) => column.length));
      for (const groups of byColumn.values()) {
        const occupied: number[] = [];
        groups.forEach(([id, group]) => {
          const first = group[0]!, from = positioned.get(first.upstream_id)!;
          const x = from.x + options.nodeWidth + options.fileGap!;
          const targets = group.map((edge) => positioned.get(edge.downstream_id)!);
          const targetCenter = (Math.min(...targets.map((target) => target.y)) + Math.max(...targets.map((target) => target.y)) + options.nodeHeight) / 2;
          const idealY = (from.y + options.nodeHeight / 2 + targetCenter) / 2 - options.fileHeight! / 2;
          let y = idealY;
          for (const placedY of occupied.sort((left, right) => left - right))
            if (y < placedY + options.fileHeight! + 12 && y + options.fileHeight! + 12 > placedY) y = placedY + options.fileHeight! + 12;
          occupied.push(y);
          maxFileBottom = Math.max(maxFileBottom, y + options.fileHeight!);
          const siblings = groups.filter(([, edges]) => edges[0]!.upstream_id === first.upstream_id);
          const sourceIndex = siblings.findIndex(([key]) => key === id);
          const sourceY = from.y + options.nodeHeight / 2 + spread(sourceIndex, siblings.length, 16);
          const sourceBend = Math.max(10, (x - from.x - options.nodeWidth) / 2);
          files.push({
            id, path: edgePath(first), label: edgeLabel(first), manual: first.relation === "manual",
            upstreamId: first.upstream_id, downstreamIds: group.map((edge) => edge.downstream_id), x, y,
            sourceD: `M ${from.x + options.nodeWidth} ${sourceY} C ${from.x + options.nodeWidth + sourceBend} ${sourceY}, ${x - sourceBend} ${y + options.fileHeight! / 2}, ${x} ${y + options.fileHeight! / 2}`,
          });
          const sorted = group.slice().sort((left, right) => positioned.get(left.downstream_id)!.y - positioned.get(right.downstream_id)!.y);
          sorted.forEach((edge, index) => {
            const to = positioned.get(edge.downstream_id)!, incomingEdges = targetEdges.get(edge.downstream_id)!;
            const targetIndex = incomingEdges.findIndex((item) => item === edge);
            const x1 = x + options.fileWidth!, y1 = y + options.fileHeight! / 2 + spread(index, sorted.length, 12);
            const x2 = to.x - 8, y2 = to.y + options.nodeHeight / 2 + spread(targetIndex, incomingEdges.length, 18);
            const bend = Math.max(24, (x2 - x1) / 2);
            fileEdges.push({ ...edge, fileId: id, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` });
          });
        });
      }
    }
    const maxLevel = Math.max(0, ...level.values());
    const maxRows = Math.max(1, maxFileRows, ...[...columns.values()].map((column) => column.length));
    const chronological = ids.slice().sort(byBirth(sessions));
    return {
      id: ids.slice().sort().join(":"), nodes, edges: graphEdges, files, fileEdges,
      width: Math.max(options.minWidth, options.widthBase + maxLevel * options.columnStep),
      height: Math.max(options.minHeight, options.heightBase + maxRows * options.rowStep, maxFileBottom + options.y),
      first: sessions.get(chronological[0]!)!, last: sessions.get(chronological.at(-1)!)!,
    };
  }).sort((a, b) => b.nodes.length - a.nodes.length || b.edges.length - a.edges.length);
}
