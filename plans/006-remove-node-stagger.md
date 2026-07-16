# 006 — 删除逐节点入场动画

- **Status**: TODO
- **Commit**: d17ef79
- **Severity**: MEDIUM
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, about 15 lines deleted

## Problem

Every DAG node runs its own 220ms keyframe with a capped 25ms stagger. A 168-node global graph starts many decorative animations at once, while the parent card is already entering. The repeated motion adds noise, cannot retarget like a transition, and provides no spatial explanation.

```ts
// src/LineageGraph.vue:59-62 — current
let order = 0;
const nodes = [...columns.entries()].flatMap(([column, columnIds]) => columnIds.map((id, row) => ({
  session: sessions.get(id)!, x: 32 + column * 280, y: 36 + row * 96, order: order++,
  incoming: incoming.get(id) ?? 0, outgoing: outgoing.get(id) ?? 0,
})));
```

```vue
<!-- src/LineageGraph.vue:95-97 — current -->
<button ...
  :style="{ left: `${node.x}px`, top: `${node.y}px`, '--node-delay': `${Math.min(node.order * 25, 125)}ms` }"
  ...>
```

```css
/* src/LineageGraph.vue:111-112 — current */
.dag-node{...animation:dag-node-in 220ms var(--ease-out) both;animation-delay:var(--node-delay);transition:transform 140ms var(--ease-out),opacity 140ms ease,border-color 140ms ease,background-color 140ms ease}
@keyframes dag-node-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
```

## Target

Nodes render immediately with their card. Keep the existing occasional card entrance only:

```css
/* existing card motion to preserve */
.dag-card{
  opacity:1;
  transform:translateY(0);
  transition:opacity 220ms var(--ease-out),transform 220ms var(--ease-out);
  transition-delay:var(--chain-delay);
}
@starting-style{.dag-card{opacity:0;transform:translateY(8px)}}
```

The node keeps only interactive transitions:

```css
/* target node motion */
transition:transform 140ms var(--ease-out),border-color 140ms ease,background-color 140ms ease;
```

If Plan 005 has not run yet, keep the existing node opacity transition until Plan 005 removes node dimming; do not couple the two findings.

## Repo conventions to follow

- Preserve the strong `--ease-out: cubic-bezier(.23,1,.32,1)` token at `src/App.vue:896`.
- The dashboard is crisp; a single 220ms parent entrance is within the under-300ms UI budget.
- Keep button press feedback and hover movement gated by `(hover:hover) and (pointer:fine)`.

## Steps

1. Remove `order` from the `Node` type in `src/LineageGraph.vue`.
2. Remove the `order` counter and `order: order++` assignment from node positioning.
3. Remove `--node-delay` from the node inline style, leaving only `left` and `top`.
4. Remove `animation:dag-node-in`, `animation-delay:var(--node-delay)`, and the entire `@keyframes dag-node-in` rule.
5. If Plan 005 is already complete, remove `opacity 140ms ease` from the node transition because node opacity no longer changes. Otherwise leave it for Plan 005.
6. Remove `animation:none` from the component's reduced-motion node rule because no node animation remains; preserve the rest for Plan 007.
7. Extend `tests/App.vitest.ts` to assert DAG nodes have no `--node-delay` inline property. Do not test CSS animation timing in a DOM simulator.

## Boundaries

- Do NOT remove or change the parent `.dag-card` entrance or its capped chain delay.
- Do NOT add a replacement node transition, spring, fade, scale, or stagger.
- Do NOT change node layout, hover, focus, or click behavior.
- Do NOT add new dependencies.
- Expected dependency drift: if Plan 005 already removed node opacity dimming, follow the conditional steps above. For any other excerpt mismatch, STOP and report drift.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0. Search with `rg -n "dag-node-in|node-delay|order:" src/LineageGraph.vue` and expect no matches related to DAG node entrance.
- **Feel check**: enter the global relationship view with a large cached graph.
  - Cards may rise/fade once over 220ms; all nodes inside each card must appear together.
  - No wave, cascade, or delayed node should remain after the card is interactive.
  - Rapidly switch views and confirm no node keyframe restarts independently.
  - In DevTools at 10% playback, only card-level entrance tracks should appear.
  - Toggle `prefers-reduced-motion`; cards should keep opacity-only feedback after Plan 007, and nodes should remain immediate.
- **Done when**: no per-node entrance keyframe or delay exists and the graph has only one purposeful card-level entrance.
