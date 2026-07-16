# 001 — 统一 DAG 坐标空间

- **Status**: DONE
- **Commit**: d17ef79
- **Severity**: HIGH
- **Category**: Physicality & origin
- **Estimated scope**: 2 files, about 10 lines

## Problem

`src/LineageGraph.vue` gives the canvas an inline pixel width, but `min-width: 100%` can enlarge the actual element when the card is wider. The SVG then stretches its fixed `viewBox` to that enlarged width while the absolutely positioned HTML nodes keep their original pixel coordinates. Edges and nodes visibly separate, as in chains 5 and 6.

```vue
<!-- src/LineageGraph.vue:87-88 — current -->
<div class="dag-canvas" :style="{ width: `${chain.width}px`, height: `${chain.height}px` }">
  <svg :viewBox="`0 0 ${chain.width} ${chain.height}`" aria-hidden="true">
```

```css
/* src/LineageGraph.vue:111 — current */
.dag-scroll{overflow:auto}.dag-canvas{position:relative;min-width:100%}.dag-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
```

## Target

Keep one intrinsic pixel coordinate space for SVG paths and HTML nodes. The scroll viewport may be wider than a small graph, but it must not resize the graph canvas.

```css
/* target */
.dag-scroll{overflow:auto}
.dag-canvas{position:relative}
.dag-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
```

The existing inline `width`/`height`, SVG `viewBox`, node `left`/`top`, and edge path coordinates remain unchanged.

## Repo conventions to follow

- `src/LineageGraph.vue:61-72` already computes every node, edge, width, and height in the same pixel coordinate system. Preserve that single source of geometry.
- `src/LineageGraph.vue:109` uses the existing `--ease-out` token for visual transitions; this plan does not add motion or tokens.

## Steps

1. In `src/LineageGraph.vue`, remove only `min-width:100%` from `.dag-canvas`.
2. In `tests/App.vitest.ts`, extend the existing cached-DAG test at lines 196-213 to assert that the first `.dag-canvas` has `width: 596px`, its SVG has `viewBox="0 0 596 150"`, and the second node's inline `left` is `312px`. These values come from the two-node, one-edge fixture and prove the three layers share the computed coordinate system.
3. Do not add a resize observer, zoom library, canvas transform, or force simulation.

## Boundaries

- Do NOT change the DAG level/row layout algorithm at `src/LineageGraph.vue:34-73`.
- Do NOT scale the SVG independently from the HTML nodes.
- Do NOT add new dependencies.
- If the inline canvas size or `viewBox` markup no longer matches the excerpt, STOP and report drift instead of improvising.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0.
- **Feel check**: open the global relationship view at a viewport wider than a small chain and confirm every arrow terminates at a node edge. Narrow the viewport until horizontal scrolling appears and confirm nodes and arrows move together.
  - Check both the 4-session example and a wide multi-column chain.
  - In DevTools, inspect `.dag-canvas`: its rendered width must equal its inline pixel width rather than the card width.
  - At 10% animation playback, confirm there is no apparent edge drift while the card enters.
  - Toggle `prefers-reduced-motion`; geometry must remain identical.
- **Done when**: edge endpoints remain attached to nodes at wide and narrow viewport widths, and the coordinate assertions pass.
