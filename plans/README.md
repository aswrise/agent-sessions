# Animation improvement plans

Plans are stamped against commit `d17ef79` and the current DAG working tree. Execute them in the order below; each executor must stop on unexpected code drift rather than improvising.

| # | Plan | Severity | Status | Depends on |
| --- | --- | --- | --- | --- |
| 001 | [统一 DAG 坐标空间](001-fix-dag-coordinate-space.md) | HIGH | TODO | — |
| 004 | [排除环境控制文件误关联](004-filter-ambient-artifacts.md) | HIGH | TODO | — |
| 002 | [展示关系链起止 Session](002-show-chain-time-range.md) | HIGH | TODO | 001 |
| 003 | [移除常驻边标签](003-remove-edge-label-clutter.md) | HIGH | TODO | 001 |
| 005 | [收敛关系高亮层级](005-soften-related-highlighting.md) | MEDIUM | TODO | 001, 003 |
| 006 | [删除逐节点入场动画](006-remove-node-stagger.md) | MEDIUM | TODO | 005 |
| 007 | [保留 reduced-motion 状态反馈](007-preserve-reduced-motion-feedback.md) | MEDIUM | TODO | 006 |

## Recommended execution order

1. `001` fixes the shared geometry bug before any visual judgment.
2. `004` removes false relationships so later feel checks use a trustworthy graph.
3. `002` and `003` can then run in either order; they fix chain comprehension and label clutter.
4. `005` tunes interaction emphasis on the cleaned graph.
5. `006` removes redundant node motion after opacity dimming is gone.
6. `007` finishes accessibility against the final motion surface.

After all seven plans, run the complete project verification once: `bun run test`, `bun run typecheck`, and `bun run build`.
