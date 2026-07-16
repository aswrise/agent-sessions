# 004 — 排除环境控制文件误关联

- **Status**: TODO
- **Commit**: d17ef79
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, about 30 lines

## Problem

The lineage extractor accepts every absolute `.md` or `.html` path. Environment control files are injected or reused across unrelated tasks, so exact basename matches create false graph edges and giant components. In the audited cache, exact basenames `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, and `SKILL.md` account for 44 of 170 edges; filtering them reduces the largest component from 58 to 37 sessions.

```ts
// src/lineage.ts:2-3,14,28 — current
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, normalize } from "node:path";
const INDEX_VERSION = 1;
const isArtifact = (path: string): boolean => /\.(?:md|html)$/i.test(path);
```

```ts
// src/lineage.ts:66-68 — current
function artifactPaths(text: string): string[] {
  const found = text.match(/(?:\/[^\s"'<>|]+?|[a-z]:\\[^\s"'<>|]+?)\.(?:md|html)(?::\d+(?::\d+)?)?/giu) ?? [];
  return [...new Set(found.map((value) => normalize(value.replace(/:\d+(?::\d+)?$/, ""))))];
}
```

## Target

Ignore only these exact case-insensitive basenames on both producer writes and consumer references:

```ts
const AMBIENT_ARTIFACTS = new Set(["agents.md", "claude.md", "memory.md", "skill.md"]);

const isArtifact = (path: string): boolean =>
  /\.(?:md|html)$/i.test(path) && !AMBIENT_ARTIFACTS.has(basename(path).toLowerCase());
```

Normal task artifacts such as `SPEC.md`, `plan.md`, `handoff.md`, reports, and all `.html` files remain eligible.

## Repo conventions to follow

- Keep the exact absolute-path matching rule; do not introduce fuzzy matching or content analysis.
- Reuse the shared `isArtifact` predicate for Codex, Claude, pi, and consumer reference extraction so the rule exists once.
- `src/lineage.ts:232-234` already includes `INDEX_VERSION` in scan signatures. Incrementing it is the existing cache invalidation mechanism.

## Steps

1. Import `basename` from `node:path` in `src/lineage.ts`.
2. Add the exact `AMBIENT_ARTIFACTS` set and update `isArtifact` to apply both extension and exact-basename checks.
3. Update `artifactPaths` so normalized matches are filtered through `isArtifact` before deduplication. This applies the same rule to consumer references; producer paths already call `isArtifact` at lines 136, 166, and 208.
4. Increment `INDEX_VERSION` from `1` to `2` so the next refresh rescans cached sessions and removes old ambient writes/references.
5. Add one focused test in `tests/lineage.test.ts`: a producer writes all four ignored basenames plus `handoff.md`; a consumer references all five in its first effective input. After refresh, assert exactly one edge remains and its path is `handoff.md`.
6. Also assert a mixed-case `AgEnTs.Md` is ignored, proving case-insensitive exact-basename behavior.

## Boundaries

- Do NOT ignore generic names such as `README.md`, `SPEC.md`, `plan.md`, or `handoff.md`.
- Do NOT ignore by directory name, path prefix, file content, or partial basename.
- Do NOT change the first-two-user-turn consumer rule, last-three-turn assistant-write producer rule, or nearest-prior-writer rule.
- Do NOT add configuration or a UI preference for the four fixed control filenames.
- Do NOT add new dependencies.
- If scan signatures no longer include `INDEX_VERSION`, STOP and report drift instead of improvising cache invalidation.

## Verification

- **Mechanical**: run `bun test tests/lineage.test.ts`, then `bun run typecheck`; all must exit 0. Trigger one real relationship refresh and confirm all sessions are rescanned because the signature version changed.
- **Feel check**: reload the global graph after refresh.
  - Search the rendered graph for edges sourced only from `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, or `SKILL.md`; none should remain.
  - Confirm a known task-specific `SPEC.md` or handoff chain still renders.
  - Compare component counts before/after; giant unrelated clusters should split without changing valid local chains.
  - Motion playback and `prefers-reduced-motion` do not apply to extraction, but confirm the reloaded graph does not animate continuously while the dataset changes.
- **Done when**: the four ambient basenames produce no writes, references, or edges after a versioned refresh, and normal task artifacts still link.
