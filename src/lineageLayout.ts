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
};
export type LineageLayoutNode = {
  session: SessionView;
  x: number;
  y: number;
  column: number;
  incoming: number;
  outgoing: number;
};
export type LineageLayoutEdge = LineageEdge & { d: string; label: string; x: number; y: number };
export type LineageLayoutChain = {
  id: string;
  nodes: LineageLayoutNode[];
  edges: LineageLayoutEdge[];
  width: number;
  height: number;
  first: SessionView;
  last: SessionView;
};

export const LINEAGE_GRAPH_LAYOUT: LineageLayoutOptions = {
  nodeWidth: 220, nodeHeight: 64, columnStep: 280, rowStep: 96,
  x: 32, y: 36, minWidth: 560, minHeight: 150, widthBase: 316, heightBase: 72,
};
export const LINEAGE_PREVIEW_LAYOUT: LineageLayoutOptions = {
  nodeWidth: 150, nodeHeight: 46, columnStep: 230, rowStep: 68,
  x: 20, y: 20, minWidth: 190, minHeight: 86, widthBase: 190, heightBase: 40,
};

const byBirth = (sessions: Map<string, SessionView>) => (a: string, b: string): number =>
  sessions.get(a)!.birth - sessions.get(b)!.birth || a.localeCompare(b);

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
        label: edge.path.split(/[\\/]/).pop() ?? edge.path,
        x: (x1 + x2) / 2,
        y: Math.min(y1, y2) - 10,
      };
    });
    const maxLevel = Math.max(0, ...level.values());
    const maxRows = Math.max(1, ...[...columns.values()].map((column) => column.length));
    const chronological = ids.slice().sort(byBirth(sessions));
    return {
      id: ids.slice().sort().join(":"), nodes, edges: graphEdges,
      width: Math.max(options.minWidth, options.widthBase + maxLevel * options.columnStep),
      height: Math.max(options.minHeight, options.heightBase + maxRows * options.rowStep),
      first: sessions.get(chronological[0]!)!, last: sessions.get(chronological.at(-1)!)!,
    };
  }).sort((a, b) => b.nodes.length - a.nodes.length || b.edges.length - a.edges.length);
}
