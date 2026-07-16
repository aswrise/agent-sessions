# 003 — 移除常驻边标签

- **Status**: TODO
- **Commit**: d17ef79
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, about 15 lines deleted

## Problem

Every relationship permanently paints its artifact basename over the graph. Repeated names such as `AGENTS.md`, `CLAUDE.md`, and long report names overlap nodes, arrows, and one another, making dense chains illegible.

```ts
// src/LineageGraph.vue:6 — current
type Edge = LineageEdge & { d: string; label: string; x: number; y: number };
```

```ts
// src/LineageGraph.vue:67-69 — current
const x1 = from.x + 220, y1 = from.y + 32, x2 = to.x, y2 = to.y + 32, bend = Math.max(40, (x2 - x1) / 2);
return { ...edge, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
  label: edge.path.split(/[\\/]/).pop() ?? edge.path, x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 7 };
```

```vue
<!-- src/LineageGraph.vue:90-92 — current -->
<g v-for="edge in chain.edges" :key="`${edge.upstream_id}:${edge.downstream_id}:${edge.path}`" class="dag-link" ...>
  <path :d="edge.d" :marker-end="`url(#dag-arrow-${chainIndex})`"><title>{{ edge.path }}</title></path>
  <text :x="edge.x" :y="edge.y" text-anchor="middle">{{ edge.label }}</text>
</g>
```

## Target

Render only the curve and arrow in the steady state. Preserve the full absolute path in the existing native SVG `<title>` so pointer users can inspect a specific edge without paying the permanent visual cost.

```ts
// target
type Edge = LineageEdge & { d: string };
```

```vue
<!-- target -->
<path :d="edge.d" :marker-end="`url(#dag-arrow-${chainIndex})`">
  <title>{{ edge.path }}</title>
</path>
```

## Repo conventions to follow

- Preserve the existing exact-match edge path from `LineageEdge.path`; do not shorten or normalize it in the UI.
- Keep the existing `--lime` active edge treatment and `var(--smoke)` default color.
- The app favors native platform behavior; the SVG `<title>` is sufficient for this plan and avoids adding a tooltip system.

## Steps

1. In `src/LineageGraph.vue`, reduce `Edge` to `LineageEdge & { d: string }`.
2. Remove `label`, `x`, and `y` from the positioned-edge return value.
3. Remove the edge `<text>` element and its `.dag-link text` CSS rule. Keep `<title>{{ edge.path }}</title>` inside the path.
4. Add `pointer-events:stroke` to `.dag-link path` so the native title is available across the stroked curve.
5. In `tests/App.vitest.ts`, assert the rendered DAG has no `.dag-link text` and its path `<title>` contains `/tmp/handoff.md`.

## Boundaries

- Do NOT remove artifact paths from `LineageEdge` or the backend index.
- Do NOT add custom tooltips, inspectors, popovers, or hover animation in this plan.
- Do NOT change edge routing.
- Do NOT add new dependencies.
- If edge path data is no longer present in `LineageView`, STOP and report drift instead of improvising.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0.
- **Feel check**: open the 58-session chain and compare its steady state with the supplied screenshot.
  - No filename may sit on top of a node or curve.
  - Hover one isolated edge and confirm the browser exposes its full path title.
  - At 10% animation playback, no text should appear/disappear separately from the graph.
  - Toggle `prefers-reduced-motion`; the graph remains visually identical.
- **Done when**: the graph contains zero persistent SVG text labels while full paths remain inspectable on individual edges.
