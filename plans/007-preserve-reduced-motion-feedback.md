# 007 — 保留 reduced-motion 状态反馈

- **Status**: TODO
- **Commit**: d17ef79
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 2 files, about 25 lines

## Problem

The global reduced-motion rule sets all listed transition durations to zero. This removes useful opacity and color feedback along with movement. The DAG component is more selective, but still needs to align with one rule: drop movement, retain 120ms opacity/color transitions.

```css
/* src/App.vue:1102 — current */
@media (prefers-reduced-motion:reduce){html,body,.f,.rowbtn,.select-button svg,.menu,#tip,#toast{transition-duration:0ms}}
```

```css
/* src/LineageGraph.vue:114 — current before Plan 006 */
@media (prefers-reduced-motion:reduce){.dag-card{transition:opacity 120ms ease;transform:none}.dag-node{animation:none;transition:opacity 120ms ease,border-color 120ms ease}.dag-node:hover{transform:none}}
```

## Target

Reduced motion removes translate, scale, and rotate changes while preserving opacity and color feedback at exactly 120ms `ease`.

```css
/* target: src/App.vue */
@media (prefers-reduced-motion:reduce){
  html,body{transition:background-color 120ms ease,color 120ms ease}
  .view-switch button,.f,.rowbtn{transition:background-color 120ms ease,color 120ms ease}
  .view-switch button:active,.f:active:not(:disabled),.rowbtn:active{transform:none}
  .select-button svg{transition:none}
  .menu,#tip{transform:none;transition:opacity 120ms ease}
  #toast,#toast.show{transform:translateX(-50%);transition:opacity 120ms ease}
}
```

The toast must keep `translateX(-50%)` because it is positioning, not animated movement. Both hidden and shown states use the same transform.

```css
/* target: src/LineageGraph.vue after Plan 006 */
@media (prefers-reduced-motion:reduce){
  .dag-card{transform:none;transition:opacity 120ms ease}
  .dag-node{transition:border-color 120ms ease,background-color 120ms ease}
  .dag-node:hover,.dag-node:active{transform:none}
}
```

If Plan 005 retains an edge opacity/color transition, leave it active: it contains no position or scale movement.

## Repo conventions to follow

- Use the audit's exact reduced-motion duration: `120ms ease` for opacity/color.
- Keep native `prefers-reduced-motion: reduce`; do not add JavaScript media-query state.
- Preserve `--ease-out` for normal motion. Reduced opacity/color feedback deliberately uses `ease`.

## Steps

1. Replace the one-line global reduced-motion rule in `src/App.vue` with the exact target block.
2. Ensure `.menu` and `#tip` have identical hidden/shown transforms (`none`) under reduced motion while opacity still transitions for 120ms.
3. Ensure `#toast` and `#toast.show` both use `translateX(-50%)` under reduced motion so it remains centered and does not move vertically.
4. Disable transform feedback on view-switch buttons, `.f`, and `.rowbtn`; keep their background/color transitions at 120ms.
5. Disable the select chevron's rotation transition with `transition:none`; do not force its final rotation, because `aria-expanded` must still communicate state visually.
6. Update `src/LineageGraph.vue` to the exact target reduced-motion block. Plan 006 is a dependency; if its node keyframe still exists, execute Plan 006 first.
7. Add a CSS contract test in `tests/App.vitest.ts` only if the current Vitest/Vite setup exposes SFC styles reliably. Otherwise keep verification mechanical and visual; do not add a CSS parser solely for this rule.

## Boundaries

- Do NOT set a global `transition-duration:0ms` or `animation:none` blanket.
- Do NOT remove focus outlines, opacity feedback, color feedback, or state changes.
- Do NOT remove `translateX(-50%)` from the toast.
- Do NOT add JavaScript, a settings toggle, or new dependencies.
- Plan 006 must be complete first. If the post-Plan-006 DAG reduced-motion block differs for another reason, STOP and report drift instead of improvising.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0. Search with `rg -n "prefers-reduced-motion|transition-duration:0ms" src/App.vue src/LineageGraph.vue`; reduced-motion blocks must exist and `transition-duration:0ms` must not.
- **Feel check**: enable “Emulate CSS media feature prefers-reduced-motion: reduce” in DevTools.
  - Open/close a menu and transcript preview: they fade for 120ms without scaling.
  - Trigger the toast: it stays horizontally centered, fades for 120ms, and does not rise 8px.
  - Press tabs and row buttons: colors still respond, but buttons do not shrink.
  - Enter the DAG view: cards fade without translating; nodes do not enter independently.
  - At 10% playback, no transform track should change between hidden and shown reduced-motion states; opacity/color tracks should remain.
- **Done when**: reduced-motion users receive no decorative position/scale movement, while all useful opacity/color feedback remains visible and the toast stays centered.
