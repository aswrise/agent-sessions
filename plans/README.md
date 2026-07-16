# Session lineage implementation plans

Plans `001`-`007` are stamped against commit `d17ef79` and the current DAG working tree. Execute the full set in the order below; each executor must stop on unexpected code drift rather than improvising.

| # | Plan | Severity | Status | Depends on |
| --- | --- | --- | --- | --- |
| 001 | [统一 DAG 坐标空间](001-fix-dag-coordinate-space.md) | HIGH | DONE | — |
| 004 | [排除环境控制文件误关联](004-filter-ambient-artifacts.md) + [Codex Goal 漏链](../todos/solved/2026-07-16-session-lineage-followups_done-2026-07-16.md#todo-1codex-goal-漏链) | HIGH | DONE | 同一 extraction batch |
| 002 | [展示关系链起止 Session](002-show-chain-time-range.md) | HIGH | DONE | 001 |
| 003 | [移除常驻边标签](003-remove-edge-label-clutter.md) | HIGH | SUPERSEDED by UI | 001 |
| 005 | [收敛关系高亮层级](005-soften-related-highlighting.md) | MEDIUM | DONE | 001, 003 |
| 006 | [删除逐节点入场动画](006-remove-node-stagger.md) | MEDIUM | DONE | 005 |
| 007 | [保留 reduced-motion 状态反馈](007-preserve-reduced-motion-feedback.md) | MEDIUM | DONE | 006 |
| UI | [首页关系链徽标与整链悬浮预览](2026-07-16-lineage-entry-ui.md) | HIGH | DONE | 001, 002, 003, 005, 006, 007 |

## Recommended execution order

1. `001` fixes the shared geometry bug before any visual judgment.
2. Execute `004` and TODO 1 together, moving `INDEX_VERSION` from `2` to `3` once; this removes false relationships and restores Codex Goal consumers with one cache rebuild.
3. `002` adds chain context; `003` is superseded because the higher-priority entry UI requires visible artifact filenames.
4. `005` tunes interaction emphasis on the cleaned graph.
5. `006` removes redundant node motion after opacity dimming is gone.
6. `007` finishes accessibility against the final motion surface.
7. The lineage entry UI runs last because it extracts `LineageGraph` layout into a shared module; doing it earlier would invalidate the component-local assumptions in `001`-`007`.

After all listed plans, run the complete project verification once: `bun run test`, `bun run typecheck`, and `bun run build`.
