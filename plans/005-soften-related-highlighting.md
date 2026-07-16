# 005 — 收敛关系高亮层级

- **Status**: DONE
- **Commit**: d17ef79
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens
- **Estimated scope**: 2 files, about 20 lines

## Problem

Hovering or focusing one node dims every unrelated node to `opacity: .32` and every unrelated edge to `.14`. On a dense chain this washes out almost the entire graph, especially in the light theme, and makes the user lose context instead of understanding the selected node's one-hop relationships.

```ts
// src/LineageGraph.vue:76-79 — current
function related(id: string): boolean {
  return !hovered.value || hovered.value === id || props.view.edges.some((edge) =>
    (edge.upstream_id === hovered.value && edge.downstream_id === id) || (edge.downstream_id === hovered.value && edge.upstream_id === id));
}
```

```vue
<!-- src/LineageGraph.vue:90,95 — current -->
<g ... class="dag-link" :class="{ active: hovered && (edge.upstream_id === hovered || edge.downstream_id === hovered), dim: hovered && edge.upstream_id !== hovered && edge.downstream_id !== hovered }">
<button ... class="dag-node" :class="{ focus: node.session.id === focusId, dim: !related(node.session.id) }">
```

```css
/* src/LineageGraph.vue:111 — current */
.dag-link.dim{opacity:.14}.dag-link.active{color:var(--lime);opacity:1}
.dag-node.dim{opacity:.32}
```

## Target

Never reduce node opacity. Preserve the whole DAG as context, add a quiet border emphasis to the hovered/focused node and its direct neighbors, and reduce unrelated edges only to `opacity: .34`.

```css
/* target */
.dag-link.dim{opacity:.34}
.dag-link.active{color:var(--lime);opacity:1}
.dag-node.connected{border-color:color-mix(in srgb,var(--lime) 34%,var(--graphite))}
```

`connected` means: the hovered/focused node itself or a node joined to it by one direct edge. With no active node, no node receives the class.

## Repo conventions to follow

- Use the existing `--lime`, `--graphite`, and `color-mix` patterns from `src/LineageGraph.vue:111` and `src/App.vue:921`.
- Keep the existing 140ms `ease` color/opacity transitions. Hover and focus are frequent interactions, so do not increase duration or add scale/bounce.
- Preserve keyboard parity: `focus` and `blur` must drive the same relationship state as mouse enter/leave.

## Steps

1. Rename `related(id)` to `connected(id)` and make it return `false` when `hovered.value` is empty; otherwise return `true` for the active node or a direct upstream/downstream neighbor.
2. Replace the node class binding `dim: !related(...)` with `connected: connected(...)`. Keep the existing `focus` class for the detail page's selected session.
3. Delete `.dag-node.dim{opacity:.32}` and add the exact `.dag-node.connected` border rule from Target.
4. Change `.dag-link.dim` from `.14` to `.34`; keep active edges at opacity `1` and `--lime`.
5. Extend the existing DAG UI test in `tests/App.vitest.ts`: mouseenter the first node, assert both nodes in the one-edge fixture have `connected`, no node has `dim`, and the edge has `active`; mouseleave and assert `connected`/`active` clear. Add one three-node fixture only if needed to assert an unrelated edge receives `dim`.

## Boundaries

- Do NOT hide or fade unrelated nodes.
- Do NOT expand highlighting beyond one hop.
- Do NOT add persistent selection state, an inspector, or click behavior.
- Do NOT change the focused-session `.dag-node.focus` treatment.
- Do NOT add new dependencies.
- If hover/focus is no longer represented by the shared `hovered` ref, STOP and report drift instead of adding parallel state.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0.
- **Feel check**: hover and keyboard-focus nodes in a dense chain in both themes.
  - The entire graph must remain readable; no node text becomes translucent.
  - The active node and one-hop neighbors should be findable without appearing like a new selection state.
  - Moving rapidly between nodes must retarget smoothly without flashing or restarting a keyframe.
  - In DevTools at 10% playback, edge opacity/color should interpolate for 140ms and node layout must not move.
  - Toggle `prefers-reduced-motion`; color/opacity feedback should remain because it contains no movement.
- **Done when**: node context never disappears, direct relationships are clear on hover and keyboard focus, and unrelated edges remain faint but visible.
