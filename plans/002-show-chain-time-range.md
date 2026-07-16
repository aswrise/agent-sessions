# 002 — 展示关系链起止 Session

- **Status**: TODO
- **Commit**: d17ef79
- **Severity**: HIGH
- **Category**: Missed opportunities
- **Estimated scope**: 2 files, about 55 lines

## Problem

Every chain header currently contains only an ordinal and counts. A user cannot tell when the chain began or ended, nor identify its first and last session without scanning the entire DAG.

```ts
// src/LineageGraph.vue:7 — current
type Chain = { id: string; nodes: Node[]; edges: Edge[]; width: number; height: number };
```

```vue
<!-- src/LineageGraph.vue:84-85 — current -->
<section v-for="(chain, chainIndex) in chains" :key="chain.id" class="dag-card" :style="{ '--chain-delay': `${Math.min(chainIndex * 35, 140)}ms` }" :aria-label="`关系链 ${chainIndex + 1}`">
  <div class="dag-card-head"><span>链 {{ chainIndex + 1 }}</span><span>{{ chain.nodes.length }} Sessions · {{ chain.edges.length }} 关系</span></div>
```

## Target

Each chain header must show all of the following without opening a node:

- earliest session creation time and title;
- latest session creation time and title;
- elapsed time between them;
- existing session/edge counts.

Use local time and this exact timestamp shape: `2026-07-15 17:40`. Use these exact duration rules: under 60 minutes → `N 分钟`; under 48 hours → `N 小时 M 分钟`; otherwise → `N 天 M 小时`. A negative or zero duration displays `0 分钟`.

```ts
// target shape
type Chain = {
  id: string;
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
  first: SessionView;
  last: SessionView;
};
```

```text
链 1 · 4 Sessions · 4 关系
2026-07-15 17:40  codex接管pi的submit混乱设计
                     → 17 小时 03 分钟
2026-07-16 10:43  草，你怎么能改 submit 接口呢？
```

## Repo conventions to follow

- Session titles already use `session.name || session.first_msg || session.id` at `src/LineageGraph.vue:97-100`; put that expression in one local `sessionTitle(session)` helper and reuse it in the header and node.
- `src/App.vue:211-215` formats local dates with `new Date(epoch * 1000)` and zero-padded numeric fields. Follow that pattern, adding the year required by this header.
- Use existing colors (`--paper`, `--mist`, `--ash`) and tabular numerals; add no new theme tokens.

## Steps

1. Extend `Chain` in `src/LineageGraph.vue` with `first` and `last` `SessionView` fields.
2. Add local `sessionTitle`, `formatBirth`, and `formatDuration` helpers. `formatBirth` must emit `YYYY-MM-DD HH:mm`; `formatDuration` must follow the exact thresholds in Target.
3. Inside each group mapping, sort the group's sessions by `birth`, then by `id` for deterministic ties. Store the first and last items on the returned chain. Do not infer endpoints from graph indegree/outdegree; the requirement is chronological creation time.
4. Replace `.dag-card-head` markup with a compact chain summary containing the chain label/counts, earliest row, elapsed arrow, and latest row. Add `title` attributes containing full session titles while keeping visible titles single-line with ellipsis.
5. Add responsive CSS: at widths above 760px, place earliest and latest summaries in two columns separated by the duration; at `max-width:760px`, stack them vertically. Do not animate reflow.
6. Extend `tests/App.vitest.ts` with distinct names and births for the two lineage fixture sessions. Assert the header includes both formatted timestamps, both titles, and the elapsed duration.

## Boundaries

- Do NOT change the backend API or persist duplicate chain metadata; `LineageView.sessions` already contains `birth`, `name`, and `first_msg`.
- Do NOT define “first” or “last” from DAG topology.
- Do NOT add date libraries.
- Do NOT remove the existing session/relationship counts.
- If `SessionView.birth` is no longer epoch seconds, STOP and report drift instead of improvising.

## Verification

- **Mechanical**: run `bun run test:ui`, `bun run typecheck`, and `bun run build:ui`; all must exit 0.
- **Feel check**: inspect a short chain and the 58-session chain.
  - The header alone must answer “what started this, when, and where did it end?” within five seconds.
  - Long Chinese and English titles must truncate rather than push counts off-screen; hover exposes the full title.
  - Resize below 760px and confirm the time range stacks without horizontal page overflow.
  - In DevTools at 10% playback, confirm header text enters only with the existing card transition and does not animate its layout.
  - Toggle `prefers-reduced-motion`; all metadata remains visible and stable.
- **Done when**: every chain visibly shows the exact earliest/latest names and creation timestamps plus duration, with deterministic tests.
